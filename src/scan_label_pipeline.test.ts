import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecodedBarcode } from "./barcode_decode.js";
import type { LookupResult } from "./lookup-shared.js";
import {
  identifyFromLabelImageBuffer,
  type ScanLabelPipelineDeps
} from "./scan_label_pipeline.js";
import type { VisionLabel } from "./vision_label.js";

const SAMPLE_BUFFER = Buffer.from("fake-label-image");

function upcDecoded(value = "012345678905"): DecodedBarcode {
  return {
    rawValue: value,
    format: 14,
    formatName: "UPC_A",
    normalized: {
      cleaned: value,
      normalized: value,
      canonical: value,
      upcA: value,
      ean13: `0${value}`,
      isValidGtin: true,
      isLookupKey: true
    }
  };
}

function readyLookup(source: string, upc = "012345678905"): LookupResult {
  return {
    source,
    upc,
    product: {
      name: "Exact Bottle",
      brand: "Vault",
      category: "Bourbon",
      upc,
      abv: 40,
      volume_ml: 750,
      product_type: "spirit"
    },
    reason: undefined,
    message: undefined
  };
}

function visionLabel(overrides: Partial<VisionLabel> = {}): VisionLabel {
  return {
    name: "Vision Guess",
    brand: "AI Brand",
    category: "Whiskey",
    abv: 43,
    volume_ml: 750,
    upc: "999999999999",
    product_type: "spirit",
    ...overrides
  };
}

function collectLogs() {
  const lines: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const log: NonNullable<ScanLabelPipelineDeps["log"]> = (message, fields) => {
    lines.push({ message, fields });
  };
  return { lines, log };
}

test("barcode exact local match returns without calling vision AI", async () => {
  let visionCalls = 0;
  let callLlmCalls = 0;
  const result = await identifyFromLabelImageBuffer(SAMPLE_BUFFER, {
    decodeBarcode: async () => upcDecoded(),
    lookupBarcode: async () => readyLookup("vault"),
    visionWithOllama: async () => {
      visionCalls += 1;
      return visionLabel();
    },
    visionWithCallLlm: async () => {
      callLlmCalls += 1;
      return JSON.stringify(visionLabel());
    },
    saveImage: () => "/api/media/images/x.jpg"
  });
  assert.equal(result.identification_method, "barcode_exact");
  assert.equal(result.barcode_detected, true);
  assert.equal(result.barcode_lookup_source, "vault");
  assert.equal(result.product.name, "Exact Bottle");
  assert.equal(visionCalls, 0);
  assert.equal(callLlmCalls, 0);
});

test("barcode exact catalog match returns without calling vision AI", async () => {
  let visionCalls = 0;
  const result = await identifyFromLabelImageBuffer(SAMPLE_BUFFER, {
    decodeBarcode: async () => upcDecoded(),
    lookupBarcode: async () => readyLookup("cache"),
    visionWithOllama: async () => {
      visionCalls += 1;
      return visionLabel();
    },
    saveImage: () => ""
  });
  assert.equal(result.identification_method, "barcode_exact");
  assert.equal(result.barcode_lookup_source, "cache");
  assert.equal(visionCalls, 0);
});

test("unknown valid barcode continues to vision", async () => {
  let visionCalls = 0;
  let seenPrompt = "";
  const result = await identifyFromLabelImageBuffer(SAMPLE_BUFFER, {
    decodeBarcode: async () => upcDecoded("012345678905"),
    lookupBarcode: async () => ({
      source: "not_found",
      upc: "012345678905",
      product: null,
      reason: "no_catalog",
      message: "No catalog match."
    }),
    visionWithOllama: async (_image, prompt) => {
      visionCalls += 1;
      seenPrompt = prompt;
      return visionLabel({ upc: "111111111111" });
    },
    saveImage: () => ""
  });
  assert.equal(result.identification_method, "vision");
  assert.equal(result.barcode_detected, true);
  assert.equal(visionCalls, 1);
  assert.match(seenPrompt, /012345678905/);
  // Decoded GTIN outranks AI-derived upc.
  assert.equal(result.upc, "012345678905");
  assert.equal((result.product as { upc?: string }).upc, "012345678905");
});

test("no barcode continues to vision", async () => {
  let visionCalls = 0;
  const result = await identifyFromLabelImageBuffer(SAMPLE_BUFFER, {
    decodeBarcode: async () => null,
    lookupBarcode: async () => {
      throw new Error("lookup must not run without a barcode");
    },
    visionWithOllama: async () => {
      visionCalls += 1;
      return visionLabel({ upc: "" });
    },
    saveImage: () => ""
  });
  assert.equal(result.identification_method, "vision");
  assert.equal(result.barcode_detected, false);
  assert.equal(visionCalls, 1);
});

test("exact barcode result outranks an AI-derived result", async () => {
  const result = await identifyFromLabelImageBuffer(SAMPLE_BUFFER, {
    decodeBarcode: async () => upcDecoded("012345678905"),
    lookupBarcode: async () => readyLookup("fwgs", "012345678905"),
    visionWithOllama: async () => visionLabel({
      name: "Wrong AI Name",
      upc: "000000000000"
    }),
    saveImage: () => ""
  });
  assert.equal(result.identification_method, "barcode_exact");
  assert.equal(result.product.name, "Exact Bottle");
  assert.notEqual(result.product.name, "Wrong AI Name");
});

test("barcode decoder failure does not fail the entire scan", async () => {
  let visionCalls = 0;
  const result = await identifyFromLabelImageBuffer(SAMPLE_BUFFER, {
    decodeBarcode: async () => {
      throw new Error("zxing exploded");
    },
    visionWithOllama: async () => {
      visionCalls += 1;
      return visionLabel({ name: "Recovered" });
    },
    saveImage: () => ""
  });
  assert.equal(result.identification_method, "vision");
  assert.equal(result.product.name, "Recovered");
  assert.equal(visionCalls, 1);
});

test("dedicated vision failure falls through to callLlm when provided", async () => {
  let callLlmCalls = 0;
  const result = await identifyFromLabelImageBuffer(SAMPLE_BUFFER, {
    decodeBarcode: async () => null,
    visionWithOllama: async () => {
      throw new Error("qwen unavailable");
    },
    visionWithCallLlm: async () => {
      callLlmCalls += 1;
      return JSON.stringify(visionLabel({ name: "Gemma Path" }));
    },
    saveImage: () => ""
  });
  assert.equal(callLlmCalls, 1);
  assert.equal(result.product.name, "Gemma Path");
  assert.equal(result.identification_method, "vision");
});

test("malformed Qwen/vision structured output falls through to callLlm", async () => {
  let callLlmCalls = 0;
  const result = await identifyFromLabelImageBuffer(SAMPLE_BUFFER, {
    decodeBarcode: async () => null,
    // Mirrors labelProductWithLocalOllama → parseProductSchema throwing on non-JSON / empty.
    visionWithOllama: async () => {
      throw new Error("Ollama did not return JSON product data");
    },
    visionWithCallLlm: async () => {
      callLlmCalls += 1;
      return JSON.stringify(visionLabel({ name: "Fallback Bottle" }));
    },
    saveImage: () => ""
  });
  assert.equal(callLlmCalls, 1);
  assert.equal(result.product.name, "Fallback Bottle");
  assert.equal(result.identification_method, "vision");
});

test("valid dedicated vision output does not call callLlm", async () => {
  let visionCalls = 0;
  let callLlmCalls = 0;
  const result = await identifyFromLabelImageBuffer(SAMPLE_BUFFER, {
    decodeBarcode: async () => null,
    visionWithOllama: async () => {
      visionCalls += 1;
      return visionLabel({ name: "Qwen Bottle" });
    },
    visionWithCallLlm: async () => {
      callLlmCalls += 1;
      return JSON.stringify(visionLabel({ name: "Should Not Run" }));
    },
    saveImage: () => ""
  });
  assert.equal(visionCalls, 1);
  assert.equal(callLlmCalls, 0);
  assert.equal(result.product.name, "Qwen Bottle");
});

test("lookup miss_reason / empty-name hits do not bypass vision", async () => {
  let visionCalls = 0;
  const weakHits: LookupResult[] = [
    {
      source: "not_found",
      upc: "012345678905",
      product: null,
      reason: "no_catalog",
      message: "No catalog match."
    },
    {
      source: "fwgs",
      upc: "012345678905",
      product: { name: "   ", brand: "X" },
      reason: undefined,
      message: undefined
    },
    {
      source: "cola_cloud",
      upc: "012345678905",
      product: { name: "Thin Hit" },
      reason: "variant",
      message: "Code format"
    }
  ];
  for (const lookup of weakHits) {
    visionCalls = 0;
    const result = await identifyFromLabelImageBuffer(SAMPLE_BUFFER, {
      decodeBarcode: async () => upcDecoded(),
      lookupBarcode: async () => lookup,
      visionWithOllama: async () => {
        visionCalls += 1;
        return visionLabel({ name: "Vision After Weak Lookup" });
      },
      saveImage: () => ""
    });
    assert.equal(result.identification_method, "vision", `expected vision for ${lookup.source}/${lookup.reason}`);
    assert.equal(visionCalls, 1);
  }
});

test("non-GTIN Code 128 / QR decode skips lookup and continues to vision", async () => {
  let lookupCalls = 0;
  let visionCalls = 0;
  const nonGtin: DecodedBarcode = {
    rawValue: "https://example.com/bottle",
    format: 11,
    formatName: "QR_CODE",
    normalized: {
      cleaned: "https://example.com/bottle",
      normalized: "",
      canonical: "",
      upcA: "",
      ean13: "",
      isValidGtin: false,
      isLookupKey: false
    }
  };
  const result = await identifyFromLabelImageBuffer(SAMPLE_BUFFER, {
    decodeBarcode: async () => nonGtin,
    lookupBarcode: async () => {
      lookupCalls += 1;
      return readyLookup("vault");
    },
    visionWithOllama: async () => {
      visionCalls += 1;
      return visionLabel({ name: "Label Read" });
    },
    saveImage: () => ""
  });
  assert.equal(lookupCalls, 0);
  assert.equal(visionCalls, 1);
  assert.equal(result.identification_method, "vision");
  assert.equal(result.barcode_detected, true);
  assert.equal(result.barcode_format, "QR_CODE");
});

test("SCAN timing logs never include image or base64 payloads", async () => {
  const { lines, log } = collectLogs();
  await identifyFromLabelImageBuffer(SAMPLE_BUFFER, {
    decodeBarcode: async () => upcDecoded(),
    lookupBarcode: async () => readyLookup("vault"),
    visionWithOllama: async () => visionLabel(),
    saveImage: () => "",
    log
  });
  const blob = JSON.stringify(lines);
  assert.doesNotMatch(blob, /fake-label-image/);
  assert.doesNotMatch(blob, /base64/i);
  assert.ok(lines.some((l) => l.message.includes("barcode_decode_ms=")));
  assert.ok(lines.some((l) => l.message.includes("barcode_match=true")));
});

test("vision fallback path logs timing without image bytes", async () => {
  const { lines, log } = collectLogs();
  await identifyFromLabelImageBuffer(SAMPLE_BUFFER, {
    decodeBarcode: async () => null,
    visionWithOllama: async () => visionLabel(),
    saveImage: () => "",
    log
  });
  const blob = JSON.stringify(lines);
  assert.doesNotMatch(blob, /fake-label-image/);
  assert.ok(lines.some((l) => l.message.includes("vision_fallback=true")));
  assert.ok(lines.some((l) => l.message.includes("vision_ms=")));
});
