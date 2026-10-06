import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { labelProductWithLocalOllama } from "./llm-enrichment.js";
import { DEFAULT_OLLAMA_VISION_MODEL } from "./enrichment/ollama-config.js";

const originalFetch = globalThis.fetch;
const envKeys = [
  "OLLAMA_HOST",
  "OLLAMA_CHAT_URL",
  "SMOKEY_OLLAMA_HOST",
  "SMOKEY_OLLAMA_CHAT_URL",
  "OLLAMA_VISION_MODEL",
  "SMOKEY_OLLAMA_VISION_MODEL",
  "AI_MODEL"
] as const;
const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of envKeys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function productResponse() {
  return new Response(
    JSON.stringify({
      message: {
        content: JSON.stringify({
          upc: "012345678905",
          name: "Test Bottle",
          brand: "Test",
          category: "Bourbon",
          abv: 40,
          image_url: null,
          fill_level_percent: 100,
          bottle_count: 1,
          notes: null,
          volume_ml: 750,
          product_type: "spirit",
          ttb_id: null,
          origin: null,
          approval_date: null
        })
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

test("label path uses configured OLLAMA_VISION_MODEL (qwen2.5vl:7b)", async () => {
  process.env.OLLAMA_VISION_MODEL = "qwen2.5vl:7b";
  process.env.AI_MODEL = "gemma4:12b";
  process.env.OLLAMA_HOST = "http://192.168.1.50:11434";

  let postedUrl = "";
  let postedBody: { model?: string; messages?: Array<{ images?: string[] }> } = {};
  globalThis.fetch = (async (input, init) => {
    postedUrl = String(input);
    postedBody = JSON.parse(String(init?.body ?? "{}")) as typeof postedBody;
    return productResponse();
  }) as typeof fetch;

  const product = await labelProductWithLocalOllama("aGVsbG8=");
  assert.equal(product.name, "Test Bottle");
  assert.equal(postedBody.model, "qwen2.5vl:7b");
  assert.notEqual(postedBody.model, "gemma4:12b");
  assert.equal(postedUrl, "http://192.168.1.50:11434/api/chat");
});

test("label path defaults to llama3.2-vision when OLLAMA_VISION_MODEL unset", async () => {
  let postedBody: { model?: string } = {};
  globalThis.fetch = (async (_input, init) => {
    postedBody = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    return productResponse();
  }) as typeof fetch;

  await labelProductWithLocalOllama("aGVsbG8=");
  assert.equal(postedBody.model, DEFAULT_OLLAMA_VISION_MODEL);
  assert.equal(postedBody.model, "llama3.2-vision");
});

test("HTTP 200 with malformed / empty Ollama content throws (pipeline treats as vision failure)", async () => {
  for (const content of ["", "not json", "```oops```", "{broken"]) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: { content } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch;
    await assert.rejects(
      () => labelProductWithLocalOllama("aGVsbG8="),
      /Ollama did not return JSON product data|JSON|Unexpected/
    );
  }
});
