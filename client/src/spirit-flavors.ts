/**
 * Client re-export of shared Bottle Library flavor helpers (PR152 / PR156).
 * Source of truth lives in `src/spirit-flavors.ts` so the server can attach
 * derived `display_flavors` without inventing a second vocabulary.
 */
export {
  CANONICAL_FLAVOR_LABELS,
  flavorSearchAliases,
  normalizeFlavorProse,
  deriveSpiritFlavors,
  resolveSpiritDisplayFlavors,
  spiritFlavorFacetOptions,
  coerceSpiritFlavorSelection,
  type SpiritFlavorSource
} from "../../src/spirit-flavors";
