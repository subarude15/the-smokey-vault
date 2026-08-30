/**
 * Existing-inventory and barcode/catalog lookup facades.
 * Stage implementations live under src/ingestion/catalogs/; lookupProduct remains the public entrypoint.
 */
export {
  lookupProduct,
  searchBottles,
  searchVault,
  searchCatalogBeerSuggestions,
  type LookupOptions,
  type LookupCatalogs,
  type BottleSearchHit,
  type SearchTable
} from "../lookup.js";

export {
  findInVault,
  tryBarcodeCache,
  tryBeerCache,
  resolveColaCache,
  tryFwgsStage,
  trySpiritsColaStage,
  tryBeerColaStage,
  tryOffThenUpcitemdb,
  lookupOpenFoodFacts,
  lookupUpcItemDb
} from "./catalogs/index.js";
