/**
 * Targeted Ollama JSON extraction for missing metadata fields only.
 * Identity context is immutable; the model must not return identity keys.
 */
import type { BottleCandidate } from "../candidate/types.js";
import type { MetadataEnrichmentField } from "./metadata-fields.js";

const LOCAL_OLLAMA_CHAT_URL = "http://192.168.1.184:11434/api/chat";

export type MetadataExtractRequest = {
  candidate: BottleCandidate;
  fields: MetadataEnrichmentField[];
  webSnippets: string;
};

export type MetadataExtractResult = Partial<Record<MetadataEnrichmentField, string | number | null>>;

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

function buildFormat(fields: MetadataEnrichmentField[]) {
  const properties: Record<string, unknown> = {};
  for (const name of fields) {
    if (name === "origin" || name === "ttb_id") {
      properties[name] = { type: ["string", "null"] };
    } else {
      properties[name] = { type: ["number", "null"] };
    }
  }
  return {
    type: "object",
    properties,
    required: [...fields],
    additionalProperties: false
  };
}

function buildPrompt(request: MetadataExtractRequest): string {
  const known = identityContext(request.candidate);
  const missing = request.fields;
  return `You extract factual beverage metadata from web search snippets.

Known identity (immutable — do NOT change, invent, or return these keys):
${JSON.stringify(known, null, 2)}

Return ONLY JSON with these keys (null if unknown/unverifiable): ${missing.join(", ")}
Do not include name, brand, upc, product_type, category, or any other keys.
Do not guess. Prefer null over invented values.

Web snippets:
${request.webSnippets.slice(0, 24_000)}`;
}

function parseExtracted(
  raw: string,
  fields: MetadataEnrichmentField[]
): MetadataExtractResult {
  const cleaned = String(raw ?? "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  const out: MetadataExtractResult = {};
  for (const name of fields) {
    if (!(name in parsed)) continue;
    const value = parsed[name];
    if (value == null) {
      out[name] = null;
      continue;
    }
    if (name === "origin" || name === "ttb_id") {
      const text = String(value).trim();
      out[name] = text || null;
      continue;
    }
    const n = typeof value === "number" ? value : Number.parseFloat(String(value));
    out[name] = Number.isFinite(n) ? n : null;
  }
  return out;
}

/** Default Ollama llama3.1 structured extract for requested metadata fields. */
export async function extractMetadataFromWebText(
  request: MetadataExtractRequest
): Promise<MetadataExtractResult> {
  if (!request.fields.length) return {};
  if (!request.webSnippets.trim()) return {};

  const response = await fetch(LOCAL_OLLAMA_CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: "llama3.1",
      stream: false,
      keep_alive: -1,
      format: buildFormat(request.fields),
      messages: [{ role: "user", content: buildPrompt(request) }]
    })
  });
  const data = await response.json().catch(() => ({})) as OllamaChatResponse;
  if (!response.ok) {
    const message = typeof data.error === "string"
      ? data.error
      : `Ollama returned ${response.status}`;
    throw new Error(message);
  }
  return parseExtracted(data.message?.content ?? "", request.fields);
}

export { buildFormat, buildPrompt, parseExtracted, identityContext };
