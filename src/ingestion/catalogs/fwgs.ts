import {
  ColaQuotaError,
  mapColaToSchema
} from "../../cola_client.js";
import { fwgsToSchema, isFwgsThin, searchFwgs, type FwgsProduct } from "../../fwgs.js";
import type { ImportKind, LookupResult } from "../../lookup-shared.js";
import type { ColaCatalogFn } from "./cola.js";
import { inferImportKind } from "./kind.js";
import { saveToCache } from "./cola-cache-store.js";
import { success, withLocalImage } from "./result.js";

export type FwgsCatalogFn = (upc: string) => Promise<FwgsProduct | null>;

export type FwgsStageResult = {
  hit: LookupResult | null;
  colaQueried: boolean;
  colaFound: boolean;
  quotaHit: boolean;
};

/**
 * Fine Wine & Good Spirits stage (spirits/wines path only).
 * Thin FWGS hits may enrich once from COLA without changing the source chip to COLA.
 */
export async function tryFwgsStage(options: {
  upc: string;
  kindHint?: ImportKind;
  waitOnBurst: boolean;
  searchFwgsFn?: FwgsCatalogFn;
  colaClient: ColaCatalogFn;
  colaEnabled: boolean;
}): Promise<FwgsStageResult> {
  let colaQueried = false;
  let colaFound = false;
  let quotaHit = false;

  try {
    const fwgsHit = await (options.searchFwgsFn ?? searchFwgs)(options.upc);
    if (!fwgsHit?.name.trim()) {
      return { hit: null, colaQueried, colaFound, quotaHit };
    }

    let product = fwgsToSchema(options.upc, fwgsHit);
    if (isFwgsThin(fwgsHit) && options.colaEnabled) {
      try {
        colaQueried = true;
        const summary = await options.colaClient(options.upc, options.waitOnBurst);
        if (summary) {
          colaFound = true;
          const colaProduct = mapColaToSchema(options.upc, summary);
          product = {
            ...product,
            brand: product.brand || colaProduct.brand,
            category: colaProduct.category || product.category,
            volume_ml: product.volume_ml ?? colaProduct.volume_ml,
            product_type: colaProduct.product_type ?? product.product_type,
            ttb_id: colaProduct.ttb_id,
            origin: colaProduct.origin ?? product.origin,
            approval_date: colaProduct.approval_date ?? product.approval_date,
            notes: [product.notes, colaProduct.notes].filter(Boolean).join(" | ") || product.notes
          };
        }
      } catch (error) {
        if (error instanceof ColaQuotaError) quotaHit = true;
      }
    }

    const localized = await withLocalImage(product);
    saveToCache(localized, null, null, "fwgs");
    const hit = await success("fwgs", options.upc, localized, inferImportKind(localized, options.kindHint));
    return { hit, colaQueried, colaFound, quotaHit };
  } catch {
    // FWGS is parse-resilient; a thrown error still falls through.
    return { hit: null, colaQueried, colaFound, quotaHit };
  }
}
