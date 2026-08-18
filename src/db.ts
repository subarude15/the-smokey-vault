import Database from "better-sqlite3";
import { mkdirSync, existsSync, copyFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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
  image_url TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS taps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tap_number INTEGER NOT NULL UNIQUE, keg_size_l REAL DEFAULT 19,
  source_type TEXT DEFAULT 'Commercial', brewery_batch TEXT NOT NULL, style TEXT DEFAULT '', abv REAL DEFAULT 0,
  ibu REAL DEFAULT 0, tapped_date TEXT, remaining_l REAL DEFAULT 19, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS brews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_name TEXT NOT NULL, style TEXT DEFAULT '', brew_date TEXT,
  target_og REAL, target_fg REAL, measured_og REAL, measured_fg REAL, calculated_abv REAL DEFAULT 0,
  schedule TEXT DEFAULT '', status TEXT DEFAULT 'Planned', notes TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS packaged_beer (
  id INTEGER PRIMARY KEY AUTOINCREMENT, brewery TEXT DEFAULT '', name TEXT NOT NULL, style TEXT DEFAULT '',
  count INTEGER DEFAULT 0, pack_date TEXT, abv REAL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS wines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, producer TEXT DEFAULT '', name TEXT NOT NULL, varietal TEXT DEFAULT '',
  vintage INTEGER, type TEXT DEFAULT 'Red', region TEXT DEFAULT '', sweetness INTEGER DEFAULT 3, body INTEGER DEFAULT 3,
  bottle_count INTEGER DEFAULT 1, drink_by_date TEXT, pairings TEXT DEFAULT '', notes TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cocktails (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, collection TEXT DEFAULT 'IBA Classics',
  ingredients TEXT NOT NULL, glassware TEXT DEFAULT 'Coupe', garnish TEXT DEFAULT '', method TEXT DEFAULT 'Shake',
  notes TEXT DEFAULT ''
);
`;
db.exec(schema);

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

type Cocktail = { name: string; ingredients: string[]; glassware?: string; garnish?: string; method?: string; collection?: string };
const classics: Cocktail[] = [
  { name: "Old Fashioned", ingredients: ["45 ml bourbon or rye", "1 sugar cube", "2 dashes Angostura bitters"], glassware: "Rocks", garnish: "Orange twist", method: "Stir" },
  { name: "Dry Martini", ingredients: ["60 ml gin", "10 ml dry vermouth"], garnish: "Lemon twist or olive", method: "Stir" },
  { name: "Margarita", ingredients: ["50 ml tequila", "20 ml triple sec", "15 ml lime juice"], glassware: "Margarita", garnish: "Salt rim", method: "Shake" },
  { name: "Daiquiri", ingredients: ["60 ml white rum", "20 ml lime juice", "2 tsp sugar"], garnish: "Lime wheel", method: "Shake" },
  { name: "Manhattan", ingredients: ["50 ml rye whiskey", "20 ml sweet vermouth", "1 dash bitters"], garnish: "Cherry", method: "Stir" },
  { name: "Negroni", ingredients: ["30 ml gin", "30 ml Campari", "30 ml sweet vermouth"], glassware: "Rocks", garnish: "Orange peel", method: "Stir" },
  { name: "Whiskey Sour", ingredients: ["45 ml bourbon", "25 ml lemon juice", "20 ml sugar syrup", "egg white"], glassware: "Rocks", garnish: "Cherry", method: "Shake" },
  { name: "Mojito", ingredients: ["45 ml white rum", "20 ml lime juice", "6 mint sprigs", "soda water", "2 tsp sugar"], glassware: "Highball", garnish: "Mint", method: "Build" },
  { name: "Moscow Mule", ingredients: ["45 ml vodka", "10 ml lime juice", "ginger beer"], glassware: "Mug", garnish: "Lime", method: "Build" },
  { name: "French 75", ingredients: ["30 ml gin", "15 ml lemon juice", "15 ml sugar syrup", "60 ml Champagne"], glassware: "Flute", garnish: "Lemon twist", method: "Shake and top" },
  { name: "Espresso Martini", ingredients: ["50 ml vodka", "30 ml coffee liqueur", "10 ml sugar syrup", "espresso"], garnish: "Coffee beans", method: "Shake" },
  { name: "Mai Tai", ingredients: ["30 ml amber rum", "30 ml Martinique rum", "15 ml orange curaçao", "15 ml orgeat", "30 ml lime juice"], glassware: "Rocks", garnish: "Mint", method: "Shake" },
  { name: "Tom Collins", ingredients: ["45 ml gin", "30 ml lemon juice", "15 ml sugar syrup", "60 ml soda water"], glassware: "Collins", garnish: "Lemon", method: "Shake and top" },
  { name: "Sidecar", ingredients: ["50 ml cognac", "20 ml triple sec", "20 ml lemon juice"], garnish: "Orange twist", method: "Shake" },
  { name: "Boulevardier", ingredients: ["45 ml bourbon", "30 ml Campari", "30 ml sweet vermouth"], glassware: "Rocks", garnish: "Orange twist", method: "Stir" },
  { name: "Aperol Spritz", ingredients: ["90 ml prosecco", "60 ml Aperol", "30 ml soda water"], glassware: "Wine", garnish: "Orange slice", method: "Build" },
  { name: "Gimlet", ingredients: ["60 ml gin", "30 ml lime cordial"], garnish: "Lime wheel", method: "Shake" },
  { name: "Sazerac", ingredients: ["50 ml cognac or rye", "10 ml absinthe", "1 sugar cube", "2 dashes Peychaud's bitters"], glassware: "Rocks", garnish: "Lemon peel", method: "Stir" },
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

const insertCocktail = db.prepare("INSERT OR IGNORE INTO cocktails(name,collection,ingredients,glassware,garnish,method) VALUES(?,?,?,?,?,?)");
const seed = db.transaction(() => {
  for (const c of classics) insertCocktail.run(c.name, c.collection ?? "IBA Classics", JSON.stringify(c.ingredients), c.glassware ?? "Coupe", c.garnish ?? "", c.method ?? "Shake");
  for (const name of moreNames) {
    const seasonal = /Maple|Cranberry|Apple|Hot|Coquito/.test(name);
    insertCocktail.run(name, seasonal ? "Seasonal" : "IBA & Modern Classics", JSON.stringify(["45 ml base spirit", "22 ml citrus or modifier", "15 ml sweetener"]), "Coupe", "Seasonal garnish", "Shake");
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
