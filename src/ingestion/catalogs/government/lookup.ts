/**
 * Runtime government catalog lookup (PA PLCB + Iowa together).
 * Uses compact SQLite only — never Excel/CSV at scan time.
 */
import type { ProductSchema } from "../../../cola_client.js";
import { primaryCatalogUpc, normalizeUpc } from "../../../cola_client.js";
import type { ImportKind, LookupResult, LookupSource } from "../../../lookup-shared.js";
import { inferImportKind } from "../kind.js";
import { success, withLocalImage } from "../result.js";
import { tryIowaStage, type IowaCatalogFn } from "../iowa.js";
import { normalizeGovernmentBarcode } from "./barcode.js";
import { openGovernmentDb, getGovernmentDbPath } from "./schema.js";
import { rankGovernmentHits, type RankableHit } from "./rank.js";
import type {
  CatalogProductRecord,
  GovernmentDataset,
  GovernmentLookupResult
} from "./types.js";

export type GovernmentStageResult = {
  hit: LookupResult | null;
  lookup: GovernmentLookupResult;
};


export type GovernmentLookupLog = {
  info: (fields: Record<string, unknown>, message: string) => void;
};

const MAX_LOGGED_UPC = 32;

function boundUpcForLog(upc: string): string {
  const text = String(upc ?? "").trim();
  if (text.length <= MAX_LOGGED_UPC) return text;
  return `${text.slice(0, MAX_LOGGED_UPC)}…`;
}

/** Bounded structured log for government lookup outcomes (no catalog payloads). */
const defaultGovernmentLookupLog: GovernmentLookupLog = {
  info(fields, message) {
    console.info(JSON.stringify({ level: "info", msg: message, ...fields }));
  }
};

export function logGovernmentLookupOutcome(
  logger: GovernmentLookupLog | undefined,
  upc: string,
  lookup: GovernmentLookupResult
): void {
  const sink = logger ?? defaultGovernmentLookupLog;
  const winner = lookup.winner;
  sink.info(
    {
      event: "government_catalog_lookup",
      status: lookup.status,
      upc: boundUpcForLog(upc),
      source: winner?.dataset ?? null,
      candidateCount: Math.min(lookup.candidates.length, 12)
    },
    "Government catalog lookup"
  );
}


function mapProductRow(row: Record<string, unknown>): CatalogProductRecord {
  return {
    id: Number(row.id),
    sourceId: Number(row.source_id),
    sourceItemId: row.source_item_id == null ? null : String(row.source_item_id),
    domain: (row.domain as CatalogProductRecord["domain"]) ?? "spirit",
    name: String(row.name ?? ""),
    brand: row.brand == null ? null : String(row.brand),
    volumeMl: row.volume_ml == null ? null : Number(row.volume_ml),
    volumeRaw: row.volume_raw == null ? null : String(row.volume_raw),
    casePack: row.case_pack == null ? null : Number(row.case_pack),
    proof: row.proof == null ? null : Number(row.proof),
    abvPercent: row.abv_percent == null ? null : Number(row.abv_percent),
    abvDerivation: row.abv_derivation == null ? null : String(row.abv_derivation),
    vintageYear: row.vintage_year == null ? null : Number(row.vintage_year),
    vintageStatus: row.vintage_status == null ? null : String(row.vintage_status),
    country: row.country == null ? null : String(row.country),
    regionRaw: row.region_raw == null ? null : String(row.region_raw),
    sourceDivision: row.source_division == null ? null : String(row.source_division),
    sourceGroup: row.source_group == null ? null : String(row.source_group),
    sourceClass: row.source_class == null ? null : String(row.source_class),
    normalizedFamily: row.normalized_family == null ? null : String(row.normalized_family),
    normalizedSubcategory:
      row.normalized_subcategory == null ? null : String(row.normalized_subcategory),
    sourceExtractedAt: row.source_extracted_at == null ? null : String(row.source_extracted_at),
    qualityFlagsJson: row.quality_flags_json == null ? null : String(row.quality_flags_json),
    isCurrent: Number(row.is_current ?? 0)
  };
}

function lookupSourceForDataset(dataset: GovernmentDataset): LookupSource {
  if (dataset === "plcb_spirits") return "plcb_spirits";
  if (dataset === "plcb_wines") return "plcb_wines";
  return "iowa";
}

export function governmentProductToSchema(
  lookupUpc: string,
  product: CatalogProductRecord,
  matchedCodeRaw: string | null
): ProductSchema {
  const upc =
    primaryCatalogUpc(matchedCodeRaw ?? "") ||
    normalizeUpc(matchedCodeRaw ?? "") ||
    primaryCatalogUpc(lookupUpc) ||
    normalizeUpc(lookupUpc);

  const category =
    product.normalizedFamily ||
    product.sourceGroup ||
    (product.domain === "wine" ? "Wine" : "Spirits");

  return {
    upc: upc || lookupUpc,
    name: product.name || "Unknown",
    brand: product.brand ?? "",
    category,
    abv: product.abvPercent,
    image_url: null,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: [
      product.proof != null ? `Gov proof: ${product.proof}` : "",
      product.country ? `Origin: ${product.country}` : "",
      product.regionRaw ? `Region: ${product.regionRaw}` : "",
      product.sourceItemId ? `Source item: ${product.sourceItemId}` : "",
      matchedCodeRaw ? `Matched code: ${matchedCodeRaw}` : ""
    ]
      .filter(Boolean)
      .join(" | ") || null,
    volume_ml: product.volumeMl,
    product_type: product.domain === "wine" ? "wine" : "spirit",
    ttb_id: null,
    origin: product.country,
    approval_date: null,
    proof: product.proof
  };
}

export function searchGovernmentByBarcode(
  upc: string,
  options: { dbPath?: string } = {}
): GovernmentLookupResult {
  const code = primaryCatalogUpc(upc) || normalizeUpc(upc) || String(upc ?? "").trim();
  if (!code) return { status: "miss", candidates: [], winner: null };

  const norm = normalizeGovernmentBarcode(code);
  const keys = new Set<string>();
  if (norm.comparisonKey) keys.add(norm.comparisonKey);
  if (norm.codeNormalized) keys.add(norm.codeNormalized);
  if (norm.digits) keys.add(norm.digits);
  keys.add(code);
  const stripped = code.replace(/^0+/, "");
  if (stripped) keys.add(stripped);
  keys.add(code.padStart(12, "0").slice(-12));
  keys.add(code.padStart(13, "0").slice(-13));

  const db = openGovernmentDb(options.dbPath ?? getGovernmentDbPath());
  const keyList = [...keys].filter(Boolean);
  if (!keyList.length) return { status: "miss", candidates: [], winner: null };

  const placeholders = keyList.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
      SELECT
        p.*,
        s.dataset AS dataset,
        s.is_current AS source_is_current,
        s.extracted_at AS source_extracted_at,
        c.code_raw AS matched_code_raw,
        c.code_normalized AS matched_code_normalized
      FROM catalog_product_codes c
      JOIN catalog_products p ON p.id = c.product_id
      JOIN catalog_sources s ON s.id = p.source_id
      WHERE
        c.code_raw IN (${placeholders})
        OR c.code_normalized IN (${placeholders})
        OR c.comparison_key IN (${placeholders})
      ORDER BY s.is_current DESC, p.is_current DESC, p.id ASC
    `
    )
    .all(...keyList, ...keyList, ...keyList) as Array<Record<string, unknown>>;

  const byProduct = new Map<number, RankableHit>();
  for (const row of rows) {
    const product = mapProductRow(row);
    const dataset = String(row.dataset) as GovernmentDataset;
    const matchedCodeRaw = row.matched_code_raw == null ? null : String(row.matched_code_raw);
    const matchedCodeNormalized =
      row.matched_code_normalized == null ? null : String(row.matched_code_normalized);
    const exactRawMatch = Boolean(
      matchedCodeRaw && (matchedCodeRaw === code || matchedCodeRaw === norm.codeRaw)
    );
    const existing = byProduct.get(product.id);
    if (!existing || (exactRawMatch && !existing.exactRawMatch)) {
      byProduct.set(product.id, {
        product,
        dataset,
        matchedCodeRaw,
        matchedCodeNormalized,
        exactRawMatch,
        isCurrent: Number(row.source_is_current ?? product.isCurrent) === 1,
        extractedAt:
          row.source_extracted_at == null ? product.sourceExtractedAt : String(row.source_extracted_at)
      });
    }
  }

  return rankGovernmentHits([...byProduct.values()]);
}

export async function tryGovernmentStage(options: {
  upc: string;
  kindHint?: ImportKind;
  dbPath?: string;
  searchIowaFn?: IowaCatalogFn;
  logger?: GovernmentLookupLog;
}): Promise<GovernmentStageResult> {
  try {
    const lookup = searchGovernmentByBarcode(options.upc, { dbPath: options.dbPath });
    logGovernmentLookupOutcome(options.logger, options.upc, lookup);
    if (lookup.status === "hit" && lookup.winner) {
      const schema = governmentProductToSchema(
        options.upc,
        lookup.winner.product,
        lookup.winner.matchedCodeRaw
      );
      const localized = await withLocalImage(schema);
      const source = lookupSourceForDataset(lookup.winner.dataset);
      const hit = await success(
        source,
        options.upc,
        localized,
        inferImportKind(localized, options.kindHint)
      );
      return { hit, lookup };
    }

    if (lookup.status === "ambiguous") {
      // Do not guess — leave for review / later stages.
      return { hit: null, lookup };
    }

    // Transition fallback: injectable/legacy Iowa when government DB misses.
    if (options.searchIowaFn) {
      const iowa = await tryIowaStage({
        upc: options.upc,
        kindHint: options.kindHint,
        searchIowaFn: options.searchIowaFn
      });
      return { hit: iowa.hit, lookup };
    }

    return { hit: null, lookup };
  } catch {
    const lookup: GovernmentLookupResult = { status: "miss", candidates: [], winner: null };
    logGovernmentLookupOutcome(options.logger, options.upc, lookup);
    return {
      hit: null,
      lookup
    };
  }
}
