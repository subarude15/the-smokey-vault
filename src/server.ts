import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastifyStatic from "@fastify/static";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db, dbPath, createBackup, getSetting, setPin, setSetting, verifyPin } from "./db.js";
import { prepareBrewWrite, preparePackagedWrite, prepareSpiritWrite } from "./catalog.js";
import { buildShelf, matchCocktail, mixologistShelfSummary } from "./cocktails.js";
import { createTicket, deleteTicket, listTickets, setTicketStatus } from "./cocktail_tickets.js";
import { buildOverview } from "./overview.js";
import { buildRestockList, createWanted, deleteWanted, listRestockGot, listWanted, parseRestockThresholds, restockSummary, setRestockGot } from "./restock.js";
import { fetchPublicHtml, metaContent, parseRecipeHtml, recipeTextForAi, RecipeImportError } from "./recipe_import.js";
import { enrichColaRecord, fetchColaQuota, lookupProduct, searchBottles } from "./lookup.js";
import { isColaConfigured } from "./cola_client.js";
import { imagesDir, localizeImage, saveImageBuffer } from "./images.js";
import { parseVisionLabel, VISION_LABEL_PROMPT } from "./vision_label.js";
import { createReview, deleteReview, deleteReviewsForItem, listReviews, REVIEW_TABLES } from "./reviews.js";
import { addNextRequest, deleteNextRequest, listNextBoards, voteNextRequest } from "./requests.js";
import { castVote, deleteVotesForItem, getVoteTally, summarizeVotes, voteTallies, VOTE_TABLES } from "./votes.js";

const app = Fastify({ logger: true, bodyLimit: 15 * 1024 * 1024 });
const secret = process.env.SESSION_SECRET ?? `${dbPath}:smokey-vault`;
const tables = new Set(["spirits", "taps", "brews", "packaged_beer", "wines"]);
const publicTables = new Set([...tables, "cocktails"]);
const tableFields: Record<string, string[]> = {
  spirits: ["name","brand","category","sub_category","abv","volume_ml","fill_level","purchase_date","opened_date","shelf_location","upc","notes","image_url","stock_count","tasting_notes","flavors","tags","base_ingredient"],
  taps: ["tap_number","keg_size_l","source_type","brewery_batch","style","abv","ibu","tapped_date","remaining_l","maker","notes","image_url","tasting_notes","flavors","tags","base_ingredient"],
  brews: ["batch_name","style","brew_date","target_og","target_fg","measured_og","measured_fg","calculated_abv","schedule","status","notes","maker","image_url","tasting_notes","flavors","tags","base_ingredient","hops"],
  packaged_beer: ["brewery","name","style","count","pack_date","abv","upc","image_url","notes","tasting_notes","flavors","tags","base_ingredient","vessel"],
  wines: ["producer","name","varietal","vintage","type","style","region","sweetness","bottle_count","pairings","notes","upc","image_url","tasting_notes","flavors","tags","base_ingredient"]
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

app.get("/api/health", { schema: { tags: ["System"], summary: "Health check" } }, async () => ({ ok: true, version: "1.0.0" }));

app.post<{ Body: { pin?: string } }>("/api/auth/unlock", {
  schema: { tags: ["Auth"], summary: "Unlock admin mode", body: { type: "object", required: ["pin"], properties: { pin: { type: "string" } } } }
}, async (request, reply) => {
  if (!request.body.pin || !verifyPin(request.body.pin)) return reply.code(401).send({ error: "Incorrect PIN" });
  return { token: token(), expiresIn: 900 };
});

app.post<{ Body: { currentPin?: string; newPin?: string } }>("/api/auth/pin", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const { currentPin, newPin } = request.body;
  if (!currentPin || !verifyPin(currentPin)) return reply.code(403).send({ error: "Current PIN is incorrect" });
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

app.put<{ Params: { table: string; id: string }; Body: Record<string, unknown> }>("/api/inventory/:table/:id", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const table = request.params.table;
  if (!tables.has(table)) return reply.code(404).send({ error: "Unknown module" });
  const existing = table === "brews"
    ? db.prepare("SELECT * FROM brews WHERE id=?").get(request.params.id) as Record<string, unknown> | undefined
    : undefined;
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
  return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(request.params.id);
});

app.delete<{ Params: { table: string; id: string } }>("/api/inventory/:table/:id", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  if (!tables.has(request.params.table)) return reply.code(404).send({ error: "Unknown module" });
  deleteReviewsForItem(request.params.table, Number(request.params.id));
  deleteVotesForItem(request.params.table, Number(request.params.id));
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
    const message = error instanceof Error ? error.message : "Could not load What's next";
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
  const spirits = db.prepare("SELECT name,brand,category,sub_category,fill_level,stock_count FROM spirits").all() as Array<Record<string, unknown>>;
  const wines = db.prepare("SELECT name,producer,type,style,varietal,bottle_count FROM wines").all() as Array<Record<string, unknown>>;
  const shelf = buildShelf(spirits, wines);
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
  const shelf = buildShelf(spirits, wines);
  const cocktails = (db.prepare("SELECT * FROM cocktails ORDER BY name").all() as Array<Record<string, unknown>>)
    .map((cocktail) => ({ ...cocktail, ...matchCocktail(cocktail, shelf) }));
  return buildOverview({
    spirits,
    taps,
    brews,
    packaged,
    wines,
    cocktails,
    tickets: listTickets("queued")
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
  const shelf = buildShelf(spirits, wines);
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
  request: { params: { code: string }; query: { enrich?: string; refresh?: string; force?: string } },
  reply: { code: (n: number) => { send: (v: unknown) => unknown } }
) {
  const enrich = request.query.enrich !== "false" && request.query.enrich !== "0";
  const forceRefresh = request.query.refresh === "true" || request.query.refresh === "1"
    || request.query.force === "true" || request.query.force === "1";
  try {
    const result = await lookupProduct(request.params.code, { enrich, forceRefresh });
    // Always 200 so a miss can still keep the UPC and open search.
    return result;
  } catch (error) {
    app.log.error({ error }, "Barcode lookup failed");
    return reply.code(502).send({ error: "Barcode lookup failed" });
  }
}

app.get<{ Params: { code: string }; Querystring: { enrich?: string; refresh?: string; force?: string } }>(
  "/api/scan/upc/:code",
  { schema: { tags: ["Lookup"], summary: "Barcode lookup (vault → cache → COLA Cloud → Open Food Facts)" } },
  handleBarcodeLookup
);

app.get<{ Params: { code: string }; Querystring: { enrich?: string; refresh?: string; force?: string } }>(
  "/api/lookup/:code",
  { schema: { tags: ["Lookup"], summary: "Barcode lookup pipeline" } },
  handleBarcodeLookup
);

app.get<{ Querystring: { q?: string; table?: string } }>("/api/search/bottles", {
  schema: { tags: ["Lookup"], summary: "Search vault + COLA Cloud by bottle name" }
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
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}

function resolveAiConfig() {
  const providerFromKey = process.env.OPENROUTER_API_KEY ? "openrouter" : process.env.OPENAI_API_KEY ? "openai" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "";
  const environmentProvider = process.env.AI_PROVIDER?.trim().toLowerCase() || providerFromKey || (process.env.AI_API_KEY ? "openai" : "");
  const provider = environmentProvider || getSetting("aiProvider")?.toLowerCase() || "ollama";
  const environmentKey = process.env.AI_API_KEY ||
    (provider === "openrouter" ? process.env.OPENROUTER_API_KEY : provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) || "";
  const key = environmentKey || getSetting("aiApiKey") || "";
  const defaultBaseUrl = provider === "ollama" ? (process.env.OLLAMA_HOST || "http://host.docker.internal:11434") : provider === "anthropic" ? "https://api.anthropic.com" : provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1";
  const environmentBaseUrl = process.env.AI_BASE_URL?.trim() || "";
  const baseUrl = (environmentBaseUrl || getSetting("aiBaseUrl") || defaultBaseUrl).replace(/\/$/, "");
  const defaultModel = provider === "ollama" ? "llama3.2-vision" : provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o-mini";
  const environmentModel = process.env.AI_MODEL?.trim() || "";
  const model = environmentModel || getSetting("aiModel") || defaultModel;
  const fromEnvironment = Boolean(environmentProvider || environmentKey || environmentBaseUrl || environmentModel || process.env.OLLAMA_HOST);
  return { provider, key, baseUrl, model, fromEnvironment, keyFromEnvironment: Boolean(environmentKey) };
}

function maskSecret(value: string) {
  if (!value) return "not set";
  if (value.length <= 8) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

async function callLlm(prompt: string, image?: string) {
  const { provider, key, baseUrl, model } = resolveAiConfig();
  if (provider !== "ollama" && !key) {
    throw new AiRequestError("Set AI_API_KEY in the server .env to read labels and mix drinks.", 400);
  }
  if (provider === "anthropic") {
    const content: unknown[] = [{ type: "text", text: prompt }];
    if (image) content.unshift({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
    const response = await fetch(`${baseUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: "user", content }] }) });
    const data = await response.json() as { content?: Array<{ text: string }>; error?: { message?: string } };
    if (!response.ok) {
      app.log.error({ provider, status: response.status, payload: data }, "AI upstream request failed");
      const message = response.status === 401 ? "Your AI API key is invalid. Check AI_API_KEY in the server .env." : data.error?.message ?? "Anthropic could not generate a recipe.";
      throw new AiRequestError(message, response.status);
    }
    return data.content?.[0]?.text ?? "";
  }
  const isOllama = provider === "ollama";
  const response = await fetch(`${baseUrl}${isOllama ? "/api/chat" : "/chat/completions"}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(isOllama
      ? { model, stream: false, messages: [{ role: "user", content: prompt, ...(image ? { images: [image] } : {}) }] }
      : { model, messages: [{ role: "user", content: image ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }] : prompt }] })
  });
  const data = await response.json() as { message?: { content: string }; choices?: Array<{ message: { content: string } }>; error?: unknown };
  if (!response.ok) {
    app.log.error({ provider, status: response.status, payload: data }, "AI upstream request failed");
    const providerMessage = typeof data.error === "object" && data.error && "message" in data.error ? String((data.error as { message: unknown }).message) : "";
    const message = response.status === 401 ? "Your AI API key is invalid. Check AI_API_KEY in the server .env." : providerMessage || `${provider} could not generate a recipe.`;
    throw new AiRequestError(message, response.status);
  }
  return data.message?.content ?? data.choices?.[0]?.message.content ?? "";
}

type GeneratedRecipe = {
  name: string;
  ingredients: string[];
  method: string;
  glassware: string;
  garnish: string;
  season: string;
  notes: string;
  image_url?: string;
  source_url?: string;
  bartender_fav?: boolean | number;
};

function parseGeneratedRecipe(result: string): GeneratedRecipe {
  const cleaned = result.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AiRequestError("The AI returned an incomplete recipe. Please try again.");
  let value: Partial<GeneratedRecipe>;
  try {
    value = JSON.parse(cleaned.slice(start, end + 1)) as Partial<GeneratedRecipe>;
  } catch {
    throw new AiRequestError("The AI returned a recipe in an unexpected format. Please try again.");
  }
  if (!value.name || !Array.isArray(value.ingredients) || !value.ingredients.every((ingredient) => typeof ingredient === "string") || !value.method) {
    throw new AiRequestError("The AI recipe was missing required details. Please try again.");
  }
  return {
    name: value.name,
    ingredients: value.ingredients,
    method: value.method,
    glassware: value.glassware || "Rocks",
    garnish: value.garnish || "None",
    season: ["Spring","Summer","Fall","Winter","Holiday"].includes(value.season ?? "") ? value.season! : "All",
    notes: value.notes || "",
    image_url: typeof value.image_url === "string" ? value.image_url : "",
    source_url: typeof value.source_url === "string" ? value.source_url : ""
  };
}

app.post<{ Body: { prompt?: string } }>("/api/ai/mixologist", async (request, reply) => {
  const spirits = db.prepare("SELECT name,brand,category,sub_category,fill_level,stock_count FROM spirits").all() as Array<Record<string, unknown>>;
  const wines = db.prepare("SELECT name,producer,type,style,varietal,bottle_count FROM wines").all() as Array<Record<string, unknown>>;
  const shelf = mixologistShelfSummary(buildShelf(spirits, wines));
  try {
    const result = await callLlm(`You are the house mixologist for The Smokey Vault. Prefer bottles actually on the shelf. Name the specific bottles when you can. Pantry staples (citrus, sugar, soda water, mint, egg white, espresso, ice) are assumed. Shelf: ${JSON.stringify(shelf)}. Request: ${request.body.prompt ?? "Create a cocktail"}. Return ONLY valid JSON with this exact shape: {"name":"string","ingredients":["exact measured ingredient"],"method":"string","glassware":"string","garnish":"string","season":"All|Spring|Summer|Fall|Winter|Holiday","notes":"brief tasting note and one substitution"}. Do not use markdown.`);
    return { recipe: parseGeneratedRecipe(result) };
  } catch (error) {
    app.log.error({ error }, "AI mixologist request failed");
    const status = error instanceof AiRequestError ? error.statusCode : 502;
    const message = error instanceof AiRequestError ? error.message : "The AI service could not be reached. Check your provider settings and network connection.";
    return reply.code(status).send({ error: message });
  }
});

app.post<{ Body: { url?: string } }>("/api/cocktails/import", async (request, reply) => {
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

app.get("/api/cocktails/tickets", async () => listTickets("queued"));

app.post<{ Body: { cocktail_id?: number; name?: string; guest_name?: string; notes?: string; source_url?: string; image_url?: string } }>("/api/cocktails/tickets", async (request, reply) => {
  try {
    const ticket = createTicket({
      cocktail_id: request.body.cocktail_id,
      name: request.body.name ?? "",
      guest_name: request.body.guest_name ?? "",
      notes: request.body.notes,
      source_url: request.body.source_url,
      image_url: request.body.image_url
    });
    return reply.code(201).send(ticket);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not add that drink to the ticket";
    return reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
  }
});

app.post<{ Params: { id: string } }>("/api/cocktails/tickets/:id/pour", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const ticket = setTicketStatus(Number(request.params.id), "poured");
  if (!ticket) return reply.code(404).send({ error: "Ticket not found" });
  return ticket;
});

app.delete<{ Params: { id: string } }>("/api/cocktails/tickets/:id", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  if (!deleteTicket(Number(request.params.id))) return reply.code(404).send({ error: "Ticket not found" });
  return reply.code(204).send();
});

async function handleVisionLabel(request: FastifyRequest, reply: FastifyReply) {
  const file = await request.file();
  if (!file) return reply.code(400).send({ error: "Image required" });
  try {
    const buffer = await file.toBuffer();
    const parsed = parseVisionLabel(await callLlm(VISION_LABEL_PROMPT, buffer.toString("base64")));
    let imageUrl = "";
    try {
      imageUrl = saveImageBuffer(buffer, file.mimetype, file.filename);
    } catch {
      imageUrl = "";
    }
    return {
      source: "vision",
      upc: parsed.upc || undefined,
      product: { ...parsed, image_url: imageUrl }
    };
  } catch (error) {
    app.log.error({ error }, "AI vision-label request failed");
    const status = error instanceof AiRequestError ? error.statusCode : 502;
    return reply.code(status).send({ error: error instanceof Error ? error.message : "Could not read that label" });
  }
}

app.post("/api/ai/vision", handleVisionLabel);
app.post("/api/ai/vision-label", handleVisionLabel);

app.get("/api/settings", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const rows = db.prepare("SELECT key,value,updated_at FROM settings WHERE key != 'pinHash'").all();
  const settings = Object.fromEntries((rows as Array<{key:string;value:string}>).map((r) => [r.key, r.value]));
  const ai = resolveAiConfig();
  return {
    ...settings,
    aiConfiguredViaEnvironment: String(ai.fromEnvironment),
    aiEnvironmentProvider: ai.fromEnvironment ? ai.provider : "",
    aiEnvironmentModel: ai.fromEnvironment ? ai.model : ""
  };
});

app.put<{ Body: Record<string, string> }>("/api/settings", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const allowed = new Set(["theme","themeTokens","aiProvider","aiApiKey","aiBaseUrl","aiModel","restockPackagedBelow","restockSpiritFill","restockWineBelow"]);
  for (const [key, value] of Object.entries(request.body)) {
    if (!allowed.has(key)) continue;
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

app.post<{ Params: { table: string }; Body: { csv?: string } }>("/api/import/:table", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const table = request.params.table;
  if (!tables.has(table) || !request.body.csv) return reply.code(400).send({ error: "Valid table and CSV text required" });
  const lines = request.body.csv.trim().split(/\r?\n/);
  const headers = lines.shift()?.split(",").map((x) => x.trim().replace(/^"|"$/g, "")) ?? [];
  const valid = headers.filter((h) => tableFields[table].includes(h));
  if (!valid.length) return reply.code(400).send({ error: "No recognized column headers" });
  const insert = db.prepare(`INSERT INTO ${table} (${valid.join(",")}) VALUES (${valid.map(() => "?").join(",")})`);
  const run = db.transaction(() => {
    let count = 0;
    for (const line of lines) {
      const cells = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g)?.map((x) => x.replace(/^"|"$/g, "").replaceAll('""','"')) ?? [];
      insert.run(...valid.map((h) => cells[headers.indexOf(h)] ?? ""));
      count++;
    }
    return count;
  });
  return { imported: run() };
});

app.post("/api/backups/snapshot", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  return { file: basename(createBackup()) };
});

setTimeout(() => { try { createBackup(); } catch (error) { app.log.error(error); } }, 5000);
setInterval(() => { try { createBackup(); } catch (error) { app.log.error(error); } }, 24 * 60 * 60_000).unref();

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
  app.log.info({ provider: bootAi.provider, model: bootAi.model, key: maskSecret(bootAi.key) }, "Environment AI key detected");
} else {
  app.log.info({ detected: false, provider: bootAi.provider, model: bootAi.model }, "No environment AI key detected; using SQLite settings or keyless Ollama");
}

await app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" });
