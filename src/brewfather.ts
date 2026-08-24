import { prepareBrewWrite, type BrewStatus } from "./catalog.js";
import { db, getSetting, setSetting } from "./db.js";
import { localizeImage } from "./images.js";

export const BREWFATHER_API_BASE = "https://api.brewfather.app/v2";
export const BREWFATHER_SYNC_TTL_MS = 5 * 60_000;
const BATCH_PAGE_SIZE = 50;
const INCLUDE_FIELDS = [
  "measuredOg",
  "measuredFg",
  "estimatedOg",
  "estimatedFg",
  "measuredAbv",
  "img_url",
  "recipe.style",
  "recipe.hops",
  "recipe.og",
  "recipe.fg",
  "recipe.abv",
  "recipe.name"
].join(",");

export type BrewfatherHop = { name?: string | null };
export type BrewfatherStyle = { name?: string | null };
export type BrewfatherRecipe = {
  name?: string | null;
  og?: number | null;
  fg?: number | null;
  abv?: number | null;
  img_url?: string | null;
  style?: BrewfatherStyle | null;
  hops?: BrewfatherHop[] | null;
};
export type BrewfatherBatch = {
  _id?: string | null;
  name?: string | null;
  batchNo?: number | null;
  status?: string | null;
  brewer?: string | null;
  hidden?: boolean | null;
  brewDate?: number | string | null;
  img_url?: string | null;
  measuredOg?: number | null;
  measuredFg?: number | null;
  estimatedOg?: number | null;
  estimatedFg?: number | null;
  measuredAbv?: number | null;
  recipe?: BrewfatherRecipe | null;
  batchHops?: BrewfatherHop[] | null;
  batchHopsLocal?: BrewfatherHop[] | null;
};

export type BrewSyncResult = {
  configured: boolean;
  skipped: boolean;
  inserted: number;
  updated: number;
  lastSync: string | null;
};

export class BrewfatherError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.statusCode = statusCode;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json" | "headers">>;

export function getBrewfatherCredentials() {
  return {
    userId: process.env.BREWFATHER_USER_ID?.trim() || "",
    apiKey: process.env.BREWFATHER_API_KEY?.trim() || ""
  };
}

export function isBrewfatherConfigured() {
  const { userId, apiKey } = getBrewfatherCredentials();
  return Boolean(userId && apiKey);
}

export function brewfatherLastSync() {
  return getSetting("brewfatherLastSync") || null;
}

export function mapBrewfatherStatus(status: unknown): BrewStatus {
  const raw = String(status ?? "").trim().toLowerCase();
  if (raw === "planning") return "Planned";
  if (raw === "brewing" || raw === "fermenting") return "Fermenting";
  if (raw === "conditioning") return "Conditioning";
  if (raw === "completed") return "Ready to Keg";
  if (raw === "archived") return "Archived";
  return "Planned";
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function brewDateIso(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString().slice(0, 10);
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return "";
}

function hopNames(batch: BrewfatherBatch): string[] {
  const lists = [batch.recipe?.hops, batch.batchHops, batch.batchHopsLocal];
  const names: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const hop of list) {
      const name = text(hop?.name);
      if (name) names.push(name);
    }
  }
  return names;
}

function fallbackAbv(batch: BrewfatherBatch): number | null {
  const measured = Number(batch.measuredAbv);
  if (Number.isFinite(measured) && measured > 0) return Math.round(measured * 10) / 10;
  const recipe = Number(batch.recipe?.abv);
  if (Number.isFinite(recipe) && recipe > 0) return Math.round(recipe * 10) / 10;
  return null;
}

export function mapBrewfatherBatch(batch: BrewfatherBatch): Record<string, unknown> {
  const brewfatherId = text(batch._id);
  const batchName = text(batch.name) || text(batch.recipe?.name) || (batch.batchNo != null ? `Batch ${batch.batchNo}` : "Untitled batch");
  const mapped: Record<string, unknown> = {
    brewfather_id: brewfatherId,
    batch_name: batchName,
    maker: text(batch.brewer),
    style: text(batch.recipe?.style?.name),
    brew_date: brewDateIso(batch.brewDate) || null,
    status: mapBrewfatherStatus(batch.status),
    target_og: batch.estimatedOg ?? batch.recipe?.og ?? null,
    target_fg: batch.estimatedFg ?? batch.recipe?.fg ?? null,
    measured_og: batch.measuredOg ?? null,
    measured_fg: batch.measuredFg ?? null,
    hops: hopNames(batch),
    image_url: text(batch.img_url) || text(batch.recipe?.img_url)
  };
  return mapped;
}

const UPSERT_FIELDS = [
  "batch_name",
  "style",
  "brew_date",
  "target_og",
  "target_fg",
  "measured_og",
  "measured_fg",
  "calculated_abv",
  "status",
  "maker",
  "image_url",
  "hops",
  "brewfather_id"
];

export function upsertMappedBrew(mapped: Record<string, unknown>): { action: "inserted" | "updated"; id: number } {
  const brewfatherId = text(mapped.brewfather_id);
  if (!brewfatherId) throw new Error("brewfather_id required");
  const existing = db.prepare("SELECT * FROM brews WHERE brewfather_id=?").get(brewfatherId) as Record<string, unknown> | undefined;
  const body = prepareBrewWrite({ ...mapped, brewfather_id: brewfatherId }, existing);
  if (body.calculated_abv == null || Number(body.calculated_abv) <= 0) {
    const abv = Number(mapped.calculated_abv);
    if (Number.isFinite(abv) && abv > 0) body.calculated_abv = abv;
  }
  if (existing && !text(body.image_url)) delete body.image_url;
  const fields = UPSERT_FIELDS.filter((field) => body[field] !== undefined);
  if (existing) {
    db.prepare(`UPDATE brews SET ${fields.map((field) => `${field}=?`).join(",")},updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(...fields.map((field) => body[field] as never), existing.id);
    return { action: "updated", id: Number(existing.id) };
  }
  const result = db.prepare(`INSERT INTO brews (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`)
    .run(...fields.map((field) => body[field] as never));
  return { action: "inserted", id: Number(result.lastInsertRowid) };
}

export async function fetchBrewfatherBatches(fetcher: FetchLike = fetch): Promise<BrewfatherBatch[]> {
  const { userId, apiKey } = getBrewfatherCredentials();
  if (!userId || !apiKey) throw new BrewfatherError("Brewfather is not configured", 400);
  const auth = Buffer.from(`${userId}:${apiKey}`).toString("base64");
  const batches: BrewfatherBatch[] = [];
  let startAfter = "";
  for (;;) {
    const url = new URL(`${BREWFATHER_API_BASE}/batches`);
    url.searchParams.set("complete", "false");
    url.searchParams.set("include", INCLUDE_FIELDS);
    url.searchParams.set("limit", String(BATCH_PAGE_SIZE));
    if (startAfter) url.searchParams.set("start_after", startAfter);
    const response = await fetcher(url.toString(), {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" }
    });
    if (response.status === 429) {
      throw new BrewfatherError("Brewfather rate limit reached. Try again in a few minutes.", 429);
    }
    if (response.status === 401 || response.status === 403) {
      throw new BrewfatherError("Brewfather rejected the credentials. Check BREWFATHER_USER_ID and BREWFATHER_API_KEY.", 502);
    }
    if (!response.ok) {
      throw new BrewfatherError("Could not read batches from Brewfather", 502);
    }
    const page = await response.json() as unknown;
    const rows = Array.isArray(page) ? page as BrewfatherBatch[] : [];
    batches.push(...rows);
    if (rows.length < BATCH_PAGE_SIZE) break;
    const lastId = text(rows[rows.length - 1]?._id);
    if (!lastId || lastId === startAfter) break;
    startAfter = lastId;
  }
  return batches;
}

function recentlySynced() {
  const last = Date.parse(brewfatherLastSync() ?? "");
  return Number.isFinite(last) && Date.now() - last < BREWFATHER_SYNC_TTL_MS;
}

export async function syncBrews(options: { force?: boolean; fetcher?: FetchLike } = {}): Promise<BrewSyncResult> {
  const lastSync = brewfatherLastSync();
  if (!isBrewfatherConfigured()) {
    return { configured: false, skipped: true, inserted: 0, updated: 0, lastSync };
  }
  if (!options.force && recentlySynced()) {
    return { configured: true, skipped: true, inserted: 0, updated: 0, lastSync };
  }
  const batches = await fetchBrewfatherBatches(options.fetcher);
  let inserted = 0;
  let updated = 0;
  for (const batch of batches) {
    if (batch.hidden) continue;
    if (!text(batch._id)) continue;
    const mapped = mapBrewfatherBatch(batch);
    const abv = fallbackAbv(batch);
    if (abv != null) mapped.calculated_abv = abv;
    if (text(mapped.image_url)) {
      mapped.image_url = await localizeImage(String(mapped.image_url)) ?? mapped.image_url;
    }
    const result = upsertMappedBrew(mapped);
    if (result.action === "inserted") inserted += 1;
    else updated += 1;
  }
  const syncedAt = new Date().toISOString();
  setSetting("brewfatherLastSync", syncedAt);
  return { configured: true, skipped: false, inserted, updated, lastSync: syncedAt };
}
