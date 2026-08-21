export const WHISKEY_TYPES = [
  "Bourbon", "Rye", "Scotch", "Irish", "Corn whiskey", "Tennessee",
  "Canadian", "Japanese", "Blended", "Wheat whiskey"
];

export function parseList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueList(value.map((entry) => String(entry)));
  }
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return uniqueList(parsed.map((entry) => String(entry)));
  } catch {
    // Plain text / hashtag input.
  }
  return uniqueList(value.split(/[\s,]+/));
}

export function serializeList(values: string[]): string {
  return JSON.stringify(uniqueList(values));
}

export function parseTagInput(input: string): string[] {
  return uniqueList(input.split(/[\s,]+/).map((part) => part.replace(/^#/, "")));
}

function uniqueList(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.replace(/^#/, "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function spiritFamilyFromLabel(category: string, subCategory = ""): { family: string; type: string } {
  const familyRaw = category.trim();
  const typeRaw = subCategory.trim();
  const haystack = `${familyRaw} ${typeRaw}`.toLowerCase();
  if (!familyRaw) return { family: "Mixer", type: typeRaw };
  if (familyRaw.toLowerCase() === "whiskey" || familyRaw.toLowerCase() === "whisky") {
    return { family: "Whiskey", type: typeRaw };
  }
  const whiskeyType = WHISKEY_TYPES.find((value) => haystack.includes(value.toLowerCase()));
  if (whiskeyType || /whisky|whiskey/.test(haystack)) {
    return { family: "Whiskey", type: typeRaw || whiskeyType || familyRaw };
  }
  if (/gin/.test(haystack)) return { family: "Gin", type: typeRaw };
  if (/tequila/.test(haystack)) return { family: "Tequila", type: typeRaw };
  if (/mezcal/.test(haystack)) return { family: "Mezcal", type: typeRaw };
  if (/\brum\b/.test(haystack)) return { family: "Rum", type: typeRaw };
  if (/amaro/.test(haystack)) return { family: "Amaro", type: typeRaw };
  if (/liqueur|cordial/.test(haystack)) return { family: "Liqueur", type: typeRaw };
  if (/bitter/.test(haystack)) return { family: "Bitters", type: typeRaw };
  if (/vodka/.test(haystack)) return { family: "Vodka", type: typeRaw };
  if (/cognac/.test(haystack)) return { family: "Cognac", type: typeRaw };
  if (/brandy|armagnac|pisco/.test(haystack)) return { family: "Brandy", type: typeRaw };
  return { family: familyRaw, type: typeRaw };
}
