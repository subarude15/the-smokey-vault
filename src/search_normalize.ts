/**
 * Dependency-free query normalization for search cache keys.
 * Kept separate from lookup.ts to avoid circular imports with Catalog.beer.
 */
export function normalizeSearchQuery(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}
