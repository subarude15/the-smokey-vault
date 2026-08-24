/** Pull an http(s) recipe link out of a share-target payload or pasted text. */
export function extractSharedRecipeUrl(input: {
  url?: string | null;
  text?: string | null;
  title?: string | null;
}): string {
  const direct = cleanHttpUrl(String(input.url ?? ""));
  if (direct) return direct;
  for (const field of [input.text, input.title]) {
    const raw = String(field ?? "").trim();
    if (!raw) continue;
    const asUrl = cleanHttpUrl(raw);
    if (asUrl) return asUrl;
    const matches = raw.match(/https?:\/\/[^\s<>"'\]\)]+/gi);
    if (!matches) continue;
    for (const match of matches) {
      const found = cleanHttpUrl(match);
      if (found) return found;
    }
  }
  return "";
}

function cleanHttpUrl(raw: string): string {
  const value = raw.trim().replace(/[),.;!?]+$/g, "");
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}
