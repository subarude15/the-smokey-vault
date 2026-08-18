import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastifyStatic from "@fastify/static";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db, dbPath, createBackup, getSetting, setPin, setSetting, verifyPin } from "./db.js";

const app = Fastify({ logger: true, bodyLimit: 15 * 1024 * 1024 });
const secret = process.env.SESSION_SECRET ?? `${dbPath}:smokey-vault`;
const tables = new Set(["spirits", "taps", "brews", "packaged_beer", "wines"]);
const publicTables = new Set([...tables, "cocktails"]);
const tableFields: Record<string, string[]> = {
  spirits: ["name","brand","category","sub_category","abv","volume_ml","fill_level","purchase_date","opened_date","shelf_location","upc","notes","image_url"],
  taps: ["tap_number","keg_size_l","source_type","brewery_batch","style","abv","ibu","tapped_date","remaining_l"],
  brews: ["batch_name","style","brew_date","target_og","target_fg","measured_og","measured_fg","calculated_abv","schedule","status","notes"],
  packaged_beer: ["brewery","name","style","count","pack_date","abv"],
  wines: ["producer","name","varietal","vintage","type","region","sweetness","body","bottle_count","drink_by_date","pairings","notes"]
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
  return db.prepare(`SELECT * FROM ${request.params.table} ORDER BY id DESC`).all();
});

app.post<{ Params: { table: string }; Body: Record<string, unknown> }>("/api/inventory/:table", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const table = request.params.table;
  if (!tables.has(table)) return reply.code(404).send({ error: "Unknown module" });
  const values = tableFields[table].filter((field) => request.body[field] !== undefined);
  if (!values.length) return reply.code(400).send({ error: "No valid fields supplied" });
  const result = db.prepare(`INSERT INTO ${table} (${values.join(",")}) VALUES (${values.map(() => "?").join(",")})`)
    .run(...values.map((field) => request.body[field] as never));
  return reply.code(201).send(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(result.lastInsertRowid));
});

app.put<{ Params: { table: string; id: string }; Body: Record<string, unknown> }>("/api/inventory/:table/:id", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const table = request.params.table;
  if (!tables.has(table)) return reply.code(404).send({ error: "Unknown module" });
  const values = tableFields[table].filter((field) => request.body[field] !== undefined);
  if (!values.length) return reply.code(400).send({ error: "No valid fields supplied" });
  db.prepare(`UPDATE ${table} SET ${values.map((f) => `${f}=?`).join(",")},updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(...values.map((field) => request.body[field] as never), request.params.id);
  return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(request.params.id);
});

app.delete<{ Params: { table: string; id: string } }>("/api/inventory/:table/:id", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  if (!tables.has(request.params.table)) return reply.code(404).send({ error: "Unknown module" });
  db.prepare(`DELETE FROM ${request.params.table} WHERE id=?`).run(request.params.id);
  return reply.code(204).send();
});

app.get("/api/cocktails/match", async () => {
  const stock = (db.prepare("SELECT name,brand,category,sub_category FROM spirits WHERE fill_level > 1").all() as Record<string,string>[])
    .flatMap((s) => Object.values(s).filter(Boolean).map((v) => v.toLowerCase()));
  const cocktails = db.prepare("SELECT * FROM cocktails ORDER BY name").all() as Array<Record<string, unknown>>;
  const common = ["sugar","syrup","lemon","lime","soda","water","salt","egg","mint"];
  return cocktails.map((cocktail) => {
    const ingredients = JSON.parse(cocktail.ingredients as string) as string[];
    const missing = ingredients.filter((ingredient) => {
      const normalized = ingredient.toLowerCase().replace(/^\d+(\.\d+)?\s*(ml|oz|tsp|dash(es)?)?\s*/,"");
      return !common.some((x) => normalized.includes(x)) && !stock.some((x) => normalized.includes(x) || x.includes(normalized.split(" ").at(-1) ?? normalized));
    });
    return { ...cocktail, ingredients, missing, readiness: missing.length === 0 ? "ready" : missing.length === 1 ? "almost" : "missing" };
  });
});

app.get<{ Params: { upc: string } }>("/api/scan/upc/:upc", async (request, reply) => {
  const local = db.prepare("SELECT * FROM spirits WHERE upc=?").get(request.params.upc);
  if (local) return { source: "vault", product: local };
  const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(request.params.upc)}.json`);
  if (!response.ok) return reply.code(404).send({ error: "Product not found" });
  const data = await response.json() as { status: number; product?: Record<string, unknown> };
  if (!data.status || !data.product) return reply.code(404).send({ error: "Product not found" });
  return { source: "openfoodfacts", product: data.product };
});

async function callLlm(prompt: string, image?: string) {
  const provider = getSetting("aiProvider") ?? "ollama";
  const key = getSetting("aiApiKey") ?? "";
  const baseUrl = getSetting("aiBaseUrl") ?? (provider === "ollama" ? "http://host.docker.internal:11434" : provider === "anthropic" ? "https://api.anthropic.com" : provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1");
  const model = getSetting("aiModel") ?? (provider === "ollama" ? "llama3.2-vision" : provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o-mini");
  if (provider === "anthropic") {
    const content: unknown[] = [{ type: "text", text: prompt }];
    if (image) content.unshift({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
    const response = await fetch(`${baseUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: "user", content }] }) });
    const data = await response.json() as { content?: Array<{ text: string }> };
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
  if (!response.ok) throw new Error(JSON.stringify(data.error ?? data));
  return data.message?.content ?? data.choices?.[0]?.message.content ?? "";
}

app.post<{ Body: { prompt?: string } }>("/api/ai/mixologist", async (request, reply) => {
  const inventory = db.prepare("SELECT name,brand,category,fill_level FROM spirits WHERE fill_level > 1").all();
  try {
    const result = await callLlm(`You are a concise expert mixologist. Available inventory: ${JSON.stringify(inventory)}. Request: ${request.body.prompt ?? "Create a cocktail"}. Return a name, exact recipe, method, glass, garnish, and one substitution.`);
    return { result };
  } catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : "AI request failed" }); }
});

app.post("/api/ai/vision", async (request, reply) => {
  const file = await request.file();
  if (!file) return reply.code(400).send({ error: "Image required" });
  try {
    const result = await callLlm('Read this bottle label. Return only JSON with keys "brand","name","category","abv".', (await file.toBuffer()).toString("base64"));
    return { result };
  } catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : "Vision request failed" }); }
});

app.get("/api/settings", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const rows = db.prepare("SELECT key,value,updated_at FROM settings WHERE key != 'pinHash'").all();
  return Object.fromEntries((rows as Array<{key:string;value:string}>).map((r) => [r.key, r.value]));
});

app.put<{ Body: Record<string, string> }>("/api/settings", async (request, reply) => {
  if (requireAdmin(request, reply)) return;
  const allowed = new Set(["theme","themeTokens","aiProvider","aiApiKey","aiBaseUrl","aiModel"]);
  for (const [key, value] of Object.entries(request.body)) if (allowed.has(key)) setSetting(key, String(value));
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

await app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" });
