import { barcodeVariants, type ProductSchema } from "../../cola_client.js";
import {
  normalizeCanonicalTaxonomy,
  stripPackageTokensFromName
} from "../../canonical-normalize.js";

export type UpcItemDbEntry = {
  title?: string;
  brand?: string;
  category?: string;
  description?: string;
  upc?: string;
  ean?: string;
  images?: string[];
};

const NON_BEVERAGE_CATEGORY_RE =
  /\b(hardware|fasteners?|tools?|automotive|vehicles?|electronics|computers?|software|apparel|clothing|shoes|furniture|home\s*(?:&|and)\s*garden|lawn\s*(?:&|and)\s*garden|pet\s+supplies|toys?\s*(?:&|and)\s*games?|sporting\s+goods|office\s+supplies|health\s*(?:&|and)\s*beauty|cosmetics|personal\s+care|baby\s*(?:&|and)\s*toddler|arts?\s*(?:&|and)\s*entertainment|books?|cameras?|luggage|jewelry|plumbing|electrical|building\s+(?:materials|consumables)|industrial|scientific)\b/i;

const NON_BEVERAGE_TITLE_RE =
  /\b(hex\s+bolt|carriage\s+bolt|lag\s+bolt|anchor\s+bolt|eye\s+bolt|u-?bolt|flange\s+bolt|cap\s+screw|machine\s+screw|wood\s+screw|drywall\s+screw|lock\s+washer|flat\s+washer|fender\s+washer|hex\s+nut|wing\s+nut|rivet|gasket|spark\s+plug|brake\s+pad|oil\s+filter|light\s+bulb|extension\s+cord|power\s+drill|socket\s+wrench|drill\s+bit|saw\s+blade)\b/i;

const BAR_CATEGORY_SIGNAL_RE =
  /\b(beverages?|alcohol(?:ic)?|liquor|spirits?|wines?|beers?|ciders?|seltzers?|mixers?|cocktails?|bitters?|syrups?|sodas?|tonics?|juices?|drinks?)\b/i;

const BAR_TEXT_SIGNAL_RE =
  /\b(whisk(?:e)?y|bourbon|scotch|rye|vodka|gin|rum|tequila|mezcal|brandy|cognac|armagnac|calvados|pisco|liqueur|amaro|vermouth|aperitif|aperitivo|digestif|schnapps|absinthe|aquavit|sake|soju|shochu|cacha[cç]a|baijiu|grappa|ouzo|sambuca|bitters?|wine|champagne|prosecco|cava|cabernet|merlot|pinot|chardonnay|sauvignon|riesling|malbec|syrah|shiraz|zinfandel|ros[eé]|sherry|madeira|marsala|beer|ale|ipa|lager|pilsner|stout|porter|saison|k[oö]lsch|bock|hefeweizen|gose|cider|mead|seltzer|tonic|ginger\s+beer|ginger\s+ale|club\s+soda|grenadine|orgeat|syrup|mixer|cocktail|single\s+malt|single\s+barrel|small\s+batch|straight\s+bourbon|kentucky\s+straight|islay|distiller(?:y|ies)|distilling|brewing|brewery|winery|vineyard|cellars?|ch[aâ]teau|domaine|bodega|proof|abv|750\s*ml|375\s*ml|700\s*ml|1\.75\s*l)\b/i;

function returnedCodeMatches(queriedUpc: string, item: UpcItemDbEntry): boolean {
  const returned = [item.upc, item.ean]
    .map((value) => String(value ?? "").replace(/\D/g, ""))
    .filter(Boolean);
  if (!returned.length) return true;
  const expected = new Set(barcodeVariants(queriedUpc));
  return returned.some((code) => expected.has(code) || barcodeVariants(code).some((variant) => expected.has(variant)));
}

/**
 * General-merchandise barcode databases (like UPCitemdb) frequently contain
 * hardware, electronics, or misattributed rows. Only accept hits that show
 * positive beverage/bar evidence and are not in a non-beverage category.
 */
export function isPlausibleBarUpcItem(item: UpcItemDbEntry): boolean {
  const title = String(item.title ?? "").trim();
  if (!title) return false;
  const category = String(item.category ?? "").trim();
  const brand = String(item.brand ?? "").trim();
  const description = String(item.description ?? "").trim();

  if (category && NON_BEVERAGE_CATEGORY_RE.test(category) && !BAR_CATEGORY_SIGNAL_RE.test(category)) {
    return false;
  }

  const tax = normalizeCanonicalTaxonomy(category, "");
  const hasAlcoholSignal = Boolean(
    tax.productType
    || tax.family
    || BAR_CATEGORY_SIGNAL_RE.test(category)
    || BAR_TEXT_SIGNAL_RE.test(`${title} ${brand} ${description}`)
  );
  if (!hasAlcoholSignal) return false;

  if (NON_BEVERAGE_TITLE_RE.test(title) && !BAR_CATEGORY_SIGNAL_RE.test(category)) {
    return false;
  }

  return true;
}

export async function lookupUpcItemDb(upc: string): Promise<ProductSchema | null> {
  const response = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`, {
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) return null;
  const data = await response.json() as { items?: UpcItemDbEntry[] };
  const item = data.items?.[0];
  if (!item?.title) return null;
  if (!returnedCodeMatches(upc, item)) return null;
  if (!isPlausibleBarUpcItem(item)) return null;
  const tax = normalizeCanonicalTaxonomy(item.category ?? "", "");
  const nameRaw = item.title;
  return {
    upc,
    name: stripPackageTokensFromName(nameRaw) || nameRaw,
    brand: item.brand ?? "",
    category: tax.family || "",
    abv: null,
    image_url: item.images?.[0] ?? null,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: null,
    volume_ml: null,
    product_type: tax.productType,
    ttb_id: null,
    origin: null,
    approval_date: null
  };
}
