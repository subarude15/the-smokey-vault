/**
 * Presentation-time tasting profile helpers.
 * Strips known AI/provenance boilerplate and prefers Aroma / Palate / Finish structure.
 * Does not mutate stored tasting notes.
 */

export type TastingProfile = {
  aroma?: string;
  palate?: string;
  finish?: string;
  /** Cleaned plain text when section labels cannot be parsed reliably. */
  fallback?: string;
};

const BOILERPLATE_LINE = new RegExp(
  [
    "^\\s*ai\\s+house\\s+profile\\b",
    "^\\s*generated\\s+house\\s+profile\\b",
    "^\\s*house\\s+profile\\b",
    "^\\s*\\(?\\s*not\\s+(?:official\\s+)?producer\\s+copy\\s*\\)?\\s*$",
    "^\\s*not\\s+official\\s+producer\\s+copy\\b",
    "^\\s*generated\\s+house\\s+profile\\s*[—\\-–:]+\\s*not\\s+producer\\s+copy\\b"
  ].join("|"),
  "i"
);

const INLINE_BOILERPLATE = [
  /^\s*AI\s+house\s+profile\s*\(\s*not\s+(?:official\s+)?producer\s+copy\s*\)\s*/i,
  /^\s*AI\s+house\s+profile\s*[—\-–:]*\s*/i,
  /^\s*Generated\s+house\s+profile\s*[—\-–:]*\s*(?:not\s+(?:official\s+)?producer\s+copy\s*)?/i,
  /^\s*\(\s*not\s+(?:official\s+)?producer\s+copy\s*\)\s*/i,
  /^\s*not\s+(?:official\s+)?producer\s+copy\s*[—\-–:]*\s*/i,
  /^\s*House\s+profile\s*[—\-–:]*\s*/i
];

const SECTION_LABEL = /^(aroma|nose|palate|taste|finish)\s*:?\s*$/i;
const INLINE_SECTION = /\b(Aroma|Nose|Palate|Taste|Finish)\s*:\s*/gi;

function cleanPart(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function isBoilerplateLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (SECTION_LABEL.test(trimmed)) return false;
  // Keep lines that carry tasting sections after a disclaimer prefix.
  if (/\b(aroma|nose|palate|taste|finish)\s*:/i.test(trimmed)) return false;
  return BOILERPLATE_LINE.test(trimmed);
}

/** Remove only known presentation boilerplate — not arbitrary “producer”/“generated” prose. */
export function stripTastingBoilerplate(raw: string): string {
  let text = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";

  const lines = text.split("\n");
  while (lines.length && isBoilerplateLine(lines[0]!)) {
    lines.shift();
  }
  text = lines.join("\n").trim();

  for (const pattern of INLINE_BOILERPLATE) {
    text = text.replace(pattern, "").trim();
  }

  // Drop trailing provenance asides on their own.
  text = text
    .replace(/\n+\(?\s*not\s+(?:official\s+)?producer\s+copy\s*\)?\s*$/i, "")
    .trim();

  return text;
}

function mapSectionKey(label: string): "aroma" | "palate" | "finish" | null {
  const key = label.trim().toLowerCase();
  if (key === "aroma" || key === "nose") return "aroma";
  if (key === "palate" || key === "taste") return "palate";
  if (key === "finish") return "finish";
  return null;
}

function fromObject(value: Record<string, unknown>): TastingProfile | null {
  const aroma = cleanPart(value.aroma ?? value.nose);
  const palate = cleanPart(value.palate ?? value.taste);
  const finish = cleanPart(value.finish);
  if (!aroma && !palate && !finish) return null;
  return { aroma, palate, finish };
}

function extractSections(text: string): TastingProfile | null {
  const matches = [...text.matchAll(INLINE_SECTION)];
  if (!matches.length) return null;

  const profile: TastingProfile = {};
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const key = mapSectionKey(String(match[1] ?? ""));
    if (!key) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? text.length) : text.length;
    let body = text.slice(start, end).trim();
    // Ignore Tags: payloads that sometimes trail a section.
    body = body.replace(/(?:^|\n)\s*Tags\s*:[\s\S]*$/i, "").trim();
    body = body.replace(/\s+/g, " ").trim();
    if (body) profile[key] = body;
  }

  if (!profile.aroma && !profile.palate && !profile.finish) return null;
  return profile;
}

/**
 * Parse tasting copy into Aroma / Palate / Finish when possible.
 * Safe for free-text legacy notes — falls back to cleaned plain text.
 */
export function parseTastingProfile(input: unknown): TastingProfile {
  if (input == null) return {};

  if (typeof input === "object" && !Array.isArray(input)) {
    const fromObj = fromObject(input as Record<string, unknown>);
    if (fromObj) return fromObj;
  }

  let text = String(input).replace(/\r\n/g, "\n").trim();
  if (!text) return {};

  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const fromObj = fromObject(parsed as Record<string, unknown>);
        if (fromObj) return fromObj;
      }
    } catch {
      // Fall through to prose parsing.
    }
  }

  text = stripTastingBoilerplate(text);
  // Guest UI does not surface flavor-tag lines as chips or sections.
  text = text.replace(/(?:^|\n)\s*Tags\s*:[^\n]*/gi, "").trim();
  if (!text) return {};

  const sections = extractSections(text);
  if (sections) return sections;

  return { fallback: text.replace(/\s+/g, " ").trim() };
}

/**
 * Guest enriched tasting precedence: official producer notes win over house profile.
 * Does not merge or concatenate the two sources.
 */
export function selectGuestEnrichedTastingText(
  official: string | null | undefined,
  houseProfile: string | null | undefined
): string {
  const officialText = String(official ?? "").trim();
  if (officialText) return officialText;
  return String(houseProfile ?? "").trim();
}

/** True when guest-facing copy still contains AI/provenance boilerplate. */
export function tastingProfileHasProvenanceBoilerplate(text: string): boolean {
  const value = String(text ?? "");
  return (
    /\bAI\s+house\s+profile\b/i.test(value) ||
    /\bgenerated\s+house\s+profile\b/i.test(value) ||
    /\bnot\s+(?:official\s+)?producer\s+copy\b/i.test(value) ||
    /\bhouse\s+profile\b/i.test(value)
  );
}
