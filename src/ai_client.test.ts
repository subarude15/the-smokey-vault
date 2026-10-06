import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  AiRequestError,
  callLlm,
  describeAiRuntime,
  probeOllamaAiHealth,
  requestAi,
  resolveAiConfig
} from "./ai_client.js";
import { defaultAiModel } from "./ai_providers.js";

const AI_ENV_KEYS = [
  "AI_PROVIDER",
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "AI_FALLBACK_PROVIDER",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OLLAMA_HOST",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL"
] as const;

const savedEnv = Object.fromEntries(AI_ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

function clearAiEnv() {
  for (const key of AI_ENV_KEYS) delete process.env[key];
}

function restoreEnv() {
  globalThis.fetch = originalFetch;
  for (const key of AI_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

afterEach(restoreEnv);

function ollamaEnv(extra: Record<string, string> = {}) {
  clearAiEnv();
  process.env.AI_PROVIDER = "ollama";
  process.env.AI_MODEL = "gemma4";
  process.env.OLLAMA_HOST = "http://ollama.test:11434";
  process.env.AI_FALLBACK_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.GEMINI_MODEL = "gemini-3.6-flash";
  Object.assign(process.env, extra);
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const validRecipeJson = JSON.stringify({
  name: "Negroni",
  ingredients: ["1 oz gin", "1 oz Campari", "1 oz sweet vermouth"],
  method: "Stir",
  glassware: "Rocks",
  garnish: "Orange",
  season: "All",
  notes: "Bitter"
});

function assertValidRecipeJson(text: string) {
  const cleaned = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("incomplete recipe json");
  const value = JSON.parse(cleaned.slice(start, end + 1)) as { name?: unknown; ingredients?: unknown; method?: unknown };
  if (!value.name || !Array.isArray(value.ingredients) || !value.method) {
    throw new Error("recipe missing required fields");
  }
}

test("1. Ollama success does not call Gemini", async () => {
  ollamaEnv();
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return jsonResponse(200, { message: { content: '{"name":"Negroni"}' } });
  }) as typeof fetch;

  const text = await callLlm("Return JSON", undefined, 5_000);
  assert.match(text, /Negroni/);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /ollama\.test:11434\/api\/chat/);
  assert.ok(!urls.some((url) => url.includes("generativelanguage.googleapis.com")));
});

test("2. Connection failure falls back to Gemini once", async () => {
  ollamaEnv();
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("ollama.test")) {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }]
    });
  }) as typeof fetch;

  const text = await callLlm("hello", undefined, 5_000);
  assert.equal(text, '{"ok":true}');
  assert.equal(urls.filter((url) => url.includes("ollama.test")).length, 1);
  assert.equal(urls.filter((url) => url.includes("generativelanguage.googleapis.com")).length, 1);
});

test("3. Timeout falls back to Gemini", async () => {
  ollamaEnv();
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("ollama.test")) {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: "gemini-ok" }] } }]
    });
  }) as typeof fetch;

  assert.equal(await callLlm("hello", undefined, 1_000), "gemini-ok");
  assert.ok(urls.some((url) => url.includes("generativelanguage.googleapis.com")));
});

test("4. HTTP 5xx falls back to Gemini", async () => {
  ollamaEnv();
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("ollama.test")) return jsonResponse(503, { error: { message: "down" } });
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: "recovered" }] } }]
    });
  }) as typeof fetch;

  assert.equal(await callLlm("hello", undefined, 5_000), "recovered");
  assert.equal(urls.length, 2);
});

test("5. Empty response falls back to Gemini", async () => {
  ollamaEnv();
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("ollama.test")) return jsonResponse(200, { message: { content: "   " } });
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: "filled" }] } }]
    });
  }) as typeof fetch;

  assert.equal(await callLlm("hello", undefined, 5_000), "filled");
  assert.equal(urls.length, 2);
});

test("6. Multimodal Ollama success sends images and skips Gemini", async () => {
  ollamaEnv();
  let posted: { model?: string; messages?: Array<{ images?: string[]; role?: string }> } | null = null;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    posted = JSON.parse(String(init?.body));
    return jsonResponse(200, { message: { content: '{"name":"Bottle"}' } });
  }) as typeof fetch;

  const text = await callLlm("Read the label", "aW1hZ2UtYnl0ZXM=", 5_000);
  assert.match(text, /Bottle/);
  assert.equal(posted?.model, "gemma4");
  assert.deepEqual(posted?.messages?.[0]?.images, ["aW1hZ2UtYnl0ZXM="]);
  assert.ok(!urls.some((url) => url.includes("generativelanguage.googleapis.com")));
});

test("7. Both providers failing yields a meaningful error", async () => {
  ollamaEnv();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("ollama.test")) {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }
    return jsonResponse(500, { error: { message: "Gemini also down" } });
  }) as typeof fetch;

  await assert.rejects(
    () => callLlm("hello", undefined, 5_000),
    (error: unknown) => {
      assert.ok(error instanceof AiRequestError);
      assert.match(error.message, /Gemini also down|could not generate|500/i);
      assert.equal(error.retryable, true);
      return true;
    }
  );
});

test("8. No AI_FALLBACK_PROVIDER is primary-only even with Gemini key present", async () => {
  clearAiEnv();
  process.env.AI_PROVIDER = "ollama";
  process.env.OLLAMA_HOST = "http://ollama.test:11434";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  let calls = 0;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1;
    urls.push(String(input));
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as typeof fetch;

  await assert.rejects(() => callLlm("hello", undefined, 5_000), AiRequestError);
  assert.equal(calls, 1);
  assert.ok(!urls.some((url) => url.includes("generativelanguage.googleapis.com")));
  const runtime = describeAiRuntime(process.env);
  assert.equal(runtime.fallback, null);
  assert.equal(runtime.fallbackProviderEnv, null);
});

test("9. Gemini primary still works without Ollama", async () => {
  clearAiEnv();
  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.AI_MODEL = "gemini-3.6-flash";
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: "mixologist-ok" }] } }]
    });
  }) as typeof fetch;

  assert.equal(await callLlm("Make a drink", undefined, 5_000), "mixologist-ok");
  assert.equal(urls.length, 1);
  assert.match(urls[0], /generativelanguage\.googleapis\.com/);
  assert.ok(!urls.some((url) => url.includes("11434")));
});

test("10. callLlm option object path preserves consumer signature compatibility", async () => {
  ollamaEnv();
  globalThis.fetch = (async () =>
    jsonResponse(200, { message: { content: "ok" } })) as typeof fetch;
  assert.equal(await callLlm("a"), "ok");
  assert.equal(await callLlm({ prompt: "b", timeoutMs: 5_000 }), "ok");
});

test("malformed structured output from Ollama falls back to Gemini", async () => {
  ollamaEnv();
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("ollama.test")) {
      return jsonResponse(200, { message: { content: "sorry, here is prose instead of JSON" } });
    }
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: validRecipeJson }] } }]
    });
  }) as typeof fetch;

  const text = await callLlm({
    prompt: "Return a recipe JSON",
    timeoutMs: 5_000,
    validate: assertValidRecipeJson
  });
  assert.equal(text, validRecipeJson);
  assert.equal(urls.filter((url) => url.includes("ollama.test")).length, 1);
  assert.equal(urls.filter((url) => url.includes("generativelanguage.googleapis.com")).length, 1);
});

test("both providers return invalid structured output → meaningful error", async () => {
  ollamaEnv();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("ollama.test")) {
      return jsonResponse(200, { message: { content: "not json" } });
    }
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: "{}" }] } }]
    });
  }) as typeof fetch;

  await assert.rejects(
    () =>
      callLlm({
        prompt: "Return a recipe JSON",
        timeoutMs: 5_000,
        validate: assertValidRecipeJson
      }),
    (error: unknown) => {
      assert.ok(error instanceof AiRequestError);
      assert.equal(error.retryable, true);
      assert.match(error.message, /recipe missing required fields|incomplete recipe json/i);
      return true;
    }
  );
});

test("freeform text calls without validate remain unchanged", async () => {
  ollamaEnv();
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    // Non-JSON prose is fine when no validate callback is supplied.
    return jsonResponse(200, { message: { content: "A witty tasting note." } });
  }) as typeof fetch;

  assert.equal(await callLlm("Describe the pour", undefined, 5_000), "A witty tasting note.");
  assert.equal(urls.length, 1);
  assert.ok(!urls.some((url) => url.includes("generativelanguage.googleapis.com")));
});

test("API keys alone never add fallback providers", async () => {
  clearAiEnv();
  process.env.AI_PROVIDER = "ollama";
  process.env.OLLAMA_HOST = "http://ollama.test:11434";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.OPENAI_API_KEY = "openai-key";
  const runtime = describeAiRuntime(process.env);
  assert.equal(runtime.fallbackProviderEnv, null);
  assert.equal(runtime.fallback, null);
});

test("explicit AI_FALLBACK_PROVIDER=gemini builds a two-step chain only", async () => {
  clearAiEnv();
  process.env.AI_PROVIDER = "ollama";
  process.env.OLLAMA_HOST = "http://ollama.test:11434";
  process.env.AI_FALLBACK_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.OPENAI_API_KEY = "openai-should-not-join";
  const runtime = describeAiRuntime(process.env);
  assert.equal(runtime.fallbackProviderEnv, "gemini");
  assert.equal(runtime.fallback?.provider, "gemini");
  assert.equal(runtime.fallback?.model, defaultAiModel("gemini"));
});

test("OLLAMA_MODEL and GEMINI_MODEL aliases apply when AI_MODEL is blank", () => {
  clearAiEnv();
  process.env.AI_PROVIDER = "ollama";
  process.env.OLLAMA_MODEL = "gemma4:latest";
  process.env.OLLAMA_HOST = "http://ollama.test:11434";
  assert.equal(resolveAiConfig(process.env).model, "gemma4:latest");

  clearAiEnv();
  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "k";
  process.env.GEMINI_MODEL = "gemini-3.6-flash";
  assert.equal(resolveAiConfig(process.env).model, "gemini-3.6-flash");
});

test("default Ollama model is gemma4", () => {
  assert.equal(defaultAiModel("ollama"), "gemma4");
});

test("Ollama system prompts are sent as role=system messages", async () => {
  clearAiEnv();
  let posted: { messages?: Array<{ role?: string; content?: string; images?: string[] }> } | null = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    posted = JSON.parse(String(init?.body));
    return jsonResponse(200, { message: { content: "yes" } });
  }) as typeof fetch;

  await requestAi(
    {
      provider: "ollama",
      key: "",
      baseUrl: "http://ollama.test:11434",
      model: "gemma4"
    },
    "user prompt",
    "img64",
    5_000,
    undefined,
    undefined,
    "You return JSON only."
  );
  assert.equal(posted?.messages?.[0]?.role, "system");
  assert.equal(posted?.messages?.[0]?.content, "You return JSON only.");
  assert.equal(posted?.messages?.[1]?.role, "user");
  assert.deepEqual(posted?.messages?.[1]?.images, ["img64"]);
});

test("probeOllamaAiHealth checks tags without calling Gemini", async () => {
  const urls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return jsonResponse(200, { models: [{ name: "gemma4:latest" }] });
  }) as typeof fetch;

  const health = await probeOllamaAiHealth({
    baseUrl: "http://ollama.test:11434",
    model: "gemma4",
    fetchFn
  });
  assert.equal(health.reachable, true);
  assert.equal(health.modelAvailable, true);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/api\/tags$/);
});

test("401 on primary does not fall back", async () => {
  clearAiEnv();
  process.env.AI_PROVIDER = "openai";
  process.env.AI_API_KEY = "bad";
  process.env.AI_BASE_URL = "https://ai.example.test/v1";
  process.env.AI_FALLBACK_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(401, { error: { message: "invalid" } });
  }) as typeof fetch;

  await assert.rejects(() => callLlm("hello", undefined, 5_000), (error: unknown) => {
    assert.ok(error instanceof AiRequestError);
    assert.equal(error.statusCode, 401);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(calls, 1);
});
