import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAiFailoverChain, defaultAiModel, isRetryableAiStatus, resolveAiModel, type AiProviderConfig } from "./ai_providers.js";

const gemini: AiProviderConfig = {
  provider: "gemini",
  key: "primary-key",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  model: "gemini-3.6-flash"
};

test("only providers holding an environment key join the chain", () => {
  const chain = buildAiFailoverChain(gemini, { OPENAI_API_KEY: "openai-key", ANTHROPIC_API_KEY: "anthropic-key" });
  assert.deepEqual(chain.map((config) => config.provider), ["gemini", "openai", "anthropic"]);
});

test("the chain follows gemini, openai, openrouter, anthropic", () => {
  const openai: AiProviderConfig = { provider: "openai", key: "k", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" };
  const chain = buildAiFailoverChain(openai, {
    ANTHROPIC_API_KEY: "a",
    OPENROUTER_API_KEY: "b",
    GEMINI_API_KEY: "c"
  });
  assert.deepEqual(chain.map((config) => config.provider), ["openai", "gemini", "openrouter", "anthropic"]);
});

test("the primary provider is never queued twice, even holding its own env key", () => {
  const chain = buildAiFailoverChain(gemini, { GEMINI_API_KEY: "primary-key", OPENAI_API_KEY: "openai-key" });
  assert.deepEqual(chain.map((config) => config.provider), ["gemini", "openai"]);
});

test("a lone provider with no other keys yields a chain of one", () => {
  assert.deepEqual(buildAiFailoverChain(gemini, {}).map((config) => config.provider), ["gemini"]);
});

test("blank and whitespace-only keys are ignored", () => {
  const chain = buildAiFailoverChain(gemini, { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "   " });
  assert.deepEqual(chain.map((config) => config.provider), ["gemini"]);
});

test("a fallback carries its own model, not the primary's", () => {
  const chain = buildAiFailoverChain(gemini, { OPENAI_API_KEY: "openai-key" });
  assert.equal(chain[1].model, defaultAiModel("openai"));
  assert.notEqual(chain[1].model, gemini.model, "handing a Gemini model to OpenAI would just fail again");
  assert.equal(chain[1].baseUrl, "https://api.openai.com/v1");
  assert.equal(chain[1].key, "openai-key");
});

test("a stalled Ollama box fails over to a cloud key", () => {
  const ollama: AiProviderConfig = { provider: "ollama", key: "", baseUrl: "http://localhost:11434", model: "llama3.2" };
  const chain = buildAiFailoverChain(ollama, { GEMINI_API_KEY: "gemini-key" });
  assert.deepEqual(chain.map((config) => config.provider), ["ollama", "gemini"]);
});

test("rate limits, timeouts, and upstream faults are retryable", () => {
  assert.equal(isRetryableAiStatus(429), true);
  assert.equal(isRetryableAiStatus(408), true);
  assert.equal(isRetryableAiStatus(500), true);
  assert.equal(isRetryableAiStatus(502), true);
  assert.equal(isRetryableAiStatus(503), true);
});

test("a retired model name moves on to the next provider", () => {
  assert.equal(isRetryableAiStatus(404), true);
});

test("a rejected key or a bad request stops the walk", () => {
  assert.equal(isRetryableAiStatus(400), false);
  assert.equal(isRetryableAiStatus(401), false);
  assert.equal(isRetryableAiStatus(403), false);
  assert.equal(isRetryableAiStatus(422), false);
});

test("the OpenRouter fallback reads labels as well as text", () => {
  const chain = buildAiFailoverChain(gemini, { OPENROUTER_API_KEY: "router-key" });
  assert.equal(chain[1].model, "stealth/ox-alpha");
});

test("retired Gemini model names fall back to the current Flash alias", () => {
  assert.equal(resolveAiModel("gemini", "gemini-2.5-flash"), "gemini-3.6-flash");
  assert.equal(resolveAiModel("gemini", "models/gemini-2.0-flash"), "gemini-3.6-flash");
  assert.equal(resolveAiModel("gemini", "gemini-3.6-flash"), "gemini-3.6-flash");
  assert.equal(resolveAiModel("openrouter", "stealth/ox-alpha"), "stealth/ox-alpha");
});
