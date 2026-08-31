/**
 * LLM helpers for tasting-note enrichment.
 * Official notes: extract only from authoritative snippets (never invent).
 * House profile: separate AI-labeled structured tasting sketch.
 */
import type { BottleCandidate } from "../candidate/types.js";

const LOCAL_OLLAMA_CHAT_URL = "http://192.168.1.184:11434/api/chat";

export type OfficialNotesExtractRequest = {
  candidate: BottleCandidate;
  /** Pre-filtered authoritative snippets including URL lines. */
  authoritativeSnippets: string;
};

export type OfficialNotesExtractResult = {
  official_notes: string | null;
  source_url: string | null;
  /** Deterministic trust label from source class — never LLM-assigned numeric confidence. */
  confidence: "official" | "importer" | "none";
};

export type HouseProfileRequest = {
  candidate: BottleCandidate;
  /** Optional non-authoritative context; never treated as producer copy. */
  contextSnippets?: string;
};

export type HouseProfileResult = {
  aroma: string | null;
  palate: string | null;
  finish: string | null;
  flavor_tags: string[];
};

type OllamaChatResponse = {
  message?: { content?: string };
  error?: unknown;
};

function identityContext(candidate: BottleCandidate): Record<string, string | number | null> {
  return {
    upc: candidate.upc.value,
    name: candidate.name.value,
    brand: candidate.brand.value,
    product_type: candidate.product_type.value
  };
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = String(raw ?? "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function ollamaJson(
  prompt: string,
  format: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const response = await fetch(LOCAL_OLLAMA_CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: "llama3.1",
      stream: false,
      keep_alive: -1,
      format,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await response.json().catch(() => ({})) as OllamaChatResponse;
  if (!response.ok) {
    const message = typeof data.error === "string"
      ? data.error
      : `Ollama returned ${response.status}`;
    throw new Error(message);
  }
  return parseJsonObject(data.message?.content ?? "");
}

export function buildOfficialNotesPrompt(request: OfficialNotesExtractRequest): string {
  const known = identityContext(request.candidate);
  return `You extract OFFICIAL producer/distillery tasting notes from authoritative web snippets only.

Known identity (immutable — do NOT change or return these keys):
${JSON.stringify(known, null, 2)}

Rules:
- Only use text that is clearly tasting notes from a producer, distillery, winery, brewery, or official brand/importer page.
- Do NOT invent notes. Prefer null when unsure.
- Do NOT use retailer, blog, Reddit, or review-site wording as official notes.
- Return source_url exactly as given in a snippet URL line when notes are taken from that snippet.
- Return confidence as "official", "importer", or "none" matching the snippet tag — never invent a numeric score.

Return ONLY JSON:
{"official_notes": null, "source_url": null, "confidence": "none"}

Authoritative snippets:
${request.authoritativeSnippets.slice(0, 24_000)}`;
}

export function parseOfficialNotesExtract(raw: Record<string, unknown> | null): OfficialNotesExtractResult {
  if (!raw) {
    return { official_notes: null, source_url: null, confidence: "none" };
  }
  const notes = String(raw.official_notes ?? "").trim() || null;
  const sourceUrl = String(raw.source_url ?? "").trim() || null;
  const confRaw = String(raw.confidence ?? "none").trim().toLowerCase();
  const confidence =
    confRaw === "official" || confRaw === "importer" ? confRaw : "none";
  if (!notes || !sourceUrl || confidence === "none") {
    return { official_notes: null, source_url: null, confidence: "none" };
  }
  return { official_notes: notes, source_url: sourceUrl, confidence };
}

const OFFICIAL_FORMAT = {
  type: "object",
  properties: {
    official_notes: { type: ["string", "null"] },
    source_url: { type: ["string", "null"] },
    confidence: { type: "string", enum: ["official", "importer", "none"] }
  },
  required: ["official_notes", "source_url", "confidence"],
  additionalProperties: false
};

/** Extract official notes from pre-classified authoritative snippets only. */
export async function extractOfficialTastingNotes(
  request: OfficialNotesExtractRequest
): Promise<OfficialNotesExtractResult> {
  if (!request.authoritativeSnippets.trim()) {
    return { official_notes: null, source_url: null, confidence: "none" };
  }
  const parsed = await ollamaJson(buildOfficialNotesPrompt(request), OFFICIAL_FORMAT);
  return parseOfficialNotesExtract(parsed);
}

export function buildHouseProfilePrompt(request: HouseProfileRequest): string {
  const known = identityContext(request.candidate);
  return `Create a concise AI house tasting profile for a home bar inventory site.

Known identity (immutable):
${JSON.stringify(known, null, 2)}

Rules:
- This is AI-generated house content, NOT producer/official tasting notes.
- Be concise. Do not invent awards, ABV, age statements, or provenance facts.
- flavor_tags: 3-6 short lowercase tags.
- Use null for aroma/palate/finish when you lack enough signal.

Optional context (not official producer copy):
${(request.contextSnippets ?? "").slice(0, 8_000) || "(none)"}

Return ONLY JSON with keys aroma, palate, finish, flavor_tags.`;
}

export function parseHouseProfile(raw: Record<string, unknown> | null): HouseProfileResult {
  if (!raw) {
    return { aroma: null, palate: null, finish: null, flavor_tags: [] };
  }
  const text = (value: unknown) => {
    const t = String(value ?? "").trim();
    return t || null;
  };
  const tagsRaw = raw.flavor_tags;
  const flavor_tags = Array.isArray(tagsRaw)
    ? tagsRaw.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 8)
    : [];
  return {
    aroma: text(raw.aroma),
    palate: text(raw.palate),
    finish: text(raw.finish),
    flavor_tags
  };
}

const HOUSE_FORMAT = {
  type: "object",
  properties: {
    aroma: { type: ["string", "null"] },
    palate: { type: ["string", "null"] },
    finish: { type: ["string", "null"] },
    flavor_tags: { type: "array", items: { type: "string" } }
  },
  required: ["aroma", "palate", "finish", "flavor_tags"],
  additionalProperties: false
};

/** Format house profile for storage — clearly labeled as AI-generated. */
export function formatHouseProfile(profile: HouseProfileResult): string | null {
  const parts: string[] = [];
  if (profile.aroma) parts.push(`Aroma: ${profile.aroma}`);
  if (profile.palate) parts.push(`Palate: ${profile.palate}`);
  if (profile.finish) parts.push(`Finish: ${profile.finish}`);
  if (profile.flavor_tags.length) parts.push(`Tags: ${profile.flavor_tags.join(", ")}`);
  if (!parts.length) return null;
  return `AI house profile (not producer copy)\n${parts.join("\n")}`;
}

export async function generateHouseTastingProfile(
  request: HouseProfileRequest
): Promise<HouseProfileResult> {
  const parsed = await ollamaJson(buildHouseProfilePrompt(request), HOUSE_FORMAT);
  return parseHouseProfile(parsed);
}
