import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastifyStatic from "@fastify/static";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db, dbPath, createBackup, getSetting, setPin, setSetting, verifyPin } from "./db.js";
import { prepareBrewWrite, preparePackagedWrite, prepareSpiritWrite } from "./catalog.js";
import { parseGeneratedRecipe, AiRecipeParseError, type GeneratedRecipe } from "./ai_recipe.js";
import { buildShelf, matchCocktail, mixologistShelfSummary } from "./cocktails.js";
import { buildOverview } from "./overview.js";
import { buildRestockList, createWanted, deleteWanted, listRestockGot, listWanted, parseRestockThresholds, restockSummary, setRestockGot } from "./restock.js";
import { clipKeeperName, DEFAULT_KEEPER_NAME, MAX_KEEPER_NAME } from "./shared-types.js";
import { listTonightPours, maybeInventoryPour } from "./pours.js";
import { fetchPublicHtml, metaContent, parseRecipeHtml, recipeTextForAi, RecipeImportError } from "./recipe_import.js";
import {
  enrichColaRecord,
  fetchColaQuota,
  labelProductWithLocalOllama,
  lookupProduct,
  rememberBeerFromHit,
  searchBottles,
  searchCatalogBeerSuggestions,
  type BottleSearchHit
} from "./lookup.js";
import { isImportKind, isMissReason, isReadyLookup, type ImportKind, type ImportRowStatus, type MissReason } from "./lookup-shared.js";
import { isColaConfigured } from "./cola_client.js";
import { readImportPayload } from "./import_batch.js";
import {
  applyLabelToImportRow,
  commitReadyImportRows,
  getImportQueueRow,
  importJobRunning,
  importQueueCounts,
  listImportQueue,
  MAX_IMPORT_ROWS,
  queueLookupResult,
  seedImportQueue,
  skipImportRow,
  startImportJob
} from "./import_queue.js";
import { buildAiFailoverChain, defaultAiBaseUrl, defaultAiModel, isRetryableAiStatus, resolveAiModel, type AiProviderConfig } from "./ai_providers.js";
import { pruneAttempts, recordFailure, retryAfterMs, type PinAttempts } from "./pin_guard.js";
import { BrewfatherError, isBrewfatherConfigured, syncBrews } from "./brewfather.js";
import { imagesDir, localizeImage, saveImageBuffer } from "./images.js";
import { parseVisionLabel, VISION_LABEL_PROMPT } from "./vision_label.js";
import { downscaleVisionImage } from "./vision_image.js";
import { createReview, deleteReview, deleteReviewsForItem, listReviews, REVIEW_TABLES } from "./reviews.js";
import { addNextRequest, deleteNextRequest, listNextBoards, voteNextRequest } from "./requests.js";
import { castVote, deleteVotesForItem, getVoteTally, summarizeVotes, voteTallies, VOTE_TABLES } from "./votes.js";
import {
  AI_MIXOLOGIST_PROVIDER_TIMEOUT_MS, AI_TIMEOUT_MS, MAX_GALLERY_BYTES,
  parseEnabledTabs, parseTabOrder, serializeEnabledTabs
} from "./speakeasy-shared.js";
import {
  deleteGalleryMedia, galleryFilePath, GALLERY_CONTENT_TYPES, GalleryError, listGallery, saveGalleryUpload
} from "./gallery.js";
import { createStaff, deleteStaff, listStaff, moveStaff, StaffError, updateStaff } from "./staff.js";
import {
  adjustPatronVisits, castDailyVote, createEvent, createEventSubscriber, createMerch, createMessage, createPatron,
  dailyVoteTallies, deleteDailyVotesForItem, deleteEvent, deleteEventSubscriber, deleteMerch, deleteMessage,
  deletePatron, listEvents, listEventSubscribers, listLeaderboard, listMerch, listMessages, listPatrons,
  markMessageRead, SpeakeasyError, unreadMessageCount, updateEvent, updateMerch, updatePatron
} from "./speakeasy.js";
import { DISCORD_ALERT_INTERVAL_MS, flushDiscordAlerts } from "./discord.js";

/**
 * Behind a reverse proxy every request otherwise arrives from the proxy's address, which
 * would collapse all visitors into one throttle bucket and let a stranger's guessing spree
 * slow the keeper down. Only enable where a proxy actually sets X-Forwarded-For, since
 * trusting that header when directly exposed lets a client invent its own address.
 */
const trustProxy = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY?.trim() ?? "");
const app = Fastify({ logger: true, bodyLimit: 15 * 1024 * 1024, trustProxy });
const secret = process.env.SESSION_SECRET ?? `${dbPath}:smokey-vault`;
const tables = new Set(["spirits", "taps", "brews", "packaged_beer", "wines"]);
const publicTables = new Set([...tables, "cocktails"]);
const tableFields: Record<string, string[]> = {
  spirits: ["name","brand","category","sub_category","abv","volume_ml","fill_level","purchase_date","opened_date","shelf_location","upc","notes","image_url","stock_count","tasting_notes","flavors","tags","base_ingredient","blocked_from_ordering"],
  taps: ["tap_number","keg_size_l","source_type","brewery_batch","style","abv","ibu","tapped_date","remaining_l","maker","notes","image_url","tasting_notes","flavors","tags","base_ingredient"],
  brews: ["batch_name","style","brew_date","target_og","target_fg","measured_og","measured_fg","calculated_abv","schedule","status","notes","maker","image_url","tasting_notes","flavors","tags","base_ingredient","hops","brewfather_id"],
  packaged_beer: ["brewery","name","style","count","pack_date","abv","upc","image_url","notes","tasting_notes","flavors","tags","base_ingredient","vessel"],
  wines: ["producer","name","varietal","vintage","type","style","region","sweetness","body","bottle_count","drink_by_date","pairings","notes","upc","image_url","tasting_notes","flavors","tags","base_ingredient","blocked_from_ordering"]
};

await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
await app.register(swagger, {
  openapi: {
    info: { title: "The Smokey Vault API", version: "1.0.0", description: "Self-hosted bar, cellar, brewery, and cocktail inventory." },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } }
  }
});
await app.register(swaggerUi, { routePrefix: "/api/docs" });

function token(exp = Date.now() + 15 * 60_000) {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

function isAdmin(header?: string) {
  const raw = header?.replace(/^Bearer /i, "");
  if (!raw) return false;
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now(); } catch { return false; }
}

function requireAdmin(request: { headers: { authorization?: string } }, reply: { code: (n: number) => { send: (v: unknown) => unknown } }) {
  if (!isAdmin(request.headers.authorization)) return reply.code(401).send({ error: "Admin session required" });
}

function keeperName() {
  return clipKeeperName(getSetting("keeperName") || DEFAULT_KEEPER_NAME);
}

function currentShelf() {
  const spirits = db.prepare("SELECT name,brand,category,sub_category,fill_level,stock_count,blocked_from_ordering FROM spirits").all() as Array<Record<string, unknown>>;
  const wines = db.prepare("SELECT name,producer,type,style,varietal,bottle_count,blocked_from_ordering FROM wines").all() as Array<Record<string, unknown>>;
  const packaged = db.prepare("SELECT name,brewery,style,count FROM packaged_beer").all() as Array<Record<string, unknown>>;
  const taps = db.prepare("SELECT brewery_batch,maker,style,keg_size_l,remaining_l FROM taps").all() as Array<Record<string, unknown>>;
  return buildShelf(spirits, wines, packaged, taps);
}

app.get("/api/health", { schema: { tags: ["System"], summary: "Health check" } }, async () => ({ ok: true, version: "1.0.0" }));

/** Settings a guest device is allowed to read without unlocking admin mode. */
const PUBLIC_SETTING_KEYS = [
  "enabled_tabs", "tab_order", "bar_location_text", "house_tip_blurb", "guest_bartender_enabled", "facebook_group_url",
  "tip_venmo", "tip_cashapp", "tip_paypal",
  "guest_bartender_name", "guest_bartender_bio", "guest_bartender_photo", "guest_bartender_applecash",
  "guest_bartender_venmo", "guest_bartender_cashapp", "guest_bartender_paypal"
] as const;

function publicSettings() {
  return Object.fromEntries(PUBLIC_SETTING_KEYS.map((key) => [key, getSetting(key) ?? ""]));
}

/**
 * The "default PIN" hint helps a first launch on a home network, but on a public host it is
 * an unauthenticated endpoint volunteering that the admin PIN was never changed. Opt in
 * explicitly rather than guessing from the request address, which a reverse proxy rewrites.
 */
const showPinHint = /^(1|true|yes)$/i.test(process.env.SHOW_PIN_HINT?.trim() ?? "");

app.get("/api/house", { schema: { tags: ["System"], summary: "Public house name, unlock hint, and guest-safe settings" } }, async () => {
  const ai = resolveAiConfig();
  return {
    keeperName: keeperName(),
    defaultPinHint: showPinHint && verifyPin(process.env.DEFAULT_PIN ?? "1234"),
    brewfatherConfigured: isBrewfatherConfigured(),
    colaConfigured: isColaConfigured(),
    aiConfigured: ai.provider === "ollama" || Boolean(ai.key),
    ...publicSettings(),
    enabledTabs: parseEnabledTabs(getSetting("enabled_tabs"))
  };
});

function samePin(pin: string, candidate?: string) {
  if (!candidate) return false;
  const a = Buffer.from(pin);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The stored PIN, plus optional env overrides. ADMIN_PIN and MASTER_PIN are the way back
 * in when the stored PIN is forgotten, since nothing can read it back out of the database.
 */
function pinAccepted(pin: string) {
  return verifyPin(pin) || samePin(pin, process.env.ADMIN_PIN) || samePin(pin, process.env.MASTER_PIN);
}

/** Failed unlock attempts per client address. In memory on purpose: a restart is a reset. */
const pinAttempts = new Map<string, PinAttempts>();

app.post<{ Body: { pin?: string } }>("/api/auth/unlock", {
  schema: { tags: ["Auth"], summary: "Unlock admin mode", body: { type: "object", required: ["pin"], properties: { pin: { type: "string" } } } }
}, async (request, reply) => {
  const now = Date.now();
  const who = request.ip || "unknown";
  const wait = retryAfterMs(pinAttempts.get(who), now);
  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000);
    app.log.warn({ ip: who, seconds, fails: pinAttempts.get(who)?.fails }, "Throttled a PIN attempt");
    return reply.code(429).header("retry-after", String(seconds)).send({
      error: `Too many attempts. Try again in ${seconds}s.`,
      retryAfterSeconds: seconds
    });
  }
  if (!request.body.pin || !pinAccepted(request.body.pin)) {
    const next = recordFailure(pinAttempts.get(who), now);
    pinAttempts.set(who, next);
    pruneAttempts(pinAttempts, now);
    app.log.warn({ ip: who, fails: next.fails }, "Rejected a PIN attempt");
    return reply.code(401).send({ error: "Incorrect PIN" });
  }
  pinAttempts.delete(who);
  return { token: token(), expiresIn: 900 };
});

app.post<{ Body: { currentPin?: string; newPin?: string } }>("/api/auth/pin", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const { currentPin, newPin } = request.body;
  if (!currentPin || !pinAccepted(currentPin)) return reply.code(403).send({ error: "Current PIN is incorrect" });
  if (!newPin || !/^\d{4,12}$/.test(newPin)) return reply.code(400).send({ error: "PIN must be 4–12 digits" });
  setPin(newPin);
  return { ok: true };
});

app.get<{ Params: { table: string } }>("/api/inventory/:table", async (request, reply) => {
  if (!publicTables.has(request.params.table)) return reply.code(404).send({ error: "Unknown module" });
  const table = request.params.table;
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${table === "taps" ? "tap_number ASC" : "id DESC"}`).all() as Array<Record<string, unknown>>;
  if (!VOTE_TABLES.has(table)) return rows;
  const tallies = voteTallies(table);
  return rows.map((row) => {
    const tally = tallies[Number(row.id)] ?? summarizeVotes(0, 0);
    return { ...row, vote_up: tally.up, vote_down: tally.down, vote_net: tally.net, vote_total: tally.total, vote_score: tally.score };
  });
});

app.post<{ Params: { table: string }; Body: Record<string, unknown> }>("/api/inventory/:table", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const table = request.params.table;
  if (!tables.has(table)) return reply.code(404).send({ error: "Unknown module" });
  const body = table === "brews"
    ? prepareBrewWrite({ ...request.body })
    : table === "packaged_beer"
      ? preparePackagedWrite({ ...request.body })
      : table === "spirits"
        ? prepareSpiritWrite({ ...request.body })
        : { ...request.body };
  if (typeof body.image_url === "string" && body.image_url && !String(body.image_url).startsWith("/api/media/images/")) {
    const { localizeImage } = await import("./images.js");
    body.image_url = await localizeImage(body.image_url) ?? body.image_url;
  }
  const values = tableFields[table].filter((field) => body[field] !== undefined);
  if (!values.length) return reply.code(400).send({ error: "No valid fields supplied" });
  const result = db.prepare(`INSERT INTO ${table} (${values.join(",")}) VALUES (${values.map(() => "?").join(",")})`)
    .run(...values.map((field) => body[field] as never));
  return reply.code(201).send(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(result.lastInsertRowid));
});

app.post<{ Body: unknown }>("/api/inventory/import-batch", {
  schema: { tags: ["Lookup"], summary: "Queue CSV/JSON UPCs for overnight list-only catalog lookup. Nothing is written until Import Review commit." }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const rows = readImportPayload(request.body);
  if (!rows.length) return reply.code(400).send({ error: "Send a CSV of UPCs, an array of items, or { items: [...] }" });
  if (rows.length > MAX_IMPORT_ROWS) return reply.code(400).send({ error: `Import up to ${MAX_IMPORT_ROWS} items at a time` });
  const seeded = seedImportQueue(rows);
  const started = startImportJob();
  return {
    queued: seeded.queued,
    skipped: seeded.skipped,
    started,
    running: importJobRunning() || started,
    counts: importQueueCounts()
  };
});

app.get<{ Querystring: { status?: string; kind?: string; reason?: string } }>("/api/inventory/import-queue", {
  schema: { tags: ["Lookup"], summary: "Import Review queue" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const status = request.query.status === "pending" || request.query.status === "ready"
    || request.query.status === "needs_review" || request.query.status === "skipped"
    ? request.query.status as ImportRowStatus
    : "all";
  const kind = request.query.kind && isImportKind(request.query.kind) ? request.query.kind : "all";
  const reason = request.query.reason && isMissReason(request.query.reason) ? request.query.reason as MissReason : "all";
  return {
    rows: listImportQueue({ status, kind, reason }),
    counts: importQueueCounts(),
    running: importJobRunning()
  };
});

app.post<{ Body: { ids?: number[] } }>("/api/inventory/import-queue/commit", {
  schema: { tags: ["Lookup"], summary: "Write Ready import rows to the vault" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const ids = Array.isArray(request.body?.ids)
    ? request.body.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
    : undefined;
  return commitReadyImportRows(ids?.length ? ids : undefined);
});

app.post<{ Params: { id: string } }>("/api/inventory/import-queue/:id/skip", {
  schema: { tags: ["Lookup"], summary: "Skip an import row; it stays in the queue" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const row = skipImportRow(Number(request.params.id));
  if (!row) return reply.code(404).send({ error: "Import row not found" });
  return row;
});

app.get<{ Params: { id: string } }>("/api/inventory/import-queue/:id", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const row = getImportQueueRow(Number(request.params.id));
  if (!row) return reply.code(404).send({ error: "Import row not found" });
  return row;
});

app.post<{ Body: { force?: boolean } }>("/api/brews/sync", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  if (!isBrewfatherConfigured()) return reply.code(400).send({ error: "Brewfather is not configured" });
  try {
    return await syncBrews({ force: Boolean(request.body?.force) });
  } catch (error) {
    const status = error instanceof BrewfatherError ? error.statusCode : 502;
    return reply.code(status).send({ error: error instanceof Error ? error.message : "Could not sync Brewfather" });
  }
});

app.put<{ Params: { table: string; id: string }; Body: Record<string, unknown> }>("/api/inventory/:table/:id", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const table = request.params.table;
  if (!tables.has(table)) return reply.code(404).send({ error: "Unknown module" });
  const existing = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(request.params.id) as Record<string, unknown> | undefined;
  if (!existing) return reply.code(404).send({ error: "Item not found" });
  const body = table === "brews"
    ? prepareBrewWrite({ ...request.body }, existing)
    : table === "packaged_beer"
      ? preparePackagedWrite({ ...request.body })
      : table === "spirits"
        ? prepareSpiritWrite({ ...request.body })
        : { ...request.body };
  if (typeof body.image_url === "string" && body.image_url && !String(body.image_url).startsWith("/api/media/images/")) {
    const { localizeImage } = await import("./images.js");
    body.image_url = await localizeImage(body.image_url) ?? body.image_url;
  }
  const values = tableFields[table].filter((field) => body[field] !== undefined);
  if (!values.length) return reply.code(400).send({ error: "No valid fields supplied" });
  db.prepare(`UPDATE ${table} SET ${values.map((f) => `${f}=?`).join(",")},updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(...values.map((field) => body[field] as never), request.params.id);
  const updated = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(request.params.id) as Record<string, unknown>;
  maybeInventoryPour(table, existing, updated);
  return updated;
});

app.delete<{ Params: { table: string; id: string } }>("/api/inventory/:table/:id", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  if (!tables.has(request.params.table)) return reply.code(404).send({ error: "Unknown module" });
  deleteReviewsForItem(request.params.table, Number(request.params.id));
  deleteVotesForItem(request.params.table, Number(request.params.id));
  deleteDailyVotesForItem(request.params.table, Number(request.params.id));
  db.prepare(`DELETE FROM ${request.params.table} WHERE id=?`).run(request.params.id);
  return reply.code(204).send();
});

app.get<{ Params: { table: string; id: string } }>("/api/inventory/:table/:id/reviews", async (request, reply) => {
  if (!REVIEW_TABLES.has(request.params.table)) return reply.code(404).send({ error: "Unknown module" });
  return listReviews(request.params.table, Number(request.params.id));
});

app.post<{ Params: { table: string; id: string }; Body: { author?: string; body?: string } }>("/api/inventory/:table/:id/reviews", {
  schema: { tags: ["Reviews"], summary: "Post a guest review" }
}, async (request, reply) => {
  if (!REVIEW_TABLES.has(request.params.table)) return reply.code(404).send({ error: "Unknown module" });
  try {
    const review = createReview(request.params.table, Number(request.params.id), request.body.author ?? "", request.body.body ?? "");
    return reply.code(201).send(review);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save review";
    const code = /not found/i.test(message) ? 404 : 400;
    return reply.code(code).send({ error: message });
  }
});

app.delete<{ Params: { id: string } }>("/api/reviews/:id", {
  schema: { tags: ["Reviews"], summary: "Delete a guest review" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  if (!deleteReview(Number(request.params.id))) return reply.code(404).send({ error: "Review not found" });
  return reply.code(204).send();
});

app.get<{ Params: { table: string; id: string }; Querystring: { voter?: string } }>("/api/inventory/:table/:id/votes", {
  schema: { tags: ["Votes"], summary: "Vote tally for a bottle" }
}, async (request, reply) => {
  if (!VOTE_TABLES.has(request.params.table)) return reply.code(404).send({ error: "Unknown module" });
  return getVoteTally(request.params.table, Number(request.params.id), request.query.voter);
});

app.post<{ Params: { table: string; id: string }; Body: { voter?: string; value?: number } }>("/api/inventory/:table/:id/votes", {
  schema: { tags: ["Votes"], summary: "Cast or clear a guest vote" }
}, async (request, reply) => {
  if (!VOTE_TABLES.has(request.params.table)) return reply.code(404).send({ error: "Unknown module" });
  try {
    return castVote(request.params.table, Number(request.params.id), request.body.voter ?? "", Number(request.body.value));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save vote";
    const code = /not found/i.test(message) ? 404 : 400;
    return reply.code(code).send({ error: message });
  }
});

app.get<{ Querystring: { voter?: string } }>("/api/next", {
  schema: { tags: ["Votes"], summary: "Guest boards for the next bottle, keg, and brew" }
}, async (request) => {
  try {
    return listNextBoards(request.query.voter);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load the board";
    return { shelf: [], keg: [], brew: [], error: message };
  }
});

app.post<{ Body: { voter?: string; board?: string; kind?: string; name?: string; maker?: string; note?: string; image_url?: string } }>("/api/next", {
  schema: { tags: ["Votes"], summary: "Add a What's next card" }
}, async (request, reply) => {
  const board = request.body?.board;
  if ((board === "keg" || board === "brew") && requireAdmin(request, reply)) return;
  try {
    return addNextRequest(request.body ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not add that";
    return reply.code(400).send({ error: message });
  }
});

app.post<{ Params: { id: string }; Body: { voter?: string; value?: number } }>("/api/next/:id/vote", {
  schema: { tags: ["Votes"], summary: "Cast or clear a vote on What's next" }
}, async (request, reply) => {
  try {
    return voteNextRequest(Number(request.params.id), request.body?.voter ?? "", request.body?.value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save vote";
    const code = /not found/i.test(message) ? 404 : 400;
    return reply.code(code).send({ error: message });
  }
});

app.delete<{ Params: { id: string } }>("/api/next/:id", {
  schema: { tags: ["Votes"], summary: "Remove a What's next card" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  if (!deleteNextRequest(Number(request.params.id))) return reply.code(404).send({ error: "Request not found" });
  return reply.code(204).send();
});

app.get("/api/cocktails/match", async () => {
  const shelf = currentShelf();
  const cocktails = db.prepare("SELECT * FROM cocktails ORDER BY name").all() as Array<Record<string, unknown>>;
  return cocktails.map((cocktail) => {
    const matched = matchCocktail(cocktail, shelf);
    return { ...cocktail, ...matched };
  });
});

app.get("/api/overview", { schema: { tags: ["System"], summary: "House snapshot for the Overview page" } }, async () => {
  const spirits = db.prepare("SELECT * FROM spirits").all() as Array<Record<string, unknown>>;
  const taps = db.prepare("SELECT * FROM taps ORDER BY tap_number ASC").all() as Array<Record<string, unknown>>;
  const brews = db.prepare("SELECT * FROM brews").all() as Array<Record<string, unknown>>;
  const packaged = db.prepare("SELECT * FROM packaged_beer").all() as Array<Record<string, unknown>>;
  const wines = db.prepare("SELECT * FROM wines").all() as Array<Record<string, unknown>>;
  const shelf = buildShelf(spirits, wines, packaged, taps);
  const cocktails = (db.prepare("SELECT * FROM cocktails ORDER BY name").all() as Array<Record<string, unknown>>)
    .map((cocktail) => ({ ...cocktail, ...matchCocktail(cocktail, shelf) }));
  return buildOverview({
    spirits,
    taps,
    brews,
    packaged,
    wines,
    cocktails,
    pours: listTonightPours(),
    keeperName: keeperName()
  });
});

function restockThresholds() {
  return parseRestockThresholds({
    restockPackagedBelow: getSetting("restockPackagedBelow"),
    restockSpiritFill: getSetting("restockSpiritFill"),
    restockWineBelow: getSetting("restockWineBelow")
  });
}

function restockPayload() {
  const spirits = db.prepare("SELECT * FROM spirits").all() as Array<Record<string, unknown>>;
  const packaged = db.prepare("SELECT * FROM packaged_beer").all() as Array<Record<string, unknown>>;
  const wines = db.prepare("SELECT * FROM wines").all() as Array<Record<string, unknown>>;
  const taps = db.prepare("SELECT * FROM taps").all() as Array<Record<string, unknown>>;
  const shelf = buildShelf(spirits, wines, packaged, taps);
  const cocktails = (db.prepare("SELECT * FROM cocktails ORDER BY name").all() as Array<Record<string, unknown>>)
    .map((cocktail) => ({ ...cocktail, ...matchCocktail(cocktail, shelf) }));
  const thresholds = restockThresholds();
  const items = buildRestockList({
    spirits,
    wines,
    packaged,
    cocktails,
    wanted: listWanted(),
    got: listRestockGot(),
    thresholds
  });
  return { items, thresholds, ...restockSummary(items) };
}

app.get("/api/restock", { schema: { tags: ["System"], summary: "Bottles and mixers to pick up" } }, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  return restockPayload();
});

app.post<{ Body: { key?: string; got?: boolean } }>("/api/restock/check", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    setRestockGot(request.body.key ?? "", request.body.got !== false);
    return restockPayload();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update the restock list";
    return reply.code(400).send({ error: message });
  }
});

app.post<{ Body: { name?: string; note?: string; label?: string } }>("/api/restock/wanted", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    createWanted(request.body ?? {});
    return restockPayload();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not add that to the wanted list";
    return reply.code(400).send({ error: message });
  }
});

app.delete<{ Params: { id: string } }>("/api/restock/wanted/:id", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  if (!deleteWanted(Number(request.params.id))) return reply.code(404).send({ error: "Wanted item not found" });
  return restockPayload();
});

async function handleBarcodeLookup(
  request: { params: { code: string }; query: { enrich?: string; refresh?: string; force?: string; kind?: string } },
  reply: { code: (n: number) => { send: (v: unknown) => unknown } }
) {
  const forceRefresh = request.query.refresh === "true" || request.query.refresh === "1"
    || request.query.force === "true" || request.query.force === "1";
  const kind: ImportKind | undefined = request.query.kind && isImportKind(request.query.kind)
    ? request.query.kind
    : undefined;
  try {
    const result = await lookupProduct(request.params.code, { forceRefresh, kind, mode: "live" });
    if (!isReadyLookup(result)) queueLookupResult(result);
    return result;
  } catch (error) {
    app.log.error({ error }, "Barcode lookup failed");
    return reply.code(502).send({ error: "Barcode lookup failed" });
  }
}

app.get<{ Querystring: { code?: string; upc?: string; enrich?: string; refresh?: string; force?: string; kind?: string } }>(
  "/api/lookup/barcode",
  { schema: { tags: ["Lookup"], summary: "Barcode lookup (vault → cache → FWGS → COLA list → Open Food Facts)" } },
  async (request, reply) => {
    const code = String(request.query.code ?? request.query.upc ?? "").trim();
    if (!code) return reply.code(400).send({ error: "Pass ?code=<barcode>" });
    return handleBarcodeLookup({ params: { code }, query: request.query }, reply);
  }
);

app.get<{ Params: { code: string }; Querystring: { enrich?: string; refresh?: string; force?: string; kind?: string } }>(
  "/api/scan/upc/:code",
  { schema: { tags: ["Lookup"], summary: "Barcode lookup pipeline" } },
  handleBarcodeLookup
);

app.get<{ Params: { code: string }; Querystring: { enrich?: string; refresh?: string; force?: string; kind?: string } }>(
  "/api/lookup/:code",
  { schema: { tags: ["Lookup"], summary: "Barcode lookup pipeline" } },
  handleBarcodeLookup
);

app.post<{ Body: { image?: string; imageBase64?: string; base64Image?: string } }>("/api/scan/label", {
  schema: { tags: ["Lookup"], summary: "Read a base64 product label image with local Ollama vision" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const image = String(request.body?.image ?? request.body?.imageBase64 ?? request.body?.base64Image ?? "").trim();
  if (!image) return reply.code(400).send({ error: "Base64 image required" });
  try {
    const product = await labelProductWithLocalOllama(image);
    const suggestions = product.product_type === "beer"
      ? await searchCatalogBeerSuggestions(`${product.brand} ${product.name}`.trim(), 5)
      : [];
    return {
      source: "label" as const,
      upc: product.upc || undefined,
      product,
      suggestions
    };
  } catch (error) {
    app.log.error({ error }, "Local Ollama vision-label request failed");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "Could not read that label" });
  }
});

app.get<{ Querystring: { q?: string; table?: string } }>("/api/search/bottles", {
  schema: { tags: ["Lookup"], summary: "Search vault, beer cache, Catalog.beer, and COLA by bottle name" }
}, async (request, reply) => {
  const q = request.query.q?.trim() ?? "";
  if (q.length < 2) return { results: [] };
  try {
    return await searchBottles(q, { table: request.query.table });
  } catch (error) {
    app.log.error({ error }, "Bottle search failed");
    return reply.code(502).send({ error: "Bottle search failed" });
  }
});

app.post<{ Body: { upc?: string; hit?: BottleSearchHit } }>("/api/beer/remember", {
  schema: { tags: ["Lookup"], summary: "Remember a beer UPC mapping for faster future scans" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const upc = String(request.body?.upc ?? "").trim();
  const hit = request.body?.hit;
  if (!upc || !hit?.product) return reply.code(400).send({ error: "UPC and hit required" });
  await rememberBeerFromHit(upc, hit);
  return { ok: true };
});

app.get<{ Params: { ttbId: string }; Querystring: { upc?: string } }>("/api/cola/enrich/:ttbId", {
  schema: { tags: ["Lookup"], summary: "Fetch COLA detail and localize label image" }
}, async (request, reply) => {
  if (!isColaConfigured()) return reply.code(400).send({ error: "COLA_API_KEY is not configured" });
  try {
    return await enrichColaRecord(request.params.ttbId, request.query.upc ?? "");
  } catch (error) {
    app.log.error({ error }, "COLA enrich failed");
    return reply.code(502).send({ error: "Could not enrich COLA record" });
  }
});

app.get("/api/cola/quota", {
  schema: { tags: ["Lookup"], summary: "COLA Cloud API quota remaining" }
}, async (_request, reply) => {
  if (!isColaConfigured()) {
    return { configured: false, message: "Set COLA_API_KEY to enable COLA Cloud lookups." };
  }
  try {
    return await fetchColaQuota();
  } catch (error) {
    app.log.warn({ error }, "COLA quota check failed");
    return reply.code(502).send({ error: "Unable to read COLA Cloud quota", configured: true });
  }
});

const imageTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif"
};

app.post("/api/media/upload", {
  schema: { tags: ["Lookup"], summary: "Upload a bottle photo for inventory" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "Image required" });
    const buffer = await file.toBuffer();
    const url = saveImageBuffer(buffer, file.mimetype, file.filename);
    return { url };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save image";
    const code = /too large|filesize|JPEG|PNG|required|limit/i.test(message) ? 400 : 500;
    return reply.code(code).send({ error: message });
  }
});

app.get<{ Params: { file: string } }>("/api/media/images/:file", {
  schema: { tags: ["Lookup"], summary: "Serve a locally cached bottle label image" }
}, async (request, reply) => {
  const file = basename(request.params.file);
  if (!file || file !== request.params.file || file.includes("..")) {
    return reply.code(400).send({ error: "Invalid image path" });
  }
  const path = join(imagesDir, file);
  if (!existsSync(path)) return reply.code(404).send({ error: "Image not found" });
  return reply.type(imageTypes[extname(file).toLowerCase()] ?? "application/octet-stream").send(createReadStream(path));
});

class AiRequestError extends Error {
  constructor(message: string, readonly statusCode = 502, readonly retryable = false) {
    super(message);
  }
}

function resolveAiConfig() {
  const providerFromKey = process.env.GEMINI_API_KEY ? "gemini" : process.env.OPENROUTER_API_KEY ? "openrouter" : process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENAI_API_KEY ? "openai" : "";
  const environmentProvider = process.env.AI_PROVIDER?.trim().toLowerCase() || providerFromKey || (process.env.AI_API_KEY ? "openai" : "");
  const provider = environmentProvider || getSetting("aiProvider")?.toLowerCase() || "ollama";
  const environmentKey = process.env.AI_API_KEY ||
    (provider === "openrouter" ? process.env.OPENROUTER_API_KEY : provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : provider === "gemini" ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY) || "";
  const key = environmentKey || getSetting("aiApiKey") || "";
  const defaultBaseUrl = defaultAiBaseUrl(provider);
  const environmentBaseUrl = process.env.AI_BASE_URL?.trim() || "";
  // A stored aiBaseUrl is deliberately ignored: nothing writes it, no screen edits it, and
  // the settings API strips it, so a stale row could only misroute a working provider.
  // AI_BASE_URL is the supported override for a proxy or self-hosted gateway.
  const baseUrl = (environmentBaseUrl || defaultBaseUrl).replace(/\/$/, "");
  const defaultModel = defaultAiModel(provider);
  const environmentModel = process.env.AI_MODEL?.trim() || "";
  const model = resolveAiModel(provider, environmentModel || getSetting("aiModel") || defaultModel);
  const fromEnvironment = Boolean(environmentProvider || environmentKey || environmentBaseUrl || environmentModel || process.env.OLLAMA_HOST);
  return { provider, key, baseUrl, model, fromEnvironment, keyFromEnvironment: Boolean(environmentKey) };
}

function maskSecret(value: string) {
  if (!value) return "not set";
  if (value.length <= 8) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/** Gemini carries its key in the query string, so only the endpoint is ever logged. */
function endpointForLog(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "invalid url";
  }
}

/** Network faults and timeouts arrive as thrown errors, not statuses; both are retryable. */
async function aiFetch(provider: string, url: string, init: RequestInit, timeoutMs = AI_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    const cause = error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause
      ? String((error.cause as { code: unknown }).code)
      : "";
    const endpoint = endpointForLog(url);
    app.log.error(
      { provider, endpoint, cause, reason: error instanceof Error ? error.message : String(error) },
      timedOut ? "AI provider timed out" : "AI provider could not be reached"
    );
    throw new AiRequestError(
      timedOut
        ? `${provider} timed out after ${timeoutMs / 1000}s.`
        : `${provider} could not be reached at ${endpoint}${cause ? ` (${cause})` : ""}.`,
      timedOut ? 504 : 503,
      true
    );
  }
}

async function requestAi({ provider, key, baseUrl, model }: AiProviderConfig, prompt: string, image?: string, timeoutMs = AI_TIMEOUT_MS): Promise<string> {
  if (provider === "anthropic") {
    const content: unknown[] = [{ type: "text", text: prompt }];
    if (image) content.unshift({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
    const response = await aiFetch(provider, `${baseUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: "user", content }] }) }, timeoutMs);
    const data = await response.json() as { content?: Array<{ text: string }>; error?: { message?: string } };
    if (!response.ok) {
      app.log.error({ provider, status: response.status, payload: data }, "AI upstream request failed");
      const message = response.status === 401 ? "Your AI API key is invalid. Check AI_API_KEY in the server .env." : data.error?.message ?? "Anthropic could not generate a recipe.";
      throw new AiRequestError(message, response.status, isRetryableAiStatus(response.status));
    }
    return data.content?.[0]?.text ?? "";
  }
  if (provider === "gemini") {
    const parts: unknown[] = [{ text: prompt }];
    if (image) parts.push({ inline_data: { mime_type: "image/jpeg", data: image } });
    const response = await aiFetch(provider, `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }] })
    }, timeoutMs);
    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      app.log.error({ provider, status: response.status, payload: data }, "AI upstream request failed");
      const message = response.status === 400 || response.status === 401 || response.status === 403
        ? "Your Gemini API key was rejected. Check AI_API_KEY or GEMINI_API_KEY in the server .env."
        : data.error?.message ?? "Gemini could not generate a recipe.";
      throw new AiRequestError(message, response.status, isRetryableAiStatus(response.status));
    }
    return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  }
  const isOllama = provider === "ollama";
  const response = await aiFetch(provider, `${baseUrl}${isOllama ? "/api/chat" : "/chat/completions"}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(isOllama
      ? { model, stream: false, messages: [{ role: "user", content: prompt, ...(image ? { images: [image] } : {}) }] }
      : { model, messages: [{ role: "user", content: image ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }] : prompt }] })
  }, timeoutMs);
  const data = await response.json() as { message?: { content: string }; choices?: Array<{ message: { content: string } }>; error?: unknown };
  if (!response.ok) {
    app.log.error({ provider, status: response.status, payload: data }, "AI upstream request failed");
    const providerMessage = typeof data.error === "object" && data.error && "message" in data.error ? String((data.error as { message: unknown }).message) : "";
    const message = response.status === 401 ? "Your AI API key is invalid. Check AI_API_KEY in the server .env." : providerMessage || `${provider} could not generate a recipe.`;
    throw new AiRequestError(message, response.status, isRetryableAiStatus(response.status));
  }
  return data.message?.content ?? data.choices?.[0]?.message.content ?? "";
}

/**
 * Asks the configured provider, then walks the failover chain when it answers with a
 * rate limit, a timeout, or an upstream fault. A rejected key stops the walk, since
 * every provider would reject it the same way.
 */
async function callLlm(prompt: string, image?: string, timeoutMs = AI_TIMEOUT_MS) {
  const primary = resolveAiConfig();
  if (primary.provider !== "ollama" && !primary.key) {
    throw new AiRequestError("Set AI_API_KEY in the server .env to read labels and mix drinks.", 400);
  }
  const chain = buildAiFailoverChain(primary, process.env);
  let lastError: unknown = new AiRequestError("No AI provider is configured.", 400);
  for (const [index, config] of chain.entries()) {
    try {
      return await requestAi(config, prompt, image, timeoutMs);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof AiRequestError ? error.retryable : true;
      const next = chain[index + 1];
      if (!retryable || !next) break;
      app.log.warn({
        provider: config.provider,
        status: error instanceof AiRequestError ? error.statusCode : 0,
        reason: error instanceof Error ? error.message : String(error),
        failingOverTo: next.provider,
        model: next.model
      }, "AI provider unavailable, failing over to the next configured key");
    }
  }
  throw lastError;
}

app.post<{ Body: { prompt?: string } }>("/api/ai/mixologist", async (request, reply) => {
  const shelf = mixologistShelfSummary(currentShelf());
  try {
    const result = await callLlm(`You are the house mixologist for The Smokey Vault. Prefer bottles actually on the shelf. Name the specific bottles when you can. Pantry staples (citrus, sugar, soda water, mint, egg white, espresso, ice) are assumed. Shelf: ${JSON.stringify(shelf)}. Request: ${request.body.prompt ?? "Create a cocktail"}. Return ONLY valid JSON with this exact shape: {"name":"string","ingredients":["exact measured ingredient"],"method":"string","glassware":"string","garnish":"string","season":"All|Spring|Summer|Fall|Winter|Holiday","notes":"brief tasting note and one substitution"}. Do not use markdown.`, undefined, AI_MIXOLOGIST_PROVIDER_TIMEOUT_MS);
    return { recipe: parseGeneratedRecipe(result) };
  } catch (error) {
    app.log.error({ error }, "AI mixologist request failed");
    if (error instanceof AiRecipeParseError) {
      return reply.code(502).send({ error: error.message });
    }
    const status = error instanceof AiRequestError ? error.statusCode : 502;
    const message = error instanceof AiRequestError ? error.message : "The AI service could not be reached. Check your provider settings and network connection.";
    return reply.code(status).send({ error: message });
  }
});

app.post<{ Body: { url?: string } }>("/api/cocktails/import", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const url = String(request.body?.url ?? "").trim();
  if (!url) return reply.code(400).send({ error: "Paste a recipe link." });
  try {
    const { html, finalUrl } = await fetchPublicHtml(url);
    try {
      return { recipe: parseRecipeHtml(html, finalUrl), source: "page" };
    } catch (parseError) {
      const { provider, key } = resolveAiConfig();
      if (provider === "ollama" || key) {
        try {
          const extracted = await callLlm(`Extract a cocktail recipe from this page. Return ONLY JSON with keys name, ingredients (array of strings), method, glassware, garnish, season (All|Spring|Summer|Fall|Winter|Holiday), notes. Page text: ${recipeTextForAi(html)}`);
          const parsed = parseGeneratedRecipe(extracted);
          const image = metaContent(html, "og:image") || metaContent(html, "twitter:image");
          let imageUrl = "";
          if (image) {
            try { imageUrl = new URL(image, finalUrl).href; } catch { imageUrl = image; }
          }
          return {
            recipe: { ...parsed, image_url: imageUrl, source_url: finalUrl },
            source: "ai"
          };
        } catch {
          // Fall through to the original parse error.
        }
      }
      throw parseError;
    }
  } catch (error) {
    const status = error instanceof RecipeImportError ? error.statusCode : 502;
    const message = error instanceof RecipeImportError ? error.message : "Could not read that recipe link.";
    return reply.code(status).send({ error: message });
  }
});

app.post<{ Body: GeneratedRecipe }>("/api/cocktails/custom", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const recipe = request.body;
  if (!recipe.name || !Array.isArray(recipe.ingredients) || !recipe.ingredients.length || !recipe.method) {
    return reply.code(400).send({ error: "A name, ingredients, and method are required." });
  }
  const imageUrl = await localizeImage(recipe.image_url) ?? recipe.image_url ?? "";
  const fav = recipe.bartender_fav ? 1 : 0;
  db.prepare(`INSERT INTO cocktails(name,collection,ingredients,glassware,garnish,method,notes,season,image_url,source_url,bartender_fav)
    VALUES(?, 'Custom Cocktails', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET collection='Custom Cocktails',ingredients=excluded.ingredients,
    glassware=excluded.glassware,garnish=excluded.garnish,method=excluded.method,notes=excluded.notes,season=excluded.season,
    image_url=excluded.image_url,source_url=excluded.source_url,bartender_fav=excluded.bartender_fav`)
    .run(
      recipe.name.trim(), JSON.stringify(recipe.ingredients), recipe.glassware || "Rocks", recipe.garnish || "",
      recipe.method, recipe.notes || "", recipe.season || "All", imageUrl, recipe.source_url || "", fav
    );
  return reply.code(201).send(db.prepare("SELECT * FROM cocktails WHERE name=?").get(recipe.name.trim()));
});

app.put<{ Params: { id: string }; Body: { bartender_fav?: boolean | number } }>("/api/cocktails/:id", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const row = db.prepare("SELECT id FROM cocktails WHERE id=?").get(request.params.id);
  if (!row) return reply.code(404).send({ error: "Recipe not found" });
  if (request.body.bartender_fav === undefined) return reply.code(400).send({ error: "Nothing to update" });
  db.prepare("UPDATE cocktails SET bartender_fav=? WHERE id=?").run(request.body.bartender_fav ? 1 : 0, request.params.id);
  return db.prepare("SELECT * FROM cocktails WHERE id=?").get(request.params.id);
});

app.delete<{ Params: { id: string } }>("/api/cocktails/:id", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const row = db.prepare("SELECT id, collection FROM cocktails WHERE id=?").get(request.params.id) as { id: number; collection: string } | undefined;
  if (!row) return reply.code(404).send({ error: "Recipe not found" });
  if (row.collection !== "Custom Cocktails") return reply.code(403).send({ error: "Only custom recipes can be removed" });
  db.prepare("DELETE FROM cocktails WHERE id=?").run(row.id);
  return reply.code(204).send();
});

async function handleVisionLabel(request: FastifyRequest, reply: FastifyReply) {
  if (requireAdmin(request, reply)) return;
  const file = await request.file();
  if (!file) return reply.code(400).send({ error: "Image required" });
  try {
    const buffer = await file.toBuffer();
    const scaled = await downscaleVisionImage(buffer);
    const parsed = parseVisionLabel(await callLlm(VISION_LABEL_PROMPT, scaled.base64));
    let imageUrl = "";
    try {
      imageUrl = saveImageBuffer(buffer, file.mimetype, file.filename);
    } catch {
      imageUrl = "";
    }
    const product = { ...parsed, image_url: imageUrl };
    const suggestions = parsed.product_type === "beer"
      ? await searchCatalogBeerSuggestions(`${parsed.brand} ${parsed.name}`.trim(), 5)
      : [];
    const params = request.params as { id?: string };
    const query = request.query as { row?: string };
    const queueId = Number(params.id ?? query.row ?? "");
    if (Number.isInteger(queueId) && queueId > 0) {
      const row = applyLabelToImportRow(queueId, product, parsed.upc);
      if (!row) return reply.code(404).send({ error: "Import row not found" });
      return {
        source: "label" as const,
        upc: row.upc,
        table: row.table,
        kind: row.kind,
        product: row.product,
        reason: row.reason,
        message: row.message,
        suggestions
      };
    }
    return {
      source: "label" as const,
      upc: parsed.upc || undefined,
      product,
      suggestions
    };
  } catch (error) {
    app.log.error({ error }, "AI vision-label request failed");
    const status = error instanceof AiRequestError ? error.statusCode : 502;
    return reply.code(status).send({ error: error instanceof Error ? error.message : "Could not read that label" });
  }
}

app.post("/api/ai/vision", handleVisionLabel);
app.post("/api/ai/vision-label", handleVisionLabel);
app.post("/api/inventory/import-queue/:id/label", handleVisionLabel);

/* ------------------------- Speakeasy: patrons & votes ----------------------- */

function speakeasyFail(reply: FastifyReply, error: unknown, fallback: string) {
  const status = error instanceof SpeakeasyError ? error.statusCode : 400;
  return reply.code(status).send({ error: error instanceof Error ? error.message : fallback });
}

app.get("/api/patrons", {
  schema: { tags: ["Patrons"], summary: "Regulars leaderboard (top 15 for guests, all for admin)" }
}, async (request) => {
  const admin = isAdmin(request.headers.authorization);
  return { patrons: admin ? listPatrons() : listLeaderboard(), admin };
});

app.post<{ Body: { name?: string; nickname?: string; notes?: string; visit_count?: number } }>("/api/patrons", {
  schema: { tags: ["Patrons"], summary: "Add a regular" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    return reply.code(201).send(createPatron(request.body ?? {}));
  } catch (error) {
    return speakeasyFail(reply, error, "Could not add that patron");
  }
});

app.put<{ Params: { id: string }; Body: { nickname?: string; notes?: string; visit_count?: number } }>("/api/patrons/:id", {
  schema: { tags: ["Patrons"], summary: "Update a regular" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    return updatePatron(Number(request.params.id), request.body ?? {});
  } catch (error) {
    return speakeasyFail(reply, error, "Could not update that patron");
  }
});

app.post<{ Params: { id: string } }>("/api/patrons/:id/increment", {
  schema: { tags: ["Patrons"], summary: "Log another visit" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    return adjustPatronVisits(Number(request.params.id), 1);
  } catch (error) {
    return speakeasyFail(reply, error, "Could not log that visit");
  }
});

app.post<{ Params: { id: string } }>("/api/patrons/:id/decrement", {
  schema: { tags: ["Patrons"], summary: "Remove a logged visit" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    return adjustPatronVisits(Number(request.params.id), -1);
  } catch (error) {
    return speakeasyFail(reply, error, "Could not update that visit count");
  }
});

app.delete<{ Params: { id: string } }>("/api/patrons/:id", {
  schema: { tags: ["Patrons"], summary: "Remove a regular" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  if (!deletePatron(Number(request.params.id))) return reply.code(404).send({ error: "Patron not found" });
  return reply.code(204).send();
});

app.get<{ Params: { table: string } }>("/api/inventory/:table/daily-votes", {
  schema: { tags: ["Votes"], summary: "Tonight's identity-locked vote tallies" }
}, async (request, reply) => {
  if (!VOTE_TABLES.has(request.params.table)) return reply.code(404).send({ error: "Unknown module" });
  return dailyVoteTallies(request.params.table);
});

app.post<{ Params: { table: string; id: string }; Body: { patron_name?: string; value?: number } }>(
  "/api/inventory/:table/:id/daily-vote",
  { schema: { tags: ["Votes"], summary: "One vote per patron per vault day (rolls at 4:00 AM)" } },
  async (request, reply) => {
    if (!VOTE_TABLES.has(request.params.table)) return reply.code(404).send({ error: "Unknown module" });
    try {
      return castDailyVote(request.params.table, Number(request.params.id), request.body?.patron_name, request.body?.value);
    } catch (error) {
      return speakeasyFail(reply, error, "Could not save that vote");
    }
  }
);

/* ----------------------- Speakeasy: messages & alerts ----------------------- */

app.post<{ Body: { sender_name?: string; contact_info?: string; body?: string } }>("/api/messages", {
  schema: { tags: ["Messages"], summary: "Send the keeper a message from the guest portal" }
}, async (request, reply) => {
  try {
    const message = createMessage(request.body ?? {});
    return reply.code(201).send({ ok: true, id: message.id, created_at: message.created_at });
  } catch (error) {
    return speakeasyFail(reply, error, "Could not send that message");
  }
});

app.get("/api/messages", {
  schema: { tags: ["Messages"], summary: "Inbox with unread count" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  return listMessages();
});

app.get("/api/messages/unread", {
  schema: { tags: ["Messages"], summary: "Unread message badge count" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  return { unread: unreadMessageCount() };
});

app.put<{ Params: { id: string }; Body: { is_read?: boolean } }>("/api/messages/:id/read", {
  schema: { tags: ["Messages"], summary: "Mark a message read or unread" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    return markMessageRead(Number(request.params.id), request.body?.is_read !== false);
  } catch (error) {
    return speakeasyFail(reply, error, "Could not update that message");
  }
});

app.delete<{ Params: { id: string } }>("/api/messages/:id", {
  schema: { tags: ["Messages"], summary: "Delete a message" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  if (!deleteMessage(Number(request.params.id))) return reply.code(404).send({ error: "Message not found" });
  return reply.code(204).send();
});

/* -------------------- Speakeasy: events, subscribers, merch ----------------- */

app.get("/api/events", { schema: { tags: ["Events"], summary: "Upcoming parties and bashes" } }, async (request) => {
  return listEvents(isAdmin(request.headers.authorization));
});

app.post<{ Body: Record<string, unknown> }>("/api/events", { schema: { tags: ["Events"], summary: "Add an event" } }, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    return reply.code(201).send(createEvent(request.body ?? {}));
  } catch (error) {
    return speakeasyFail(reply, error, "Could not save that event");
  }
});

app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/events/:id", { schema: { tags: ["Events"], summary: "Update an event" } }, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    return updateEvent(Number(request.params.id), request.body ?? {});
  } catch (error) {
    return speakeasyFail(reply, error, "Could not update that event");
  }
});

app.delete<{ Params: { id: string } }>("/api/events/:id", { schema: { tags: ["Events"], summary: "Delete an event" } }, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  if (!deleteEvent(Number(request.params.id))) return reply.code(404).send({ error: "Event not found" });
  return reply.code(204).send();
});

app.get("/api/event-subscribers", { schema: { tags: ["Events"], summary: "Party invite list" } }, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  return listEventSubscribers();
});

app.post<{ Body: Record<string, unknown> }>("/api/event-subscribers", {
  schema: { tags: ["Events"], summary: "Join the party invite list" }
}, async (request, reply) => {
  try {
    const subscriber = createEventSubscriber(request.body ?? {});
    return reply.code(201).send({ ok: true, id: subscriber.id });
  } catch (error) {
    return speakeasyFail(reply, error, "Could not add you to the list");
  }
});

app.delete<{ Params: { id: string } }>("/api/event-subscribers/:id", { schema: { tags: ["Events"], summary: "Remove a subscriber" } }, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  if (!deleteEventSubscriber(Number(request.params.id))) return reply.code(404).send({ error: "Subscriber not found" });
  return reply.code(204).send();
});

app.get("/api/merch", { schema: { tags: ["Merch"], summary: "House merch and swag" } }, async (request) => {
  return listMerch(isAdmin(request.headers.authorization));
});

app.post<{ Body: Record<string, unknown> }>("/api/merch", { schema: { tags: ["Merch"], summary: "Add a merch item" } }, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    return reply.code(201).send(createMerch(request.body ?? {}));
  } catch (error) {
    return speakeasyFail(reply, error, "Could not save that item");
  }
});

app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/merch/:id", { schema: { tags: ["Merch"], summary: "Update a merch item" } }, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    return updateMerch(Number(request.params.id), request.body ?? {});
  } catch (error) {
    return speakeasyFail(reply, error, "Could not update that item");
  }
});

app.delete<{ Params: { id: string } }>("/api/merch/:id", { schema: { tags: ["Merch"], summary: "Delete a merch item" } }, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  if (!deleteMerch(Number(request.params.id))) return reply.code(404).send({ error: "Merch item not found" });
  return reply.code(204).send();
});

/* --------------------------------- Meet the crew ---------------------------- */

function staffFail(reply: FastifyReply, error: unknown, fallback: string) {
  if (error instanceof StaffError) return reply.code(error.status).send({ error: error.message });
  app.log.error(error);
  return reply.code(500).send({ error: fallback });
}

app.get("/api/staff", { schema: { tags: ["Crew"], summary: "The crew behind the bar" } }, async () => {
  return { staff: listStaff() };
});

app.post<{ Body: Record<string, unknown> }>("/api/staff", {
  schema: { tags: ["Crew"], summary: "Add a crew member" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    return reply.code(201).send(createStaff(request.body ?? {}));
  } catch (error) {
    return staffFail(reply, error, "Could not save that crew member");
  }
});

app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/staff/:id", {
  schema: { tags: ["Crew"], summary: "Update a crew member" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    return updateStaff(Number(request.params.id), request.body ?? {});
  } catch (error) {
    return staffFail(reply, error, "Could not update that crew member");
  }
});

app.post<{ Params: { id: string; direction: string } }>("/api/staff/:id/move/:direction", {
  schema: { tags: ["Crew"], summary: "Reorder a crew member" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const direction = request.params.direction === "up" ? "up" : "down";
  try {
    return { staff: moveStaff(Number(request.params.id), direction) };
  } catch (error) {
    return staffFail(reply, error, "Could not reorder the crew");
  }
});

app.delete<{ Params: { id: string } }>("/api/staff/:id", {
  schema: { tags: ["Crew"], summary: "Remove a crew member" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    deleteStaff(Number(request.params.id));
    return reply.code(204).send();
  } catch (error) {
    return staffFail(reply, error, "Could not remove that crew member");
  }
});

/* ---------------------------------- Bar gallery ----------------------------- */

function galleryFail(reply: FastifyReply, error: unknown, fallback: string) {
  if (error instanceof GalleryError) return reply.code(error.status).send({ error: error.message });
  const message = error instanceof Error ? error.message : fallback;
  if (/file too large|limit/i.test(message)) {
    return reply.code(413).send({ error: "That clip is over 150 MB. Trim it down and try again." });
  }
  app.log.error(error);
  return reply.code(500).send({ error: fallback });
}

app.get("/api/gallery", { schema: { tags: ["Gallery"], summary: "Photos and clips from the bar" } }, async () => {
  return { media: listGallery() };
});

app.post("/api/gallery/upload", {
  bodyLimit: MAX_GALLERY_BYTES + 1024 * 1024,
  schema: { tags: ["Gallery"], summary: "Upload a photo or video to the bar gallery" }
}, async (request, reply) => {
  try {
    const file = await request.file({ limits: { fileSize: MAX_GALLERY_BYTES } });
    if (!file) return reply.code(400).send({ error: "Pick a photo or video first" });
    const buffer = await file.toBuffer();
    const field = (key: string) => {
      const entry = file.fields?.[key];
      const single = Array.isArray(entry) ? entry[0] : entry;
      return single && "value" in single ? String(single.value) : "";
    };
    return reply.code(201).send(saveGalleryUpload({
      buffer,
      contentType: file.mimetype,
      originalName: file.filename,
      caption: field("caption"),
      uploadedBy: field("uploaded_by")
    }));
  } catch (error) {
    return galleryFail(reply, error, "Could not save that upload");
  }
});

/**
 * Serves gallery media with byte-range support. iOS Safari refuses to play a video
 * unless the server answers a Range request with 206 and a Content-Range header.
 */
app.get<{ Params: { file: string } }>("/api/media/gallery/:file", {
  schema: { tags: ["Gallery"], summary: "Stream gallery media with range support" }
}, async (request, reply) => {
  let path: string;
  try {
    path = galleryFilePath(basename(request.params.file));
  } catch (error) {
    return galleryFail(reply, error, "Could not read that media");
  }

  const total = statSync(path).size;
  const type = GALLERY_CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");

  if (range) {
    const startRaw = range[1];
    const endRaw = range[2];
    let start = startRaw ? Number(startRaw) : 0;
    let end = endRaw ? Number(endRaw) : total - 1;
    if (!startRaw && endRaw) {
      start = Math.max(0, total - Number(endRaw));
      end = total - 1;
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      return reply.code(416).header("content-range", `bytes */${total}`).send();
    }
    end = Math.min(end, total - 1);
    return reply
      .code(206)
      .header("content-range", `bytes ${start}-${end}/${total}`)
      .header("accept-ranges", "bytes")
      .header("content-length", end - start + 1)
      .header("cache-control", "public, max-age=31536000, immutable")
      .type(type)
      .send(createReadStream(path, { start, end }));
  }

  return reply
    .header("accept-ranges", "bytes")
    .header("content-length", total)
    .header("cache-control", "public, max-age=31536000, immutable")
    .type(type)
    .send(createReadStream(path));
});

app.get<{ Params: { file: string } }>("/api/media/gallery/:file/download", {
  schema: { tags: ["Gallery"], summary: "Download gallery media as an attachment" }
}, async (request, reply) => {
  let path: string;
  try {
    path = galleryFilePath(basename(request.params.file));
  } catch (error) {
    return galleryFail(reply, error, "Could not read that media");
  }
  const name = basename(path);
  return reply
    .header("content-disposition", `attachment; filename="smoky-barrel-${name}"`)
    .header("content-length", statSync(path).size)
    .type(GALLERY_CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream")
    .send(createReadStream(path));
});

app.delete<{ Params: { id: string } }>("/api/gallery/:id", {
  schema: { tags: ["Gallery"], summary: "Delete a gallery item" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  try {
    deleteGalleryMedia(Number(request.params.id));
    return reply.code(204).send();
  } catch (error) {
    return galleryFail(reply, error, "Could not delete that item");
  }
});

/* ------------------------------ Container reboot ---------------------------- */

app.post("/api/system/restart", {
  schema: { tags: ["System"], summary: "Checkpoint the database and restart the container" }
}, async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  db.pragma("wal_checkpoint(TRUNCATE)");
  app.log.warn("Restart requested from the admin kiosk");
  setTimeout(() => process.exit(0), 500).unref();
  return { ok: true, restarting: true };
});

app.get("/api/settings", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const rows = db.prepare("SELECT key,value,updated_at FROM settings WHERE key != 'pinHash'").all();
  const settings = Object.fromEntries((rows as Array<{key:string;value:string}>).map((r) => [r.key, r.value]));
  delete settings.aiApiKey;
  delete settings.aiProvider;
  delete settings.aiBaseUrl;
  delete settings.aiModel;
  settings.keeperName = keeperName();
  return {
    ...settings,
    brewfatherConfigured: isBrewfatherConfigured(),
    enabledTabs: parseEnabledTabs(settings.enabled_tabs),
    unreadMessages: unreadMessageCount()
  };
});

app.put<{ Body: Record<string, string> }>("/api/settings", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const allowed = new Set([
    "theme","restockPackagedBelow","restockSpiritFill","restockWineBelow","keeperName",
    ...PUBLIC_SETTING_KEYS, "discord_webhook_url"
  ]);
  for (const [key, value] of Object.entries(request.body)) {
    if (!allowed.has(key)) continue;
    if (key === "keeperName") {
      setSetting(key, clipKeeperName(value).slice(0, MAX_KEEPER_NAME) || DEFAULT_KEEPER_NAME);
      continue;
    }
    if (key === "enabled_tabs") {
      setSetting(key, serializeEnabledTabs(parseEnabledTabs(String(value))));
      continue;
    }
    if (key === "tab_order") {
      // Accepts either a JSON string or an already-parsed array from the kiosk.
      const incoming: unknown = value;
      const raw = Array.isArray(incoming) ? JSON.stringify(incoming) : String(value);
      setSetting(key, JSON.stringify(parseTabOrder(raw)));
      continue;
    }
    if (key === "guest_bartender_enabled") {
      setSetting(key, String(value) === "1" || String(value) === "true" ? "1" : "0");
      continue;
    }
    if (key.startsWith("restock")) {
      const parsed = parseRestockThresholds({ [key]: String(value) });
      const stored = key === "restockPackagedBelow" ? parsed.packagedBelow : key === "restockSpiritFill" ? parsed.spiritFill : parsed.wineBelow;
      setSetting(key, String(stored));
      continue;
    }
    setSetting(key, String(value));
  }
  return { ok: true };
});

app.get<{ Querystring: { format?: string; table?: string } }>("/api/export", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  setSetting("lastBackupDownload", new Date().toISOString());
  if (request.query.format === "db") {
    db.pragma("wal_checkpoint(TRUNCATE)");
    return reply.header("content-disposition", 'attachment; filename="smokeyvault.db"').type("application/octet-stream").send(createReadStream(dbPath));
  }
  const exportTables = request.query.table && publicTables.has(request.query.table) ? [request.query.table] : [...publicTables];
  const payload = Object.fromEntries(exportTables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  if (request.query.format === "csv" && request.query.table) {
    const rows = payload[request.query.table] as Record<string, unknown>[];
    const headers = rows[0] ? Object.keys(rows[0]) : tableFields[request.query.table] ?? [];
    const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => `"${String(r[h] ?? "").replaceAll('"','""')}"`).join(","))].join("\n");
    return reply.header("content-disposition", `attachment; filename="${request.query.table}.csv"`).type("text/csv").send(csv);
  }
  return reply.header("content-disposition", 'attachment; filename="smokeyvault.json"').send(payload);
});

app.post("/api/backups/snapshot", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  return { file: basename(createBackup()) };
});

setTimeout(() => { try { createBackup(); } catch (error) { app.log.error(error); } }, 5000);
setInterval(() => { try { createBackup(); } catch (error) { app.log.error(error); } }, 24 * 60 * 60_000).unref();

setInterval(() => {
  flushDiscordAlerts()
    .then((sent) => { if (sent) app.log.info({ sent }, "Announced unanswered guest messages on Discord"); })
    .catch((error) => app.log.error({ error }, "Discord message alert failed"));
}, DISCORD_ALERT_INTERVAL_MS).unref();

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../client/dist");
if (existsSync(root)) {
  await app.register(fastifyStatic, { root });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.type("text/html").send(readFileSync(join(root, "index.html")));
  });
}

const bootAi = resolveAiConfig();
if (bootAi.keyFromEnvironment) {
  app.log.info({ provider: bootAi.provider, model: bootAi.model, baseUrl: bootAi.baseUrl, key: maskSecret(bootAi.key) }, "Environment AI key detected");
} else {
  app.log.info({ detected: false, provider: bootAi.provider, model: bootAi.model, baseUrl: bootAi.baseUrl }, "No environment AI key detected; using SQLite settings or keyless Ollama");
}
const bootFallbacks = buildAiFailoverChain(bootAi, process.env).slice(1);
app.log.info(
  { fallbacks: bootFallbacks.map((config) => `${config.provider}:${config.model}`) },
  bootFallbacks.length ? "AI failover armed" : "No AI failover providers configured"
);
app.log.info({ configured: isBrewfatherConfigured() }, "Brewfather batch sync");

await app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" });
