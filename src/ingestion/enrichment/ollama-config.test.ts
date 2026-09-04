/**
 * Ollama enrichment config + product-image verifier wiring (fakes only).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { candidateFromProduct } from "../candidate/index.js";
import { ollamaBaseUrl, ollamaSafeHost } from "./health.js";
import { verifyProductImage } from "./image-verify.js";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_VISION_MODEL,
  ollamaChatUrl,
  ollamaVisionModel
} from "./ollama-config.js";

const ENV_KEYS = [
  "OLLAMA_CHAT_URL",
  "SMOKEY_OLLAMA_CHAT_URL",
  "OLLAMA_HOST",
  "SMOKEY_OLLAMA_HOST",
  "OLLAMA_VISION_MODEL",
  "SMOKEY_OLLAMA_VISION_MODEL",
  "AI_MODEL"
] as const;

const savedEnv = new Map<string, string | undefined>();

function snapshotEnv(): void {
  savedEnv.clear();
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const prev = savedEnv.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  savedEnv.clear();
}

function bottleCandidate() {
  return candidateFromProduct(
    {
      upc: "087000201156",
      name: "Captain Morgan Original Spiced Rum",
      brand: "Captain Morgan",
      product_type: "spirit",
      category: "Rum"
    },
    "lookup"
  );
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  snapshotEnv();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

test("OLLAMA_VISION_MODEL is sent on the outgoing chat request", async () => {
  process.env.OLLAMA_VISION_MODEL = "qwen2.5vl:7b";

  let postedUrl = "";
  let postedBody: { model?: string } = {};
  globalThis.fetch = (async (input, init) => {
    postedUrl = String(input);
    postedBody = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    return new Response(
      JSON.stringify({
        message: {
          content: JSON.stringify({
            correct_product: true,
            bottle_prominent: true,
            contains_people: false,
            meme_or_graphic: false,
            clean_product_photo: true,
            multiple_products: false
          })
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const result = await verifyProductImage({
    candidate: bottleCandidate(),
    imageUrl: "https://cdn.example.com/bottle.jpg",
    imageBase64: Buffer.from("fake-image-bytes").toString("base64")
  });

  assert.ok(result);
  assert.equal(postedBody.model, "qwen2.5vl:7b");
  assert.equal(postedUrl, `${DEFAULT_OLLAMA_BASE_URL}/api/chat`);
});

test("vision model falls back to llama3.2-vision when unset", async () => {
  process.env.AI_MODEL = "should-not-be-used";

  let postedBody: { model?: string } = {};
  globalThis.fetch = (async (_input, init) => {
    postedBody = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    return new Response(
      JSON.stringify({
        message: {
          content: JSON.stringify({
            correct_product: true,
            bottle_prominent: true,
            contains_people: false,
            meme_or_graphic: false,
            clean_product_photo: true,
            multiple_products: false
          })
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  await verifyProductImage({
    candidate: bottleCandidate(),
    imageUrl: "https://cdn.example.com/bottle.jpg",
    imageBase64: Buffer.from("fake-image-bytes").toString("base64")
  });

  assert.equal(ollamaVisionModel(), DEFAULT_OLLAMA_VISION_MODEL);
  assert.equal(postedBody.model, "llama3.2-vision");
});

test("OLLAMA_HOST drives verifier /api/chat URL", async () => {
  process.env.OLLAMA_HOST = "http://10.0.0.5:11434";

  let postedUrl = "";
  globalThis.fetch = (async (input) => {
    postedUrl = String(input);
    return new Response(
      JSON.stringify({
        message: {
          content: JSON.stringify({
            correct_product: true,
            bottle_prominent: true,
            contains_people: false,
            meme_or_graphic: false,
            clean_product_photo: true,
            multiple_products: false
          })
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  await verifyProductImage({
    candidate: bottleCandidate(),
    imageUrl: "https://cdn.example.com/bottle.jpg",
    imageBase64: Buffer.from("fake-image-bytes").toString("base64")
  });

  assert.equal(postedUrl, "http://10.0.0.5:11434/api/chat");
  assert.equal(ollamaChatUrl(), "http://10.0.0.5:11434/api/chat");
});

test("OLLAMA_CHAT_URL wins over OLLAMA_HOST for verifier", async () => {
  process.env.OLLAMA_HOST = "http://10.0.0.5:11434";
  process.env.OLLAMA_CHAT_URL = "http://10.0.0.9:11434/api/chat";

  let postedUrl = "";
  globalThis.fetch = (async (input) => {
    postedUrl = String(input);
    return new Response(
      JSON.stringify({
        message: {
          content: JSON.stringify({
            correct_product: true,
            bottle_prominent: true,
            contains_people: false,
            meme_or_graphic: false,
            clean_product_photo: true,
            multiple_products: false
          })
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  await verifyProductImage({
    candidate: bottleCandidate(),
    imageUrl: "https://cdn.example.com/bottle.jpg",
    imageBase64: Buffer.from("fake-image-bytes").toString("base64")
  });

  assert.equal(postedUrl, "http://10.0.0.9:11434/api/chat");
  assert.equal(ollamaChatUrl(), "http://10.0.0.9:11434/api/chat");
});

test("health and verifier derive the same Ollama base from shared env inputs", () => {
  assert.equal(ollamaBaseUrl(), DEFAULT_OLLAMA_BASE_URL);
  assert.equal(ollamaChatUrl(), `${DEFAULT_OLLAMA_BASE_URL}/api/chat`);
  assert.equal(ollamaSafeHost(), "192.168.1.184:11434");

  process.env.OLLAMA_HOST = "http://10.0.0.5:11434/";
  assert.equal(ollamaBaseUrl(), "http://10.0.0.5:11434");
  assert.equal(ollamaChatUrl(), "http://10.0.0.5:11434/api/chat");
  assert.equal(ollamaSafeHost(), "10.0.0.5:11434");

  process.env.OLLAMA_CHAT_URL = "http://10.0.0.9:11434/api/chat";
  assert.equal(ollamaBaseUrl(), "http://10.0.0.9:11434");
  assert.equal(ollamaChatUrl(), "http://10.0.0.9:11434/api/chat");
  assert.equal(ollamaSafeHost(), "10.0.0.9:11434");

  // Verifier chat URL and health base stay aligned on the same host.
  assert.equal(
    ollamaChatUrl().replace(/\/api\/chat\/?$/i, ""),
    ollamaBaseUrl()
  );
});

test("SMOKEY_OLLAMA_VISION_MODEL is a compatibility alias", () => {
  process.env.SMOKEY_OLLAMA_VISION_MODEL = "qwen2.5vl:7b";
  assert.equal(ollamaVisionModel(), "qwen2.5vl:7b");

  process.env.OLLAMA_VISION_MODEL = "primary-vision";
  assert.equal(ollamaVisionModel(), "primary-vision");
});
