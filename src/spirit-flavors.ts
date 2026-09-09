import { parseList } from "./catalog.js";

/**
 * PR152 / PR156 — deterministic, Guest-facing flavor discovery for the Bottle Library.
 *
 * A small, finite, controlled vocabulary turns real bottle evidence into canonical
 * Flavor facets:
 *   1. Keeper/user structured `flavors`
 *   2. Recognized terms in Keeper/user `tasting_notes`
 *   3. Recognized terms in accepted enrichment tasting/profile text (presentation only)
 *
 * This is a DERIVED presentation/search layer only: it never mutates the database,
 * never rewrites Keeper-owned `flavors` / `tasting_notes` / `tags`, and never calls
 * AI or the network. Manual Keeper `tags` are intentionally NOT a flavor source.
 *
 * Matching is case-insensitive, deduplicated, and word/phrase-aware (word
 * boundaries), so "a long smooth finish" derives nothing while "toasted oak"
 * derives Oak. Multi-word canonical flavors (Baking Spice, Brown Sugar) match
 * as whole phrases.
 */

type FlavorEntry = { label: string; patterns: string[] };

// Order here is the canonical display order for facets/dropdowns.
const FLAVOR_VOCABULARY: FlavorEntry[] = [
  { label: "Vanilla", patterns: [] },
  { label: "Caramel", patterns: ["caramel", "caramelized"] },
  { label: "Brown Sugar", patterns: ["brown sugar"] },
  { label: "Molasses", patterns: [] },
  { label: "Honey", patterns: [] },
  { label: "Oak", patterns: ["oak", "oaky", "oaked"] },
  { label: "Smoke", patterns: ["smoke", "smoky", "smokey", "smoked"] },
  { label: "Peat", patterns: ["peat", "peaty"] },
  { label: "Tobacco", patterns: ["tobacco"] },
  { label: "Leather", patterns: ["leather", "leathery"] },
  { label: "Chocolate", patterns: ["chocolate", "cocoa"] },
  { label: "Coffee", patterns: ["coffee", "espresso", "mocha"] },
  { label: "Cinnamon", patterns: ["cinnamon"] },
  { label: "Baking Spice", patterns: ["baking spice", "baking spices"] },
  { label: "Pepper", patterns: ["pepper", "peppery", "peppercorn"] },
  { label: "Nutty", patterns: ["nutty", "nut", "nuts", "almond", "almonds", "hazelnut", "walnut"] },
  { label: "Citrus", patterns: ["citrus", "citrusy"] },
  { label: "Orange", patterns: ["orange", "oranges"] },
  { label: "Lemon", patterns: ["lemon", "lemons"] },
  { label: "Lime", patterns: ["lime", "limes"] },
  { label: "Grapefruit", patterns: ["grapefruit"] },
  { label: "Cherry", patterns: ["cherry", "cherries"] },
  { label: "Apple", patterns: ["apple", "apples"] },
  { label: "Pear", patterns: ["pear", "pears"] },
  { label: "Banana", patterns: ["banana", "bananas"] },
  { label: "Coconut", patterns: ["coconut"] },
  { label: "Pineapple", patterns: ["pineapple"] },
  { label: "Mint", patterns: ["mint", "minty"] },
  { label: "Herbal", patterns: ["herbal", "herb", "herbs", "herbaceous"] },
  { label: "Floral", patterns: ["floral", "flowers", "blossom"] },
];

/** Canonical flavor labels in display order. */
export const CANONICAL_FLAVOR_LABELS: string[] = FLAVOR_VOCABULARY.map((entry) => entry.label);

// Label → all lowercased match terms (label + inflections/synonyms).
const FLAVOR_ALIASES: Record<string, string[]> = Object.fromEntries(
  FLAVOR_VOCABULARY.map((entry) => [entry.label, Array.from(new Set([entry.label.toLowerCase(), ...entry.patterns]))])
);

/**
 * All search aliases for a set of canonical flavor labels. Lets free-text search
 * match a bottle by any recognized spelling/inflection of a flavor it carries
 * (e.g. "smoky" or "smoked" finding a bottle whose derived flavor is Smoke).
 */
export function flavorSearchAliases(labels: string[]): string[] {
  const out = new Set<string>();
  for (const label of labels) for (const alias of FLAVOR_ALIASES[label] ?? []) out.add(alias);
  return [...out];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Precompiled word/phrase-boundary matcher per canonical flavor. The label
// itself is always a valid pattern; extra patterns cover inflections/synonyms.
const FLAVOR_MATCHERS: Array<{ label: string; regex: RegExp }> = FLAVOR_VOCABULARY.map((entry) => {
  const patterns = Array.from(new Set([entry.label.toLowerCase(), ...entry.patterns]));
  const alternation = patterns.map(escapeRegExp).join("|");
  return { label: entry.label, regex: new RegExp(`\\b(?:${alternation})\\b`, "i") };
});

/**
 * Normalize free-text tasting / profile prose for vocabulary matching.
 * Accepts plain strings, JSON string arrays, real arrays, and common delimiters
 * (commas, semicolons, newlines, pipes) without inventing flavor labels.
 */
export function normalizeFlavorProse(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((entry) => String(entry ?? "").trim()).filter(Boolean).join(" ");
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry ?? "").trim()).filter(Boolean).join(" ");
      }
    } catch {
      // Plain tasting prose — keep as-is after soft delimiter normalization.
    }
    return trimmed.replace(/[;\n\r|]+/g, " ");
  }
  return String(value);
}

export type SpiritFlavorSource = {
  flavors?: unknown;
  tasting_notes?: unknown;
  /**
   * Extra free-text tasting/profile evidence (e.g. accepted enrichment official
   * notes + house profile). Presentation-only — never written back into inventory.
   */
  enrichment_tasting_text?: unknown;
};

/**
 * Derive canonical Guest-facing flavors from structured flavors, Keeper tasting
 * notes, and optional enrichment tasting/profile text. Deterministic,
 * deduplicated, and in canonical order. Values outside the vocabulary are
 * ignored here (they remain untouched in source fields and still free-text
 * searchable) so the Guest facet set stays controlled.
 */
export function deriveSpiritFlavors(item: SpiritFlavorSource): string[] {
  const structured = parseList(item.flavors).join(" ");
  const notes = normalizeFlavorProse(item.tasting_notes);
  const enrichment = normalizeFlavorProse(item.enrichment_tasting_text);
  const text = `${structured} ${notes} ${enrichment}`.toLowerCase();
  if (!text.trim()) return [];
  const found: string[] = [];
  for (const { label, regex } of FLAVOR_MATCHERS) {
    if (regex.test(text)) found.push(label);
  }
  return found;
}

/**
 * Prefer server-attached `display_flavors` when present (inventory + enrichment
 * evidence already merged). Fall back to inventory-only derivation for older
 * payloads or offline fixtures.
 */
export function resolveSpiritDisplayFlavors(item: Record<string, unknown>): string[] {
  const attached = item.display_flavors;
  if (Array.isArray(attached)) {
    const present = new Set(attached.map((entry) => String(entry)));
    return CANONICAL_FLAVOR_LABELS.filter((label) => present.has(label));
  }
  if (typeof attached === "string" && attached.trim()) {
    try {
      const parsed = JSON.parse(attached) as unknown;
      if (Array.isArray(parsed)) {
        const present = new Set(parsed.map((entry) => String(entry)));
        return CANONICAL_FLAVOR_LABELS.filter((label) => present.has(label));
      }
    } catch {
      // Not a JSON array — ignore and fall through to inventory derivation.
    }
  }
  return deriveSpiritFlavors(item);
}

/**
 * Flavor facet options for the Bottle Library dropdown.
 *
 * Applies Family (and optionally Availability) before collecting flavors, but
 * does NOT apply the currently selected Flavor — so the control never offers
 * options that would immediately yield zero results under the active Family.
 */
export function spiritFlavorFacetOptions(options: {
  items: Array<Record<string, unknown>>;
  flavorsById: Map<number, string[]>;
  family: string;
  familyKey?: string;
  availability?: string;
  isAvailable?: (item: Record<string, unknown>) => boolean;
}): string[] {
  const familyKey = options.familyKey ?? "category";
  const present = new Set<string>();
  for (const item of options.items) {
    if (options.family !== "All" && String(item[familyKey] ?? "") !== options.family) continue;
    if (options.availability && options.availability !== "All" && options.isAvailable) {
      const available = options.isAvailable(item);
      if (options.availability === "available" && !available) continue;
      if (options.availability === "out" && available) continue;
    }
    const derived = options.flavorsById.get(Number(item.id)) ?? [];
    for (const label of derived) present.add(label);
  }
  return CANONICAL_FLAVOR_LABELS.filter((label) => present.has(label));
}

/** Reset stale Flavor selections that are no longer valid under current options. */
export function coerceSpiritFlavorSelection(selected: string, options: string[]): string {
  if (selected === "All") return "All";
  if (options.some((label) => label.toLowerCase() === selected.toLowerCase())) return selected;
  return "All";
}
