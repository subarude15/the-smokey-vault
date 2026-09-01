/**
 * Barcode catalog stages used by lookupProduct.
 *
 * Spirits/wines order:
 *   vault → barcode_cache → government(PA+Iowa) → cola_cache → FWGS → COLA → OFF → upcitemdb → miss
 *
 * Beer order (existing behavior preserved):
 *   vault → barcode_cache → beer_cache → cola_cache → OFF → upcitemdb → COLA → miss
 *   (FWGS and early COLA are skipped on the beer path.)
 */
export { findInVault } from "./vault.js";
export { tryBarcodeCache } from "./barcode-cache.js";
export { tryIowaStage } from "./iowa.js";
export { tryGovernmentStage } from "./government/lookup.js";
export { tryBeerCache, persistBeerHit } from "./beer-cache.js";
export { resolveColaCache, type ColaCacheResolution } from "./cola-cache.js";
export {
  ensureColaCacheTable,
  getFromCache,
  saveToCache,
  rememberUnresolvedUpc
} from "./cola-cache-store.js";
export { tryFwgsStage } from "./fwgs.js";
export {
  resolveColaClient,
  trySpiritsColaStage,
  tryBeerColaStage,
  enrichColaRecord,
  type ColaCatalogFn
} from "./cola.js";
export {
  mapOffToSchema,
  lookupOpenFoodFacts,
  searchOpenFoodFactsByQuery
} from "./open-food-facts.js";
export { lookupUpcItemDb } from "./upcitemdb.js";
export { tryOffThenUpcitemdb } from "./web-trail.js";
export {
  success,
  miss,
  withLocalImage,
  variantsFor,
  formatAmbiguous,
  placeholderProduct
} from "./result.js";
export { inferImportKind, tableForKind, inferTable } from "./kind.js";
