import Database from "better-sqlite3";
import { mkdirSync, existsSync, copyFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DEFAULT_KEG_L, TAP_COUNT, migrateWineSweetnessValue, packagedBeerRowLooksLikeSpirit, spiritFamilyFromLabel } from "./catalog.js";
import { isPlaceholderIngredients } from "./cocktails.js";
import { COCKTAIL_RECIPES } from "./cocktail-recipes.js";
import {
  DEFAULT_BAR_LOCATION_TEXT, DEFAULT_ENABLED_TABS_JSON, DEFAULT_HOUSE_TIP_BLURB, DEFAULT_TAB_ORDER_JSON
} from "./speakeasy-shared.js";

export const dbPath = process.env.DB_PATH ?? (process.env.NODE_ENV === "production" ? "/data/smokeyvault.db" : "./data/smokeyvault.db");
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schema = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS spirits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, brand TEXT DEFAULT '', category TEXT NOT NULL,
  sub_category TEXT DEFAULT '', abv REAL DEFAULT 0, volume_ml REAL DEFAULT 750, fill_level REAL DEFAULT 100,
  purchase_date TEXT, opened_date TEXT, shelf_location TEXT DEFAULT '', upc TEXT DEFAULT '', notes TEXT DEFAULT '',
  image_url TEXT DEFAULT '', stock_count INTEGER DEFAULT 1, tasting_notes TEXT DEFAULT '', flavors TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]', base_ingredient TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS taps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tap_number INTEGER NOT NULL UNIQUE, keg_size_l REAL DEFAULT 19,
  source_type TEXT DEFAULT 'Commercial', brewery_batch TEXT NOT NULL, style TEXT DEFAULT '', abv REAL DEFAULT 0,
  ibu REAL DEFAULT 0, tapped_date TEXT, remaining_l REAL DEFAULT 19, maker TEXT DEFAULT '', notes TEXT DEFAULT '',
  image_url TEXT DEFAULT '', tasting_notes TEXT DEFAULT '', flavors TEXT DEFAULT '[]', tags TEXT DEFAULT '[]',
  base_ingredient TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS brews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_name TEXT NOT NULL, style TEXT DEFAULT '', brew_date TEXT,
  target_og REAL, target_fg REAL, measured_og REAL, measured_fg REAL, calculated_abv REAL DEFAULT 0,
  schedule TEXT DEFAULT '', status TEXT DEFAULT 'Planned', notes TEXT DEFAULT '', maker TEXT DEFAULT '',
  image_url TEXT DEFAULT '', tasting_notes TEXT DEFAULT '', flavors TEXT DEFAULT '[]', tags TEXT DEFAULT '[]',
  base_ingredient TEXT DEFAULT '', hops TEXT DEFAULT '[]', brewfather_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS packaged_beer (
  id INTEGER PRIMARY KEY AUTOINCREMENT, brewery TEXT DEFAULT '', name TEXT NOT NULL, style TEXT DEFAULT '',
  count INTEGER DEFAULT 1, pack_date TEXT, abv REAL DEFAULT 0, upc TEXT DEFAULT '', image_url TEXT DEFAULT '',
  notes TEXT DEFAULT '', tasting_notes TEXT DEFAULT '', flavors TEXT DEFAULT '[]', tags TEXT DEFAULT '[]',
  base_ingredient TEXT DEFAULT '', vessel TEXT DEFAULT 'Can', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS wines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, producer TEXT DEFAULT '', name TEXT NOT NULL, varietal TEXT DEFAULT '',
  vintage INTEGER, type TEXT DEFAULT 'Red', style TEXT DEFAULT '', region TEXT DEFAULT '', sweetness TEXT DEFAULT 'Dry', body INTEGER DEFAULT 3,
  bottle_count INTEGER DEFAULT 1, drink_by_date TEXT, pairings TEXT DEFAULT '', notes TEXT DEFAULT '',
  upc TEXT DEFAULT '', image_url TEXT DEFAULT '', tasting_notes TEXT DEFAULT '', flavors TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]', base_ingredient TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cocktails (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, collection TEXT DEFAULT 'IBA Classics',
  ingredients TEXT NOT NULL, glassware TEXT DEFAULT 'Coupe', garnish TEXT DEFAULT '', method TEXT DEFAULT 'Shake',
  notes TEXT DEFAULT '', season TEXT DEFAULT 'All'
);
CREATE TABLE IF NOT EXISTS cola_cache (
  upc TEXT PRIMARY KEY,
  name TEXT,
  brand TEXT,
  category TEXT,
  abv REAL,
  image_url TEXT,
  fill_level_percent INTEGER DEFAULT 100,
  bottle_count INTEGER DEFAULT 1,
  notes TEXT,
  volume_ml REAL,
  product_type TEXT,
  ttb_id TEXT,
  origin TEXT,
  approval_date TEXT,
  cached_at INTEGER,
  source TEXT DEFAULT 'cola_cloud'
);
CREATE TABLE IF NOT EXISTS barcode_cache (
  upc TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT DEFAULT '',
  abv REAL DEFAULT 0,
  proof REAL DEFAULT 0,
  volume_ml INTEGER DEFAULT 750,
  description TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  source TEXT DEFAULT 'imported',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS patrons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  nickname TEXT DEFAULT '',
  visit_count INTEGER NOT NULL DEFAULT 1,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_patrons_ranking ON patrons(visit_count DESC, updated_at ASC);
CREATE TABLE IF NOT EXISTS daily_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_table TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  patron_name TEXT NOT NULL,
  vote_date TEXT NOT NULL,
  value INTEGER NOT NULL CHECK(value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(target_table, item_id, patron_name, vote_date)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_name TEXT NOT NULL,
  contact_info TEXT NOT NULL,
  body TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  discord_notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(is_read, created_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  description TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  is_published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS event_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_info TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS merch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  suggested_donation TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  is_available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS staff_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  display_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_staff_order ON staff_members(display_order ASC, id ASC);
CREATE TABLE IF NOT EXISTS gallery_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('image', 'video')),
  caption TEXT DEFAULT '',
  uploaded_by TEXT DEFAULT 'Patron',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_gallery_recent ON gallery_media(created_at DESC, id DESC);
`;
db.exec(schema);

function ensureColumn(table: string, column: string, ddl: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) db.exec(ddl);
}

ensureColumn("spirits", "stock_count", "ALTER TABLE spirits ADD COLUMN stock_count INTEGER DEFAULT 1");
ensureColumn("spirits", "tasting_notes", "ALTER TABLE spirits ADD COLUMN tasting_notes TEXT DEFAULT ''");
ensureColumn("spirits", "flavors", "ALTER TABLE spirits ADD COLUMN flavors TEXT DEFAULT '[]'");
ensureColumn("spirits", "tags", "ALTER TABLE spirits ADD COLUMN tags TEXT DEFAULT '[]'");
ensureColumn("spirits", "base_ingredient", "ALTER TABLE spirits ADD COLUMN base_ingredient TEXT DEFAULT ''");
ensureColumn("spirits", "blocked_from_ordering", "ALTER TABLE spirits ADD COLUMN blocked_from_ordering INTEGER NOT NULL DEFAULT 0");
ensureColumn("packaged_beer", "upc", "ALTER TABLE packaged_beer ADD COLUMN upc TEXT DEFAULT ''");
ensureColumn("packaged_beer", "image_url", "ALTER TABLE packaged_beer ADD COLUMN image_url TEXT DEFAULT ''");
ensureColumn("packaged_beer", "notes", "ALTER TABLE packaged_beer ADD COLUMN notes TEXT DEFAULT ''");
ensureColumn("packaged_beer", "tasting_notes", "ALTER TABLE packaged_beer ADD COLUMN tasting_notes TEXT DEFAULT ''");
ensureColumn("packaged_beer", "flavors", "ALTER TABLE packaged_beer ADD COLUMN flavors TEXT DEFAULT '[]'");
ensureColumn("packaged_beer", "tags", "ALTER TABLE packaged_beer ADD COLUMN tags TEXT DEFAULT '[]'");
ensureColumn("packaged_beer", "base_ingredient", "ALTER TABLE packaged_beer ADD COLUMN base_ingredient TEXT DEFAULT ''");
ensureColumn("packaged_beer", "vessel", "ALTER TABLE packaged_beer ADD COLUMN vessel TEXT DEFAULT 'Can'");
ensureColumn("wines", "upc", "ALTER TABLE wines ADD COLUMN upc TEXT DEFAULT ''");
ensureColumn("wines", "image_url", "ALTER TABLE wines ADD COLUMN image_url TEXT DEFAULT ''");
ensureColumn("wines", "tasting_notes", "ALTER TABLE wines ADD COLUMN tasting_notes TEXT DEFAULT ''");
ensureColumn("wines", "flavors", "ALTER TABLE wines ADD COLUMN flavors TEXT DEFAULT '[]'");
ensureColumn("wines", "tags", "ALTER TABLE wines ADD COLUMN tags TEXT DEFAULT '[]'");
ensureColumn("wines", "base_ingredient", "ALTER TABLE wines ADD COLUMN base_ingredient TEXT DEFAULT ''");
ensureColumn("wines", "style", "ALTER TABLE wines ADD COLUMN style TEXT DEFAULT ''");
ensureColumn("wines", "body", "ALTER TABLE wines ADD COLUMN body INTEGER DEFAULT 3");
ensureColumn("wines", "drink_by_date", "ALTER TABLE wines ADD COLUMN drink_by_date TEXT");
ensureColumn("wines", "blocked_from_ordering", "ALTER TABLE wines ADD COLUMN blocked_from_ordering INTEGER NOT NULL DEFAULT 0");
// Indexed after the migrations above, since older databases add `upc` by ALTER TABLE.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_spirits_upc ON spirits(upc);
  CREATE INDEX IF NOT EXISTS idx_packaged_beer_upc ON packaged_beer(upc);
  CREATE INDEX IF NOT EXISTS idx_wines_upc ON wines(upc);
`);

ensureColumn("taps", "maker", "ALTER TABLE taps ADD COLUMN maker TEXT DEFAULT ''");
ensureColumn("taps", "image_url", "ALTER TABLE taps ADD COLUMN image_url TEXT DEFAULT ''");
ensureColumn("taps", "notes", "ALTER TABLE taps ADD COLUMN notes TEXT DEFAULT ''");
ensureColumn("taps", "tasting_notes", "ALTER TABLE taps ADD COLUMN tasting_notes TEXT DEFAULT ''");
ensureColumn("taps", "flavors", "ALTER TABLE taps ADD COLUMN flavors TEXT DEFAULT '[]'");
ensureColumn("taps", "tags", "ALTER TABLE taps ADD COLUMN tags TEXT DEFAULT '[]'");
ensureColumn("taps", "base_ingredient", "ALTER TABLE taps ADD COLUMN base_ingredient TEXT DEFAULT ''");
ensureColumn("brews", "maker", "ALTER TABLE brews ADD COLUMN maker TEXT DEFAULT ''");
ensureColumn("brews", "image_url", "ALTER TABLE brews ADD COLUMN image_url TEXT DEFAULT ''");
ensureColumn("brews", "tasting_notes", "ALTER TABLE brews ADD COLUMN tasting_notes TEXT DEFAULT ''");
ensureColumn("brews", "flavors", "ALTER TABLE brews ADD COLUMN flavors TEXT DEFAULT '[]'");
ensureColumn("brews", "tags", "ALTER TABLE brews ADD COLUMN tags TEXT DEFAULT '[]'");
ensureColumn("brews", "base_ingredient", "ALTER TABLE brews ADD COLUMN base_ingredient TEXT DEFAULT ''");
ensureColumn("brews", "hops", "ALTER TABLE brews ADD COLUMN hops TEXT DEFAULT '[]'");
ensureColumn("brews", "brewfather_id", "ALTER TABLE brews ADD COLUMN brewfather_id TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS brews_brewfather_id ON brews(brewfather_id) WHERE brewfather_id IS NOT NULL AND brewfather_id != ''");
ensureColumn("cocktails", "season", "ALTER TABLE cocktails ADD COLUMN season TEXT DEFAULT 'All'");
ensureColumn("cocktails", "image_url", "ALTER TABLE cocktails ADD COLUMN image_url TEXT DEFAULT ''");
ensureColumn("cocktails", "source_url", "ALTER TABLE cocktails ADD COLUMN source_url TEXT DEFAULT ''");
ensureColumn("cocktails", "bartender_fav", "ALTER TABLE cocktails ADD COLUMN bartender_fav INTEGER DEFAULT 0");
ensureColumn("cola_cache", "volume_ml", "ALTER TABLE cola_cache ADD COLUMN volume_ml REAL");
ensureColumn("cola_cache", "product_type", "ALTER TABLE cola_cache ADD COLUMN product_type TEXT");

const migrateWhiskey = db.prepare("UPDATE spirits SET category=?, sub_category=? WHERE id=?");
const whiskeyRows = db.prepare("SELECT id, category, sub_category FROM spirits").all() as Array<{ id: number; category: string; sub_category: string }>;
for (const row of whiskeyRows) {
  const mapped = spiritFamilyFromLabel(row.category ?? "", row.sub_category ?? "");
  if (mapped.family === "Whiskey" && row.category !== "Whiskey") {
    migrateWhiskey.run(mapped.family, mapped.type || row.sub_category || "", row.id);
  }
}

const migrateWineSweetness = db.prepare("UPDATE wines SET sweetness=? WHERE id=?");
const wineRows = db.prepare("SELECT id, type, style, sweetness FROM wines").all() as Array<{
  id: number; type: string; style: string | null; sweetness: unknown;
}>;
for (const row of wineRows) {
  const next = migrateWineSweetnessValue(row.sweetness, row.type, row.style);
  if (String(row.sweetness ?? "") !== next) migrateWineSweetness.run(next, row.id);
}

const moveSpiritFromBeer = db.transaction((row: {
  id: number; name: string; brewery?: string; style?: string; abv?: number; upc?: string;
  image_url?: string; notes?: string; count?: number; tags?: string; flavors?: string;
  tasting_notes?: string; base_ingredient?: string;
}) => {
  const mapped = spiritFamilyFromLabel(String(row.style ?? ""), "");
  db.prepare(`
    INSERT INTO spirits(
      name, brand, category, sub_category, abv, upc, image_url, notes, stock_count,
      tags, flavors, tasting_notes, base_ingredient
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.name,
    row.brewery ?? "",
    mapped.family,
    mapped.type,
    row.abv ?? 0,
    row.upc ?? "",
    row.image_url ?? "",
    row.notes ?? "",
    row.count ?? 1,
    row.tags ?? "[]",
    row.flavors ?? "[]",
    row.tasting_notes ?? "",
    row.base_ingredient ?? ""
  );
  db.prepare("DELETE FROM packaged_beer WHERE id=?").run(row.id);
});

const misfiledBeerRows = db.prepare("SELECT * FROM packaged_beer").all() as Array<{
  id: number; name: string; brewery?: string; style?: string; abv?: number; upc?: string;
  image_url?: string; notes?: string; count?: number; tags?: string; flavors?: string;
  tasting_notes?: string; base_ingredient?: string;
}>;
let movedSpirits = 0;
for (const row of misfiledBeerRows) {
  if (packagedBeerRowLooksLikeSpirit(row)) {
    moveSpiritFromBeer(row);
    movedSpirits += 1;
  }
}
if (movedSpirits > 0) {
  console.log(`Migrated ${movedSpirits} misfiled spirit(s) from packaged_beer to spirits`);
}

const insertEmptyTap = db.prepare(
  "INSERT OR IGNORE INTO taps(tap_number, brewery_batch, keg_size_l, remaining_l, source_type) VALUES(?, '', ?, 0, 'Commercial')"
);
for (let n = 1; n <= TAP_COUNT; n++) insertEmptyTap.run(n, DEFAULT_KEG_L);

function hashPin(pin: string, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(pin, salt, 64).toString("hex")}`;
}

export function verifyPin(pin: string) {
  const stored = getSetting("pinHash");
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  return timingSafeEqual(Buffer.from(hash, "hex"), scryptSync(pin, salt, 64));
}

export function setPin(pin: string) {
  setSetting("pinHash", hashPin(pin));
}

export function getSetting(key: string) {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function setSetting(key: string, value: string) {
  db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).run(key, value);
}

if (!getSetting("pinHash")) setPin(process.env.DEFAULT_PIN ?? "1234");
if (!getSetting("theme")) setSetting("theme", "dark");
if (!getSetting("keeperName")) setSetting("keeperName", "Nick");
if (!getSetting("lastBackupDownload")) setSetting("lastBackupDownload", new Date().toISOString());
if (!getSetting("restockPackagedBelow")) setSetting("restockPackagedBelow", "3");
if (!getSetting("restockSpiritFill")) setSetting("restockSpiritFill", "25");
if (!getSetting("restockWineBelow")) setSetting("restockWineBelow", "2");
if (!getSetting("enabled_tabs")) setSetting("enabled_tabs", DEFAULT_ENABLED_TABS_JSON);
if (!getSetting("tab_order")) setSetting("tab_order", DEFAULT_TAB_ORDER_JSON);
if (getSetting("bar_location_text") === undefined) setSetting("bar_location_text", DEFAULT_BAR_LOCATION_TEXT);
if (getSetting("house_tip_blurb") === undefined) setSetting("house_tip_blurb", DEFAULT_HOUSE_TIP_BLURB);
if (getSetting("guest_bartender_enabled") === undefined) setSetting("guest_bartender_enabled", "0");
if (getSetting("discord_webhook_url") === undefined) setSetting("discord_webhook_url", "");
if (getSetting("facebook_group_url") === undefined) setSetting("facebook_group_url", "");

const insertCocktail = db.prepare("INSERT OR IGNORE INTO cocktails(name,collection,ingredients,glassware,garnish,method,notes,season) VALUES(?,?,?,?,?,?,?,?)");
const updatePlaceholder = db.prepare("UPDATE cocktails SET collection=?,ingredients=?,glassware=?,garnish=?,method=?,notes=?,season=? WHERE id=?");
const seed = db.transaction(() => {
  for (const recipe of COCKTAIL_RECIPES) {
    insertCocktail.run(
      recipe.name, recipe.collection, JSON.stringify(recipe.ingredients),
      recipe.glassware, recipe.garnish, recipe.method, recipe.notes, recipe.season
    );
  }
  const rows = db.prepare("SELECT id, name, collection, ingredients FROM cocktails").all() as Array<{
    id: number; name: string; collection: string; ingredients: string;
  }>;
  const byName = new Map(COCKTAIL_RECIPES.map((recipe) => [recipe.name, recipe]));
  for (const row of rows) {
    if (row.collection === "Custom Cocktails") continue;
    const recipe = byName.get(row.name);
    if (!recipe || !isPlaceholderIngredients(row.ingredients)) continue;
    updatePlaceholder.run(
      recipe.collection, JSON.stringify(recipe.ingredients), recipe.glassware,
      recipe.garnish, recipe.method, recipe.notes, recipe.season, row.id
    );
  }
});
seed();

export function createBackup() {
  const dir = join(dirname(dbPath), "backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(dir, `smokeyvault-${stamp}.db`);
  db.pragma("wal_checkpoint(TRUNCATE)");
  copyFileSync(dbPath, target);
  for (const file of readdirSync(dir)) {
    const full = join(dir, file);
    if (Date.now() - statSync(full).mtimeMs > 30 * 86400000) unlinkSync(full);
  }
  setSetting("lastAutomatedBackup", new Date().toISOString());
  return target;
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
