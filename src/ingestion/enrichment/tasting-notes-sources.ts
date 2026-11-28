/**
 * Deterministic classification of web hits for official tasting-note sourcing.
 * Retailer / UGC / blog copy must never become "official" producer notes.
 */
export type SourceClass =
  | "official"
  | "regulatory"
  | "importer"
  | "retailer"
  | "ugc"
  | "unknown";

export type ClassifiedHit = {
  title: string;
  content: string;
  url: string;
  sourceClass: SourceClass;
};

/** Host fragments that are never treated as producer/official copy. */
const RETAILER_HOST_FRAGMENTS = [
  "totalwine",
  "wine.com",
  "wine-searcher",
  "winesearcher",
  "drizly",
  "reservebar",
  "amazon.",
  "walmart.",
  "target.com",
  "costco.",
  "bevmo.",
  "specsonline",
  "astorwines",
  "klwines",
  "thewhiskyexchange",
  "masterofmalt",
  "caskers",
  "flaviar",
  "seelbachs",
  "reservebar",
  "saucey",
  "minibar",
  "gopuff",
  "instacart",
  "ebay.",
  "etsy.",
  "shopify.com"
] as const;

const UGC_HOST_FRAGMENTS = [
  "reddit.com",
  "quora.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "tiktok.com",
  "instagram.com",
  "medium.com",
  "blogspot.",
  "wordpress.com",
  "tumblr.com",
  "substack.com",
  "wikipedia.org",
  "untappd.com",
  "ratebeer.com",
  "beeradvocate.com",
  "vivino.com",
  "cellartracker.com",
  "distiller.com",
  "whiskyadvocate.com",
  "breakingbourbon.com",
  "bourbonr",
  "reddit."
] as const;

/** Government / regulatory hosts for COLA / TTB-style evidence. */
const REGULATORY_HOST_FRAGMENTS = [
  "ttb.gov",
  "alcoholtobacco",
  "fda.gov",
  "gov.uk",
  "canada.ca",
  "gc.ca",
  "europa.eu",
  "colacloud"
] as const;

const IMPORTER_HINTS = [
  "importer",
  "importing",
  "distributor",
  "distribution",
  "agency"
] as const;

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "");
}

function brandTokens(brand: string): string[] {
  return brand
    .toLowerCase()
    .split(/[\s,/|&-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .map(normalizeToken)
    .filter(Boolean);
}

function hostMatchesFragment(host: string, fragments: readonly string[]): boolean {
  return fragments.some((frag) => host.includes(frag));
}

function parseHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * True when a brand token appears as a host label (thebalvenie.com, shop.thebalvenie.com).
 * Host-based only — never invents Scotch from brand fame alone.
 */
export function hostLooksLikeBrandDomain(host: string, brand: string): boolean {
  const tokens = brandTokens(brand);
  if (!tokens.length) return false;
  const hostNorm = normalizeToken(host);
  const labels = host.toLowerCase().split(".").filter(Boolean);
  return tokens.some((token) => {
    if (token.length < 4) return false;
    if (hostNorm.includes(token)) return true;
    return labels.some(
      (label) => normalizeToken(label) === token || normalizeToken(label).includes(token)
    );
  });
}

const GENERIC_PRODUCT_TOKENS = new Set([
  "bourbon", "whiskey", "whisky", "scotch", "vodka", "tequila", "mezcal",
  "rum", "gin", "brandy", "cognac", "wine", "beer", "lager", "ale", "ipa",
  "stout", "pilsner", "porter", "cider", "seltzer", "liqueur", "single",
  "malt", "straight", "small", "batch", "reserve", "barrel", "proof", "cask",
  "strength", "year", "years", "aged", "distillery", "distilling", "brewery",
  "brewing", "winery", "vineyard", "vineyards", "cellars", "spirits", "spirit",
  "liquor", "bottle", "edition", "limited", "special", "original", "classic",
  "double", "triple", "black", "white", "gold", "silver", "blue", "green",
  "red", "extra", "grand", "royal", "kentucky", "tennessee", "irish",
  "japanese", "rye", "wheated", "sour", "mash", "spiced", "anejo", "reposado",
  "blanco", "cabernet", "merlot", "pinot", "chardonnay", "sauvignon",
  "riesling", "prosecco", "champagne", "brut", "rose", "dry", "sweet", "the"
]);

/**
 * Conservative match for parent-company bottles (e.g. brand="Sazerac", name="Eagle Rare 10 Year"
 * matching eaglerare.com) while never matching generic category domains like bourbon.com.
 */
function hostLooksLikeProductDomain(host: string, name: string): boolean {
  const tokens = name
    .toLowerCase()
    .split(/[\s,/|&-]+/)
    .map(normalizeToken)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !GENERIC_PRODUCT_TOKENS.has(t));
  if (!tokens.length) return false;
  const hostNorm = normalizeToken(host);
  // Check adjacent distinctive 2-word pairs (e.g. "eagle" + "rare" -> "eaglerare")
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const pair = `${tokens[i]}${tokens[i + 1]}`;
    if (pair.length >= 7 && hostNorm.includes(pair)) return true;
  }
  // Or a single distinctive token of length >= 6 (e.g. "lagavulin", "ardbeg", "blantons")
  return tokens.some((token) => token.length >= 6 && hostNorm.includes(token));
}

/**
 * Classify a hit URL using brand/product identity.
 * Prefer null official notes over mis-attributing retailer/blog copy.
 */
export function classifySourceUrl(
  url: string,
  options: { brand?: string | null; name?: string | null } = {}
): SourceClass {
  const host = parseHost(url);
  if (!host) return "unknown";

  if (hostMatchesFragment(host, RETAILER_HOST_FRAGMENTS)) return "retailer";
  if (hostMatchesFragment(host, UGC_HOST_FRAGMENTS)) return "ugc";
  if (hostMatchesFragment(host, REGULATORY_HOST_FRAGMENTS)) return "regulatory";

  const brand = String(options.brand ?? "").trim();
  if (brand && hostLooksLikeBrandDomain(host, brand)) {
    return "official";
  }

  const name = String(options.name ?? "").trim();
  if (name && hostLooksLikeProductDomain(host, name)) {
    return "official";
  }

  const pathAndHost = `${host} ${url}`.toLowerCase();
  if (IMPORTER_HINTS.some((hint) => pathAndHost.includes(hint))) {
    return "importer";
  }

  return "unknown";
}

export function classifyHit(
  hit: { title: string; content: string; url: string },
  options: { brand?: string | null; name?: string | null }
): ClassifiedHit {
  return {
    ...hit,
    sourceClass: classifySourceUrl(hit.url, options)
  };
}

export function isAuthoritativeSource(sourceClass: SourceClass): boolean {
  return sourceClass === "official" || sourceClass === "importer" || sourceClass === "regulatory";
}

/** Format authoritative hits for LLM extraction (includes URL for attribution). */
export function formatAuthoritativeSnippets(hits: ClassifiedHit[]): string {
  return hits
    .filter((h) => isAuthoritativeSource(h.sourceClass))
    .map((h, i) => {
      const title = h.title.trim();
      const content = h.content.trim();
      return `${i + 1}. [${h.sourceClass}] ${title}\nURL: ${h.url}\n${content}`;
    })
    .filter((block) => block.includes("URL:"))
    .join("\n\n");
}
