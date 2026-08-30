import {
  ColaQuotaError,
  ColaSummary,
  getColaDetail,
  isColaConfigured,
  isColaPaused,
  mapColaToSchema,
  searchByBarcode,
  type ProductSchema
} from "../../cola_client.js";
import type { ImportKind, LookupResult } from "../../lookup-shared.js";
import { saveToCache } from "./cola-cache-store.js";
import { miss, success, withLocalImage } from "./result.js";

export type ColaCatalogFn = (upc: string, waitOnBurst?: boolean) => Promise<ColaSummary | null>;

export function resolveColaClient(override?: ColaCatalogFn): {
  colaClient: ColaCatalogFn;
  colaEnabled: boolean;
} {
  const colaClient = override
    ?? ((code: string, wait?: boolean) => searchByBarcode(code, { waitOnBurst: wait }));
  const colaEnabled = Boolean(override) || (isColaConfigured() && !isColaPaused());
  return { colaClient, colaEnabled };
}

export async function trySpiritsColaStage(options: {
  upc: string;
  kindHint?: ImportKind;
  waitOnBurst: boolean;
  colaClient: ColaCatalogFn;
  colaEnabled: boolean;
}): Promise<{ hit: LookupResult | null; colaQueried: boolean; colaFound: boolean; quotaHit: boolean }> {
  let colaQueried = false;
  let colaFound = false;
  let quotaHit = false;

  if (!options.colaEnabled) {
    if (isColaConfigured() && isColaPaused()) quotaHit = true;
    return { hit: null, colaQueried, colaFound, quotaHit };
  }

  try {
    colaQueried = true;
    const summary = await options.colaClient(options.upc, options.waitOnBurst);
    if (summary && (summary.product_name || summary.brand_name)) {
      colaFound = true;
      const product = await withLocalImage(mapColaToSchema(options.upc, summary));
      saveToCache(product, summary, null, "cola_cloud");
      const hit = await success("cola_cloud", options.upc, product, options.kindHint);
      return { hit, colaQueried, colaFound, quotaHit };
    }
  } catch (error) {
    if (error instanceof ColaQuotaError) quotaHit = true;
  }

  return { hit: null, colaQueried, colaFound, quotaHit };
}

export async function tryBeerColaStage(options: {
  upc: string;
  kindHint?: ImportKind;
  waitOnBurst: boolean;
  colaClient: ColaCatalogFn;
  colaEnabled: boolean;
  persistBeer: (product: ProductSchema, source: string) => void;
}): Promise<{ hit: LookupResult | null; colaQueried: boolean; colaFound: boolean; quotaHit: boolean }> {
  let colaQueried = false;
  let colaFound = false;
  let quotaHit = false;

  if (!options.colaEnabled) {
    return { hit: null, colaQueried, colaFound, quotaHit };
  }

  try {
    colaQueried = true;
    const summary = await options.colaClient(options.upc, options.waitOnBurst);
    if (summary && (summary.product_name || summary.brand_name)) {
      colaFound = true;
      const product = await withLocalImage(mapColaToSchema(options.upc, summary));
      saveToCache(product, summary, null, "cola_cloud");
      options.persistBeer(product, "cola_cloud");
      const hit = await success("cola_cloud", options.upc, product, options.kindHint);
      return { hit, colaQueried, colaFound, quotaHit };
    }
  } catch (error) {
    if (error instanceof ColaQuotaError) quotaHit = true;
  }

  return { hit: null, colaQueried, colaFound, quotaHit };
}

export async function enrichColaRecord(ttbId: string, upc = ""): Promise<LookupResult> {
  const detail = await getColaDetail(ttbId);
  if (!detail) {
    return miss("cola_gap", upc);
  }
  const product = await withLocalImage(mapColaToSchema(upc || detail.barcodes?.[0]?.barcode_value || "", detail, detail));
  if (product.upc) saveToCache(product, detail, detail, "cola_cloud");
  return await success("cola_cloud", product.upc || upc, product);
}
