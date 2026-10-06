/**
 * Fast label-image scan pipeline:
 *   decode barcode → exact catalog lookup → only then vision AI
 *
 * Shared by multipart /api/ai/vision-label and base64 /api/scan/label.
 */
import { decodeBarcodeFromImageBuffer, type DecodedBarcode } from "./barcode_decode.js";
import { VISION_LABEL_PROMPT, parseVisionLabel, type VisionLabel } from "./vision_label.js";
import { downscaleVisionImage } from "./vision_image.js";
import {
  assembleVisionLabelResult,
  identifyByBarcode,
  type LabelIngestionResult
} from "./ingestion/bottle-orchestrator.js";
import { labelProductWithLocalOllama } from "./ingestion/llm-enrichment.js";
import { isReadyLookup, type LookupResult } from "./lookup-shared.js";
import { ollamaVisionModel } from "./ingestion/enrichment/ollama-config.js";
import type { AiOutputValidate } from "./ai_client.js";

export type ScanIdentificationMethod = "barcode_exact" | "vision";

export type ScanLabelPipelineResult = LabelIngestionResult & {
  identification_method: ScanIdentificationMethod;
  barcode_detected: boolean;
  barcode_format?: string;
  barcode_value?: string;
  barcode_lookup_source?: string;
};

export type ScanLabelPipelineDeps = {
  decodeBarcode?: (buffer: Buffer) => Promise<DecodedBarcode | null>;
  lookupBarcode?: (code: string) => Promise<LookupResult>;
  /** Dedicated Ollama vision model path (OLLAMA_VISION_MODEL). */
  visionWithOllama?: (imageBase64: string, prompt: string) => Promise<VisionLabel>;
  /** Shared callLlm path (Gemma / Gemini fallback). */
  visionWithCallLlm?: (prompt: string, imageBase64: string) => Promise<string>;
  saveImage?: (buffer: Buffer) => string;
  now?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

function scanLog(
  log: ScanLabelPipelineDeps["log"],
  message: string,
  fields?: Record<string, unknown>
) {
  if (log) log(message, fields);
  else if (fields) console.info(fields, message);
  else console.info(message);
}

function visionPromptForBarcode(decoded: DecodedBarcode | null): string {
  if (!decoded?.normalized.isLookupKey) return VISION_LABEL_PROMPT;
  const key = decoded.normalized.canonical;
  return `${VISION_LABEL_PROMPT}

A deterministic barcode decoder already read ${decoded.formatName} ${key} from this image.
No exact catalog match was found for that code.
Use ${key} as the upc field unless the printed digits clearly disagree.
Do not invent a different UPC.`;
}

/** Exact barcode path: return lookup product as-is (never inject the uploaded scan photo). */
function productFromLookup(result: LookupResult): LabelIngestionResult["product"] {
  const product = { ...(result.product ?? {}) } as Record<string, unknown>;
  if (result.upc && !product.upc) product.upc = result.upc;
  return product as LabelIngestionResult["product"];
}

async function runDedicatedVision(
  imageBase64: string,
  prompt: string,
  deps: Required<Pick<ScanLabelPipelineDeps, "visionWithOllama">>
): Promise<VisionLabel> {
  return deps.visionWithOllama(imageBase64, prompt);
}

/**
 * Default dedicated vision: local Ollama using OLLAMA_VISION_MODEL (qwen2.5vl:7b when configured).
 * Maps ProductSchema-ish output into VisionLabel via parseVisionLabel JSON round-trip.
 */
export async function defaultOllamaVisionLabel(imageBase64: string, prompt: string): Promise<VisionLabel> {
  const product = await labelProductWithLocalOllama(imageBase64, { prompt });
  // Reuse the shared vision parser so upc/product_type normalization stays one path.
  return parseVisionLabel(JSON.stringify({
    name: product.name,
    brand: product.brand,
    category: product.category,
    abv: product.abv,
    volume_ml: product.volume_ml,
    upc: product.upc,
    product_type: product.product_type
  }));
}

export async function identifyFromLabelImageBuffer(
  buffer: Buffer,
  deps: ScanLabelPipelineDeps = {}
): Promise<ScanLabelPipelineResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log;
  const decodeBarcode = deps.decodeBarcode ?? decodeBarcodeFromImageBuffer;
  const lookupBarcode = deps.lookupBarcode ?? ((code: string) => identifyByBarcode(code, { mode: "live" }));
  const visionWithOllama = deps.visionWithOllama ?? defaultOllamaVisionLabel;
  const saveImage = deps.saveImage ?? (() => "");

  const t0 = now();
  let decoded: DecodedBarcode | null = null;
  try {
    decoded = await decodeBarcode(buffer);
  } catch {
    decoded = null;
  }
  const barcodeDecodeMs = now() - t0;
  scanLog(log, `[SCAN] barcode_decode_ms=${barcodeDecodeMs}`, {
    barcode_decode_ms: barcodeDecodeMs,
    barcode_detected: Boolean(decoded)
  });

  if (decoded?.normalized.isLookupKey) {
    const lookupKey = decoded.normalized.canonical;
    const tLookup = now();
    let lookup: LookupResult;
    try {
      lookup = await lookupBarcode(lookupKey);
    } catch {
      lookup = {
        source: "not_found",
        upc: lookupKey,
        product: null,
        reason: "no_catalog",
        message: "Barcode lookup failed"
      };
    }
    const barcodeLookupMs = now() - tLookup;

    if (isReadyLookup(lookup)) {
      scanLog(log, `[SCAN] barcode_lookup_ms=${barcodeLookupMs}`, {
        barcode_lookup_ms: barcodeLookupMs,
        barcode_match: true,
        source: lookup.source
      });
      scanLog(log, `[SCAN] barcode_match=true source=${lookup.source}`, {
        barcode_match: true,
        source: lookup.source
      });
      // Exact hit: return lookup product/image as-is. Do not persist or attach the scan photo.
      return {
        source: "label",
        upc: lookup.upc || lookupKey,
        product: productFromLookup(lookup),
        suggestions: [],
        identification_method: "barcode_exact",
        barcode_detected: true,
        barcode_format: decoded.formatName,
        barcode_value: lookupKey,
        barcode_lookup_source: lookup.source
      };
    }

    scanLog(log, `[SCAN] barcode_lookup_ms=${barcodeLookupMs}`, {
      barcode_lookup_ms: barcodeLookupMs,
      barcode_match: false
    });
    scanLog(log, "[SCAN] barcode_match=false", { barcode_match: false });
  } else if (decoded) {
    scanLog(log, "[SCAN] barcode_match=false", {
      barcode_match: false,
      reason: "not_a_product_gtin",
      format: decoded.formatName
    });
  } else {
    scanLog(log, "[SCAN] barcode_match=false", { barcode_match: false });
  }

  // Vision path only: persist the uploaded image for label evidence / review.
  let imageUrl = "";
  try {
    imageUrl = saveImage(buffer);
  } catch {
    imageUrl = "";
  }

  scanLog(log, "[SCAN] vision_fallback=true", {
    vision_fallback: true,
    vision_model: ollamaVisionModel()
  });

  const scaled = await downscaleVisionImage(buffer);
  const prompt = visionPromptForBarcode(decoded);
  const tVision = now();
  let parsed: VisionLabel;
  try {
    parsed = await runDedicatedVision(scaled.base64, prompt, { visionWithOllama });
  } catch (visionError) {
    if (!deps.visionWithCallLlm) throw visionError;
    // Dedicated vision model unavailable — fall through to shared callLlm (Gemma / Gemini).
    scanLog(log, "[SCAN] vision_ollama_failed using_callLlm=true", {
      vision_ollama_failed: true,
      reason: visionError instanceof Error ? visionError.message : String(visionError)
    });
    const raw = await deps.visionWithCallLlm(prompt, scaled.base64);
    parsed = parseVisionLabel(raw);
  }
  const visionMs = now() - tVision;
  scanLog(log, `[SCAN] vision_ms=${visionMs}`, { vision_ms: visionMs });

  // Decoded GTIN outranks any AI-derived upc guess.
  if (decoded?.normalized.isLookupKey) {
    parsed = { ...parsed, upc: decoded.normalized.canonical };
  }

  const labeled = await assembleVisionLabelResult(parsed, imageUrl);
  return {
    ...labeled,
    identification_method: "vision",
    barcode_detected: Boolean(decoded),
    barcode_format: decoded?.formatName,
    barcode_value: decoded?.normalized.canonical || decoded?.rawValue,
    barcode_lookup_source: decoded?.normalized.isLookupKey ? "miss" : undefined
  };
}

/** Helper for callLlm validate wiring. */
export const validateVisionLabelText: AiOutputValidate = (text) => {
  parseVisionLabel(text);
};
