/**
 * Shared types for the local government alcohol catalog (PA PLCB + Iowa).
 */

export const GOVERNMENT_DATASETS = [
  "plcb_spirits",
  "plcb_wines",
  "iowa"
] as const;

export type GovernmentDataset = (typeof GOVERNMENT_DATASETS)[number];

export const GOVERNMENT_JURISDICTIONS = ["pa", "ia"] as const;
export type GovernmentJurisdiction = (typeof GOVERNMENT_JURISDICTIONS)[number];

export type CatalogDomain = "spirit" | "wine";

export type CatalogSourceRecord = {
  id: number;
  jurisdiction: GovernmentJurisdiction;
  dataset: GovernmentDataset;
  sourceVersion: string | null;
  extractedAt: string | null;
  importedAt: string;
  sourceFileHash: string;
  sourceFileName: string | null;
  isCurrent: number;
};

export type CatalogSourceRowRecord = {
  id: number;
  sourceId: number;
  sourceRowKey: string;
  sourceItemId: string | null;
  sourceContainerId: string | null;
  sourceManufacturerCode: string | null;
  rawPayloadJson: string;
  rowHash: string;
};

export type CatalogProductRecord = {
  id: number;
  sourceId: number;
  sourceItemId: string | null;
  domain: CatalogDomain;
  name: string;
  brand: string | null;
  volumeMl: number | null;
  volumeRaw: string | null;
  casePack: number | null;
  proof: number | null;
  abvPercent: number | null;
  abvDerivation: string | null;
  vintageYear: number | null;
  vintageStatus: string | null;
  country: string | null;
  regionRaw: string | null;
  sourceDivision: string | null;
  sourceGroup: string | null;
  sourceClass: string | null;
  normalizedFamily: string | null;
  normalizedSubcategory: string | null;
  sourceExtractedAt: string | null;
  qualityFlagsJson: string | null;
  isCurrent: number;
};

export type CatalogProductCodeRecord = {
  id: number;
  productId: number;
  sourceRowId: number | null;
  codeRaw: string;
  codeNormalized: string | null;
  comparisonKey: string | null;
  gtinType: string | null;
  sourceOrdinal: number | null;
  checkDigitValid: number | null;
  isPreferred: number;
  qualityFlagsJson: string | null;
};

export type CatalogProductRowLink = {
  productId: number;
  sourceRowId: number;
};

export type GovernmentImportStats = {
  dataset: GovernmentDataset;
  rowsRead: number;
  rowsImported: number;
  productsNormalized: number;
  barcodeAliases: number;
  validGtins: number;
  invalidGtins: number;
  flaggedBarcodes: number;
  ambiguousBarcodeMappings: number;
  productsWithProof: number;
  productsWithOrigin: number;
  productsWithRegion: number;
  duplicateSourceItemIds: number;
  snapshotHash: string;
  dbPath: string;
};

export type GovernmentCandidate = {
  product: CatalogProductRecord;
  dataset: GovernmentDataset;
  matchedCodeRaw: string | null;
  matchedCodeNormalized: string | null;
  exactRawMatch: boolean;
  score: number;
  qualityFlags: string[];
};

export type GovernmentLookupResult = {
  status: "hit" | "miss" | "ambiguous";
  candidates: GovernmentCandidate[];
  winner: GovernmentCandidate | null;
  message?: string;
};
