import { parseList } from "./catalog";

/**
 * PR152 — deterministic, Guest-facing flavor discovery for the Bottle Library.
 *
 * A small, finite, controlled vocabulary turns the data the app already has
 * (structured `flavors` + recognized terms in free-text `tasting_notes`) into
 * canonical Flavor facets. This is a DERIVED presentation/search layer only:
 * it never mutates the database, never rewrites `flavors`/`tasting_notes`/`tags`,
 * and never calls AI or the network. Manual Keeper `tags` are intentionally NOT
 * a flavor source.
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
 * Derive canonical Guest-facing flavors for a bottle from its structured
 * `flavors` and free-text `tasting_notes`. Deterministic, deduplicated, and in
 * canonical order. Values outside the vocabulary are ignored here (they remain
 * untouched in the source field and still free-text searchable) so the Guest
 * facet set stays controlled.
 */
export function deriveSpiritFlavors(item: { flavors?: unknown; tasting_notes?: unknown }): string[] {
  const structured = parseList(item.flavors).join(" ");
  const notes = typeof item.tasting_notes === "string" ? item.tasting_notes : String(item.tasting_notes ?? "");
  const text = `${structured} ${notes}`.toLowerCase();
  if (!text.trim()) return [];
  const found: string[] = [];
  for (const { label, regex } of FLAVOR_MATCHERS) {
    if (regex.test(text)) found.push(label);
  }
  return found;
}
