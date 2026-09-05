export const SPIRIT_FAMILIES = [
  "Whiskey", "Gin", "Rum", "Tequila", "Mezcal", "Vodka", "Cognac", "Brandy",
  "Amaro", "Liqueur", "Bitters", "Mixer"
];

export const SPIRIT_TYPES: Record<string, string[]> = {
  Whiskey: ["Bourbon", "Rye", "Scotch Whisky", "Scotch", "Irish", "Corn whiskey", "Tennessee", "Canadian", "Japanese", "Blended", "Wheat whiskey"],
  Gin: ["London Dry", "Old Tom", "Contemporary", "Plymouth", "Navy Strength"],
  Rum: ["White", "Gold", "Dark", "Spiced", "Agricole", "Overproof"],
  Tequila: ["Blanco", "Reposado", "Añejo", "Extra Añejo", "Cristalino"],
  Mezcal: ["Joven", "Reposado", "Añejo"],
  Vodka: ["Neutral", "Potato", "Wheat", "Flavored"],
  Cognac: ["VS", "VSOP", "XO"],
  Brandy: ["American", "Armagnac", "Calvados", "Pisco"],
  Amaro: ["Bitter", "Alpine", "Fernet"],
  Liqueur: ["Orange", "Herbal", "Coffee", "Cream", "Fruit"],
  Bitters: ["Aromatic", "Orange", "Celery", "Chocolate"],
  Mixer: ["Soda", "Juice", "Syrup", "Tonic", "Vermouth"]
};

export const BEER_STYLES = [
  "IPA", "Double IPA", "Pale Ale", "Lager", "Pilsner", "Sour", "Gose", "Berliner Weisse",
  "Stout", "Porter", "Wheat", "Hefeweizen", "Belgian", "Saison", "Amber", "Brown",
  "Barleywine", "Kölsch", "Bock", "Cider", "Seltzer", "Other"
];

export const BASE_INGREDIENTS = [
  "Barley", "Corn", "Rye", "Wheat", "Oats", "Rice", "Agave", "Molasses",
  "Cane", "Grapes", "Potatoes", "Fruit", "Other"
];

export const FLAVOR_OPTIONS = [
  "Peat", "Smoke", "Vanilla", "Oak", "Caramel", "Honey", "Spice", "Pepper",
  "Cinnamon", "Citrus", "Apple", "Cherry", "Dark fruit", "Dried fruit",
  "Tropical", "Floral", "Nutty", "Chocolate", "Coffee", "Malt", "Bread",
  "Roast", "Tart", "Funk", "Pine", "Earth", "Mineral", "Leather", "Brine"
];

export const HOP_OPTIONS = [
  "Citra", "Mosaic", "Simcoe", "Cascade", "Centennial", "Columbus", "Chinook", "Amarillo",
  "Galaxy", "Nelson Sauvin", "El Dorado", "Strata", "Sabro", "Azacca", "Idaho 7", "Motueka",
  "Hallertau", "Saaz", "Magnum", "Warrior", "Fuggle", "East Kent Goldings", "Willamette",
  "Nugget", "Crystal", "Riwaka", "Nectaron", "Cashmere", "Bru-1", "Ekuanot"
];

export const BREW_FLAVOR_OPTIONS = [
  "Citrus", "Grapefruit", "Pine", "Tropical", "Stone fruit", "Melon", "Floral",
  "Resin", "Malt", "Biscuit", "Dough", "Caramel", "Honey", "Chocolate", "Coffee",
  "Roast", "Banana", "Clove", "Tart", "Funk"
];

export {
  parseList, parseTagInput, serializeList,
  WINE_FAMILIES, SPARKLING_STYLES, BEER_VESSELS, PACK_COUNT_STOPS, FILL_STOPS, KEG_SIZES, KEG_REMAINING_STOPS, DEFAULT_KEG_L, TAP_COUNT,
  BREW_STATUSES, ACTIVE_BREW_STATUSES,
  defaultSweetnessForWine, inferProductTable, inferWineFamilyAndStyle, isSparklingWine,
  migrateWineSweetnessValue, wineKindLabel, wineSweetnessStops,
  kegFillPercent, kegSizeLabel, nearestKegStop, pintsRemaining, pourPint, remainingFromPercent, brewToTap,
  emptyTapBeerFields, firstEmptyTapNumber, isTapEmpty, tapTitle,
  brewAbv, compareBrews, formatAbv, formatGravity, nextBrewStatus, normalizeBrewStatus,
  onTapLabel, parseGravity, tapsForBatch, brewDisplayName,
  compareBottleCollectionByName, comparePackagedBeer, drinkOnePackaged, normalizeBeerVessel, packagedCount, packagedStockLabel,
  compareSpirits, fillStopLabel, isSpiritEmpty, nearestFillStop, openNextSpirit, pourSpirit,
  spiritStock, spiritStockLabel, spiritFamilyFromLabel, wineBodyLabel, wineBodyValue, wineDrinkByOverdue, WINE_BODY_STOPS
} from "../../src/catalog";

export {
  displayCanonicalFamily,
  displayCanonicalType,
  stripPackageTokensFromName,
  normalizeCanonicalAbv,
  normalizeCanonicalVolumeMl,
  normalizeCanonicalTaxonomy
} from "../../src/canonical-normalize";

export {
  SEASONS, collectionGroup, compareCocktails, currentSeason, findRecipesForBottle, guestSafeRecipe, moduleSupportsFindDrink, recipeIngredientMatchesBottle, shelfBottleFromItem, shelfKindForModule
} from "../../src/cocktails";
export type { IngredientLine } from "../../src/cocktails";
export {
  parseTastingProfile,
  selectGuestEnrichedTastingText,
  stripTastingBoilerplate
} from "../../src/tasting-profile";
export type { TastingProfile } from "../../src/tasting-profile";
export { overviewGreeting, overviewHeroCopy } from "../../src/overview";
export type { OverviewSnapshot, OverviewPour } from "../../src/overview";
export {
  type RestockKind,
  type WantedLabel,
  type RestockThresholds,
  type RestockItem,
  MAX_WANTED_NAME,
  MAX_WANTED_NOTE,
  DEFAULT_RESTOCK_THRESHOLDS,
  RESTOCK_PACKAGED_STOPS,
  RESTOCK_WINE_STOPS,
  RESTOCK_SPIRIT_STOPS,
  parseRestockThresholds,
  formatRestockShare,
  type NextBoard,
  type NextBoards,
  type NextItem,
  type NextKind,
  MAX_NEXT_MAKER,
  MAX_NEXT_NAME,
  MAX_NEXT_NOTE,
  DEFAULT_KEEPER_NAME,
  MAX_KEEPER_NAME,
  clipKeeperName
} from "../../src/shared-types";
export { extractSharedRecipeUrl } from "../../src/recipe_share";
export {
  LOOKUP_SOURCES,
  LOOKUP_SOURCE_LABELS,
  MISS_REASONS,
  MISS_REASON_LABELS,
  IMPORT_KINDS,
  IMPORT_KIND_LABELS,
  isReadyLookup,
  lookupHasName,
  missMessage,
  type LookupSource,
  type MissReason,
  type ImportKind,
  type ImportRowStatus,
  type ImportQueueRow,
  type LookupResult,
  type LookupVariants
} from "../../src/lookup-shared";

export {
  TAB_KEYS,
  DEFAULT_ENABLED_TABS,
  DEFAULT_BAR_LOCATION_TEXT,
  DEFAULT_HOUSE_TIP_BLURB,
  AI_UNAVAILABLE_NOTICE,
  AI_MIXOLOGIST_TIMEOUT_MS,
  mixologistFailureMessage,
  mixologistLoadingStep,
  MIXOLOGIST_LOADING_STEP_MS,
  BLOCKED_RIBBON_LABEL,
  TOP_PATRON_BANNER,
  LEADERBOARD_SIZE,
  KIOSK_IDLE_MS,
  MAX_PATRON_NAME,
  MAX_PATRON_NICKNAME,
  MAX_MESSAGE_BODY,
  MAX_CONTACT_INFO,
  MAX_STAFF_NAME,
  MAX_STAFF_ROLE,
  MAX_STAFF_BIO,
  MAX_GALLERY_CAPTION,
  MAX_GALLERY_BYTES,
  STAFF_ROLE_SUGGESTIONS,
  appleCashLink,
  clipText,
  isBlocked,
  parseEnabledTabs,
  parseTabOrder,
  patronRank,
  serializeEnabledTabs,
  serializeTabOrder,
  DEFAULT_TAB_ORDER,
  tipHandles,
  vaultDayDate
} from "../../src/speakeasy-shared";
export type {
  TabKey,
  EnabledTabs,
  Patron,
  GuestMessage,
  HouseEvent,
  EventSubscriber,
  MerchItem,
  StaffMember,
  GalleryMedia,
  GalleryMediaType,
  DailyVoteResult,
  TipHandle
} from "../../src/speakeasy-shared";
export type { SubstituteOption } from "../../src/cocktails";
