import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAiFailoverChain,
  defaultAiModel,
  isRetryableAiStatus,
  resolveAiModel,
  type AiProviderConfig
} from "./ai_providers.js";

const gemini: AiProviderConfig = {
  provider: "gemini",
  key: "primary-key",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  model: "gemini-3.6-flash"
};

const ollama: AiProviderConfig = {
  provider: "ollama",
  key: "",
  baseUrl: "http://localhost:11434",
  model: "gemma4"
};

test("blank AI_FALLBACK_PROVIDER is primary-only even when other API keys exist", () => {
  const chain = buildAiFailoverChain(ollama, {
    GEMINI_API_KEY: "gemini-key",
    OPENAI_API_KEY: "openai-key",
    OPENROUTER_API_KEY: "router-key",
    ANTHROPIC_API_KEY: "anthropic-key"
  });
  assert.deepEqual(chain.map((config) => config.provider), ["ollama"]);
});

test("whitespace AI_FALLBACK_PROVIDER is primary-only", () => {
  const chain = buildAiFailoverChain(ollama, {
    AI_FALLBACK_PROVIDER: "  ",
    GEMINI_API_KEY: "gemini-key",
    OPENAI_API_KEY: "openai-key"
  });
  assert.deepEqual(chain.map((config) => config.provider), ["ollama"]);
});

test("AI_FALLBACK_PROVIDER=gemini builds exactly [primary, gemini]", () => {
  const chain = buildAiFailoverChain(ollama, {
    AI_FALLBACK_PROVIDER: "gemini",
    GEMINI_API_KEY: "gemini-key",
    OPENAI_API_KEY: "openai-should-not-join",
    GEMINI_MODEL: "gemini-3.6-flash"
  });
  assert.deepEqual(chain.map((config) => config.provider), ["ollama", "gemini"]);
  assert.equal(chain[1].model, "gemini-3.6-flash");
  assert.equal(chain[1].key, "gemini-key");
});

test("AI_FALLBACK_PROVIDER without a key yields primary only", () => {
  const chain = buildAiFailoverChain(ollama, { AI_FALLBACK_PROVIDER: "gemini" });
  assert.deepEqual(chain.map((config) => config.provider), ["ollama"]);
});

test("AI_FALLBACK_PROVIDER matching primary yields primary only", () => {
  const chain = buildAiFailoverChain(gemini, {
    AI_FALLBACK_PROVIDER: "gemini",
    GEMINI_API_KEY: "gemini-key",
    OPENAI_API_KEY: "openai-key"
  });
  assert.deepEqual(chain.map((config) => config.provider), ["gemini"]);
});

test("a fallback carries its own model, not the primary's", () => {
  const chain = buildAiFailoverChain(
    { ...ollama, model: "gemma4" },
    { AI_FALLBACK_PROVIDER: "gemini", GEMINI_API_KEY: "gemini-key" }
  );
  assert.equal(chain[1].model, defaultAiModel("gemini"));
  assert.notEqual(chain[1].model, "gemma4");
  assert.equal(chain[1].baseUrl, "https://generativelanguage.googleapis.com/v1beta");
});

test("lone primary with no fallback env yields a chain of one", () => {
  assert.deepEqual(buildAiFailoverChain(gemini, {}).map((config) => config.provider), ["gemini"]);
});

test("default Ollama chat model is gemma4", () => {
  assert.equal(defaultAiModel("ollama"), "gemma4");
});

test("rate limits, timeouts, and upstream faults are retryable", () => {
  assert.equal(isRetryableAiStatus(429), true);
  assert.equal(isRetryableAiStatus(408), true);
  assert.equal(isRetryableAiStatus(500), true);
  assert.equal(isRetryableAiStatus(502), true);
  assert.equal(isRetryableAiStatus(503), true);
});

test("a retired model name is retryable for fallback", () => {
  assert.equal(isRetryableAiStatus(404), true);
});

test("a rejected key or a bad request does not fallback", () => {
  assert.equal(isRetryableAiStatus(400), false);
  assert.equal(isRetryableAiStatus(401), false);
  assert.equal(isRetryableAiStatus(403), false);
  assert.equal(isRetryableAiStatus(422), false);
});

test("retired Gemini model names fall back to the current Flash alias", () => {
  assert.equal(resolveAiModel("gemini", "gemini-2.5-flash"), "gemini-3.6-flash");
  assert.equal(resolveAiModel("gemini", "models/gemini-2.0-flash"), "gemini-3.6-flash");
  assert.equal(resolveAiModel("gemini", "gemini-3.6-flash"), "gemini-3.6-flash");
  assert.equal(resolveAiModel("openrouter", "stealth/ox-alpha"), "stealth/ox-alpha");
});
