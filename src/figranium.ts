/**
 * Thin Figranium REST client (self-hosted browser automation).
 * No SDK dependency — matches cola/catalog.beer fetch style.
 *
 * Default host for this project: https://fig.thesmokeybarrelbar.com
 */

export const FIGRANIUM_DEFAULT_BASE_URL = "https://fig.thesmokeybarrelbar.com";
export const FIGRANIUM_TIMEOUT_MS = Number(process.env.FIGRANIUM_TIMEOUT_MS ?? 120_000);

export type FigraniumExecutionResult<T = unknown> = {
  outcome?: string | null;
  success?: boolean;
  final_url?: string | null;
  logs?: string[];
  data?: T;
  html?: string | null;
  screenshot_url?: string | null;
  error?: string | null;
  runId?: string | null;
};

export type FigraniumRunOptions = {
  variables?: Record<string, string | number | boolean | null>;
  webhookUrl?: string;
  statelessExecution?: boolean;
  sessionId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function trimEnv(value: string | undefined): string {
  return String(value ?? "").trim();
}

export function getFigraniumBaseUrl(): string {
  const raw = trimEnv(process.env.FIGRANIUM_BASE_URL) || FIGRANIUM_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

export function getFigraniumApiKey(): string {
  return trimEnv(process.env.FIGRANIUM_API_KEY);
}

export function isFigraniumConfigured(): boolean {
  return Boolean(getFigraniumApiKey());
}

function authHeaders(): Record<string, string> {
  const key = getFigraniumApiKey();
  if (!key) return {};
  return {
    Authorization: `Bearer ${key}`,
    "x-api-key": key
  };
}

async function figraniumFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? FIGRANIUM_TIMEOUT_MS;
  const { timeoutMs: _ignored, ...rest } = init;
  const signal =
    rest.signal
    ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
  return fetch(`${getFigraniumBaseUrl()}${path}`, {
    ...rest,
    signal,
    headers: {
      Accept: "application/json",
      "User-Agent": "the-smokey-vault-figranium/1.0",
      ...authHeaders(),
      ...(rest.headers ?? {})
    }
  });
}

export async function figraniumHealth(): Promise<{ ok: boolean; status?: string; raw?: unknown }> {
  try {
    const response = await figraniumFetch("/api/health", { timeoutMs: 15_000 });
    const raw: unknown = await response.json().catch(() => null);
    const status =
      raw && typeof raw === "object" && "status" in raw
        ? String((raw as { status?: unknown }).status ?? "")
        : "";
    return { ok: response.ok && status === "ok", status: status || undefined, raw };
  } catch {
    return { ok: false };
  }
}

/**
 * Trigger a saved Figranium task (`POST /api/tasks/:id/api`).
 * Returns null when Figranium is not configured or the request fails hard.
 */
export async function figraniumRunTask<T = unknown>(
  taskId: string,
  options: FigraniumRunOptions = {}
): Promise<FigraniumExecutionResult<T> | null> {
  const id = trimEnv(taskId);
  if (!id || !isFigraniumConfigured()) return null;

  const body: Record<string, unknown> = {};
  if (options.variables) body.variables = options.variables;
  if (options.webhookUrl) body.webhookUrl = options.webhookUrl;
  if (options.statelessExecution != null) body.statelessExecution = options.statelessExecution;
  if (options.sessionId) body.sessionId = options.sessionId;

  try {
    const response = await figraniumFetch(`/api/tasks/${encodeURIComponent(id)}/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? FIGRANIUM_TIMEOUT_MS
    });
    if (!response.ok) return null;
    const raw: unknown = await response.json().catch(() => null);
    if (!raw || typeof raw !== "object") return null;
    return raw as FigraniumExecutionResult<T>;
  } catch {
    return null;
  }
}
