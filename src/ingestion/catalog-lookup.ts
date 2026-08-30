/**
 * Existing-inventory and barcode/catalog lookup facades.
 * Implementations remain in lookup.ts; this module names the responsibility boundary.
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
