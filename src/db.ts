import Database from "better-sqlite3";
import { mkdirSync, existsSync, copyFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DEFAULT_KEG_L, TAP_COUNT, migrateWineSweetnessValue, spiritFamilyFromLabel } from "./catalog.js";

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
  base_ingredient TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS packaged_beer (
  id INTEGER PRIMARY KEY AUTOINCREMENT, brewery TEXT DEFAULT '', name TEXT NOT NULL, style TEXT DEFAULT '',
  count INTEGER DEFAULT 1, pack_date TEXT, abv REAL DEFAULT 0, upc TEXT DEFAULT '', image_url TEXT DEFAULT '',
  notes TEXT DEFAULT '', tasting_notes TEXT DEFAULT '', flavors TEXT DEFAULT '[]', tags TEXT DEFAULT '[]',
  base_ingredient TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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
ensureColumn("packaged_beer", "upc", "ALTER TABLE packaged_beer ADD COLUMN upc TEXT DEFAULT ''");
ensureColumn("packaged_beer", "image_url", "ALTER TABLE packaged_beer ADD COLUMN image_url TEXT DEFAULT ''");
ensureColumn("packaged_beer", "notes", "ALTER TABLE packaged_beer ADD COLUMN notes TEXT DEFAULT ''");
ensureColumn("packaged_beer", "tasting_notes", "ALTER TABLE packaged_beer ADD COLUMN tasting_notes TEXT DEFAULT ''");
ensureColumn("packaged_beer", "flavors", "ALTER TABLE packaged_beer ADD COLUMN flavors TEXT DEFAULT '[]'");
ensureColumn("packaged_beer", "tags", "ALTER TABLE packaged_beer ADD COLUMN tags TEXT DEFAULT '[]'");
ensureColumn("packaged_beer", "base_ingredient", "ALTER TABLE packaged_beer ADD COLUMN base_ingredient TEXT DEFAULT ''");
ensureColumn("wines", "upc", "ALTER TABLE wines ADD COLUMN upc TEXT DEFAULT ''");
ensureColumn("wines", "image_url", "ALTER TABLE wines ADD COLUMN image_url TEXT DEFAULT ''");
ensureColumn("wines", "tasting_notes", "ALTER TABLE wines ADD COLUMN tasting_notes TEXT DEFAULT ''");
ensureColumn("wines", "flavors", "ALTER TABLE wines ADD COLUMN flavors TEXT DEFAULT '[]'");
ensureColumn("wines", "tags", "ALTER TABLE wines ADD COLUMN tags TEXT DEFAULT '[]'");
ensureColumn("wines", "base_ingredient", "ALTER TABLE wines ADD COLUMN base_ingredient TEXT DEFAULT ''");
ensureColumn("wines", "style", "ALTER TABLE wines ADD COLUMN style TEXT DEFAULT ''");
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
ensureColumn("cocktails", "season", "ALTER TABLE cocktails ADD COLUMN season TEXT DEFAULT 'All'");
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
if (!getSetting("lastBackupDownload")) setSetting("lastBackupDownload", new Date().toISOString());

type Season = "All" | "Spring" | "Summer" | "Fall" | "Winter" | "Holiday";
type Cocktail = { name: string; ingredients: string[]; glassware?: string; garnish?: string; method?: string; collection?: string; season?: Season };
const classics: Cocktail[] = [
  { name: "Old Fashioned", ingredients: ["45 ml bourbon or rye", "1 sugar cube", "2 dashes Angostura bitters"], glassware: "Rocks", garnish: "Orange twist", method: "Stir", season: "Fall" },
  { name: "Dry Martini", ingredients: ["60 ml gin", "10 ml dry vermouth"], garnish: "Lemon twist or olive", method: "Stir" },
  { name: "Margarita", ingredients: ["50 ml tequila", "20 ml triple sec", "15 ml lime juice"], glassware: "Margarita", garnish: "Salt rim", method: "Shake", season: "Summer" },
  { name: "Daiquiri", ingredients: ["60 ml white rum", "20 ml lime juice", "2 tsp sugar"], garnish: "Lime wheel", method: "Shake", season: "Summer" },
  { name: "Manhattan", ingredients: ["50 ml rye whiskey", "20 ml sweet vermouth", "1 dash bitters"], garnish: "Cherry", method: "Stir", season: "Winter" },
  { name: "Negroni", ingredients: ["30 ml gin", "30 ml Campari", "30 ml sweet vermouth"], glassware: "Rocks", garnish: "Orange peel", method: "Stir" },
  { name: "Whiskey Sour", ingredients: ["45 ml bourbon", "25 ml lemon juice", "20 ml sugar syrup", "egg white"], glassware: "Rocks", garnish: "Cherry", method: "Shake" },
  { name: "Mojito", ingredients: ["45 ml white rum", "20 ml lime juice", "6 mint sprigs", "soda water", "2 tsp sugar"], glassware: "Highball", garnish: "Mint", method: "Build", season: "Summer" },
  { name: "Moscow Mule", ingredients: ["45 ml vodka", "10 ml lime juice", "ginger beer"], glassware: "Mug", garnish: "Lime", method: "Build", season: "Fall" },
  { name: "French 75", ingredients: ["30 ml gin", "15 ml lemon juice", "15 ml sugar syrup", "60 ml Champagne"], glassware: "Flute", garnish: "Lemon twist", method: "Shake and top", season: "Spring" },
  { name: "Espresso Martini", ingredients: ["50 ml vodka", "30 ml coffee liqueur", "10 ml sugar syrup", "espresso"], garnish: "Coffee beans", method: "Shake", season: "Holiday" },
  { name: "Mai Tai", ingredients: ["30 ml amber rum", "30 ml Martinique rum", "15 ml orange curaçao", "15 ml orgeat", "30 ml lime juice"], glassware: "Rocks", garnish: "Mint", method: "Shake", season: "Summer" },
  { name: "Tom Collins", ingredients: ["45 ml gin", "30 ml lemon juice", "15 ml sugar syrup", "60 ml soda water"], glassware: "Collins", garnish: "Lemon", method: "Shake and top", season: "Spring" },
  { name: "Sidecar", ingredients: ["50 ml cognac", "20 ml triple sec", "20 ml lemon juice"], garnish: "Orange twist", method: "Shake" },
  { name: "Boulevardier", ingredients: ["45 ml bourbon", "30 ml Campari", "30 ml sweet vermouth"], glassware: "Rocks", garnish: "Orange twist", method: "Stir", season: "Winter" },
  { name: "Aperol Spritz", ingredients: ["90 ml prosecco", "60 ml Aperol", "30 ml soda water"], glassware: "Wine", garnish: "Orange slice", method: "Build", season: "Summer" },
  { name: "Gimlet", ingredients: ["60 ml gin", "30 ml lime cordial"], garnish: "Lime wheel", method: "Shake", season: "Spring" },
  { name: "Sazerac", ingredients: ["50 ml cognac or rye", "10 ml absinthe", "1 sugar cube", "2 dashes Peychaud's bitters"], glassware: "Rocks", garnish: "Lemon peel", method: "Stir", season: "Winter" },
  { name: "Pisco Sour", ingredients: ["60 ml pisco", "30 ml lemon juice", "20 ml sugar syrup", "egg white"], garnish: "Bitters", method: "Shake" },
  { name: "Paloma", ingredients: ["50 ml tequila", "5 ml lime juice", "grapefruit soda", "salt"], glassware: "Highball", garnish: "Lime", method: "Build" }
];
const moreNames = [
  "Alexander","Americano","Angel Face","Aviation","Between the Sheets","Black Russian","Bloody Mary","Bramble",
  "Brandy Crusta","Caipirinha","Canchanchara","Cardinale","Casino","Champagne Cocktail","Clover Club","Corpse Reviver #2",
  "Cosmopolitan","Cuba Libre","Dark 'n' Stormy","Derby","Dirty Martini","Don's Special Daiquiri","Fernandito",
  "French Connection","Garibaldi","Gin Fizz","God Father","God Mother","Golden Dream","Grasshopper","Hanky Panky",
  "Harvey Wallbanger","Hemingway Special","Horse's Neck","Illegal","Irish Coffee","John Collins","Jungle Bird",
  "Kir","Last Word","Lemon Drop Martini","Long Island Iced Tea","Martinez","Mary Pickford","Mimosa","Mint Julep",
  "Missionary's Downfall","Monkey Gland","Naked and Famous","New York Sour","Old Cuban","Paradise","Penicillin",
  "Piña Colada","Planter's Punch","Porto Flip","Ramos Fizz","Remember the Maine","Russian Spring Punch","Rusty Nail",
  "Sea Breeze","Sex on the Beach","Sherry Cobbler","Singapore Sling","South Side","Spicy Fifty","Spritz Veneziano",
  "Stinger","Suffering Bastard","Tequila Sunrise","Three Dots and a Dash","Tipperary","Tommy's Margarita","Trinidad Sour",
  "Tuxedo","Vampiro","Vesper","Vieux Carré","Vodka Martini","White Lady","White Russian","Yellow Bird","Zombie",
  "Paper Plane","Bee's Knees","Gold Rush","Navy Grog","Painkiller","Saturn","Rum Old Fashioned","Mezcal Negroni",
  "Maple Old Fashioned","Cranberry Mule","Apple Cider Sour","Hot Toddy","Coquito","Kentucky Buck","Basil Smash"
];

function seasonFor(name: string): Season {
  if (/Coquito|Cranberry|Champagne Cocktail|Alexander|Golden Dream|White Russian/.test(name)) return "Holiday";
  if (/Maple|Apple Cider|Paper Plane|Kentucky Buck|New York Sour|Gold Rush/.test(name)) return "Fall";
  if (/Piña Colada|Painkiller|Jungle Bird|Sea Breeze|Tequila Sunrise|Zombie|Cuba Libre|Navy Grog|Saturn/.test(name)) return "Summer";
  if (/Bee's Knees|Basil Smash|Bramble|Clover Club|Aviation|Mimosa|South Side|Gin Fizz/.test(name)) return "Spring";
  if (/Hot Toddy|Irish Coffee|Penicillin|Rusty Nail|Vieux Carré|God Father|Porto Flip/.test(name)) return "Winter";
  return "All";
}

const insertCocktail = db.prepare("INSERT OR IGNORE INTO cocktails(name,collection,ingredients,glassware,garnish,method,season) VALUES(?,?,?,?,?,?,?)");
const updateSeason = db.prepare("UPDATE cocktails SET season=? WHERE name=?");
const seed = db.transaction(() => {
  for (const c of classics) {
    const season = c.season ?? seasonFor(c.name);
    insertCocktail.run(c.name, c.collection ?? "IBA Classics", JSON.stringify(c.ingredients), c.glassware ?? "Coupe", c.garnish ?? "", c.method ?? "Shake", season);
    if (season !== "All") updateSeason.run(season, c.name);
  }
  for (const name of moreNames) {
    const seasonal = /Maple|Cranberry|Apple|Hot|Coquito/.test(name);
    const season = seasonFor(name);
    insertCocktail.run(name, seasonal ? "Seasonal" : "IBA & Modern Classics", JSON.stringify(["45 ml base spirit", "22 ml citrus or modifier", "15 ml sweetener"]), "Coupe", "Seasonal garnish", "Shake", season);
    if (season !== "All") updateSeason.run(season, name);
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
