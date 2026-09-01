/**
 * Taxonomy mapping for PA PLCB + Iowa government catalogs.
 * Preserve raw hierarchy; derive normalized family/subcategory without dropping parent context.
 */

import type { CatalogDomain } from "./types.js";

export type TaxonomyMapping = {
  domain: CatalogDomain;
  normalizedFamily: string | null;
  normalizedSubcategory: string | null;
  qualityFlags: string[];
};

const SPIRIT_FAMILY_ALIASES: Array<{ pattern: RegExp; family: string }> = [
  { pattern: /\bwhiskey\b|\bwhisky\b/i, family: "Whiskey" },
  { pattern: /\bbourbon\b/i, family: "Whiskey" },
  { pattern: /\brye\b/i, family: "Whiskey" },
  { pattern: /\bscotch\b/i, family: "Whiskey" },
  { pattern: /\bgin\b/i, family: "Gin" },
  { pattern: /\bvodka\b/i, family: "Vodka" },
  { pattern: /\brum\b/i, family: "Rum" },
  { pattern: /\btequila\b/i, family: "Tequila" },
  { pattern: /\bmezcal\b/i, family: "Mezcal" },
  { pattern: /\bcognac\b/i, family: "Cognac" },
  { pattern: /\bbrandy\b|\barmagnac\b|\bpisco\b/i, family: "Brandy" },
  { pattern: /\bliqueur\b|\bcordial\b/i, family: "Liqueur" },
  { pattern: /\bbitters?\b/i, family: "Bitters" },
  { pattern: /\bgrain\s+alcohol\b|\beverclear\b/i, family: "Grain Alcohol" }
];

const WEAK_CLASS = /^(flavored|unflavored|other|n\/?a|none|misc|miscellaneous)$/i;

function clean(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

export function mapPaSpiritsTaxonomy(input: {
  divisionName?: string | null;
  groupName?: string | null;
  className?: string | null;
}): TaxonomyMapping {
  const group = clean(input.groupName);
  const klass = clean(input.className);
  const flags: string[] = [];

  let family = group;
  for (const { pattern, family: alias } of SPIRIT_FAMILY_ALIASES) {
    if (group && pattern.test(group)) {
      family = alias;
      break;
    }
  }

  let subcategory = klass;
  if (klass && WEAK_CLASS.test(klass)) {
    flags.push("weak_class_requires_parent");
    // Keep class text but retain parent group as the meaningful family.
    subcategory = group && klass ? `${group} / ${klass}` : klass;
  }

  // Brandy-Cognac → Armagnac: keep parent family as Brandy/Cognac, class as subcategory.
  if (group && /brandy|cognac/i.test(group) && klass) {
    family = "Brandy/Cognac";
    subcategory = klass;
  }

  return {
    domain: "spirit",
    normalizedFamily: family,
    normalizedSubcategory: subcategory,
    qualityFlags: flags
  };
}

export function mapPaWinesTaxonomy(input: {
  divisionName?: string | null;
  groupName?: string | null;
  className?: string | null;
}): TaxonomyMapping {
  return {
    domain: "wine",
    normalizedFamily: clean(input.groupName),
    normalizedSubcategory: clean(input.className),
    qualityFlags: []
  };
}

/** Iowa categories are flatter; reuse Vault-ish spirit family inference. */
export function mapIowaTaxonomy(categoryName: string | null | undefined): TaxonomyMapping {
  const raw = clean(categoryName);
  if (!raw) {
    return { domain: "spirit", normalizedFamily: null, normalizedSubcategory: null, qualityFlags: [] };
  }
  let family: string | null = raw;
  for (const { pattern, family: alias } of SPIRIT_FAMILY_ALIASES) {
    if (pattern.test(raw)) {
      family = alias;
      break;
    }
  }
  if (/wine/i.test(raw)) {
    return {
      domain: "wine",
      normalizedFamily: family,
      normalizedSubcategory: raw,
      qualityFlags: []
    };
  }
  return {
    domain: "spirit",
    normalizedFamily: family,
    normalizedSubcategory: raw === family ? null : raw,
    qualityFlags: []
  };
}

export function isGiftOrSpecialtyPackage(name: string | null | undefined): boolean {
  const text = String(name ?? "");
  return /gift\s*set|with\s+glasses|w\/\s*glasses|special\s+selection|value\s+added|temporary\s*&\s*specialty/i.test(
    text
  );
}
