/**
 * Thin Figranium REST client (self-hosted browser automation).
 * Enabled only when FIGRANIUM_BASE_URL + FIGRANIUM_API_KEY are set.
 */
import { z } from "zod";

export const FIGRANIUM_TIMEOUT_MS = Number(process.env.FIGRANIUM_TIMEOUT_MS ?? 120_000);

export const FigraniumEnvelopeSchema = z
  .object({
    outcome: z.string().nullable().optional(),
    success: z.boolean().optional(),
    final_url: z.string().nullable().optional(),
    logs: z.array(z.string()).optional(),
    data: z.unknown().optional(),
    html: z.string().nullable().optional(),
    screenshot_url: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    runId: z.string().nullable().optional()
  })
  .passthrough();

export type FigraniumEnvelope = z.infer<typeof FigraniumEnvelopeSchema>;

export type FigraniumRunKind =
  | "success"
  | "unavailable"
  | "auth_error"
  | "retryable_error"
  | "invalid_response";

export type FigraniumRunResult<T = unknown> =
  | {
      kind: "success";
      httpStatus: number;
      envelope: FigraniumEnvelope;
      data: T;
    }
  | {
      kind: "unavailable";
      message: string;
    }
  | {
      kind: "auth_error";
      httpStatus: number;
      message: string;
    }
  | {
      kind: "retryable_error";
      httpStatus?: number;
      message: string;
    }
  | {
      kind: "invalid_response";
      httpStatus?: number;
      message: string;
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
  return trimEnv(process.env.FIGRANIUM_BASE_URL).replace(/\/+$/, "");
}

export function getFigraniumApiKey(): string {
  return trimEnv(process.env.FIGRANIUM_API_KEY);
}

/** Figranium HTTP client is usable only when both base URL and API key are set. */
export function isFigraniumConfigured(): boolean {
  return Boolean(getFigraniumBaseUrl() && getFigraniumApiKey());
}

function authHeaders(): Record<string, string> {
  const key = getFigraniumApiKey();
  if (!key) return {};
  return {
    Authorization: `Bearer ${key}`,
    "x-api-key": key
  };
}

function isTimeoutOrAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  return code === "ABORT_ERR" || code === "ETIMEDOUT";
}

function isNetworkReset(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (
    code === "ECONNRESET"
    || code === "ECONNREFUSED"
    || code === "EPIPE"
    || code === "ENOTFOUND"
    || code === "EAI_AGAIN"
    || code === "UND_ERR_CONNECT_TIMEOUT"
    || code === "UND_ERR_SOCKET"
  ) {
    return true;
  }
  const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  return /fetch failed|network|socket|ECONNRESET|ECONNREFUSED/i.test(message);
}

function classifyHttpFailure(status: number): Extract<
  FigraniumRunResult,
  { kind: "auth_error" | "retryable_error" | "invalid_response" }
> {
  if (status === 401 || status === 403) {
    return {
      kind: "auth_error",
      httpStatus: status,
      message: `Figranium auth failed (${status})`
    };
  }
  if (status === 502 || status === 503 || status === 504) {
    return {
      kind: "retryable_error",
      httpStatus: status,
      message: `Figranium temporarily unavailable (${status})`
    };
  }
  return {
    kind: "invalid_response",
    httpStatus: status,
    message: `Figranium HTTP ${status}`
  };
}

function envelopeSucceeded(envelope: FigraniumEnvelope): boolean {
  if (envelope.outcome === "success") return true;
  if (envelope.success === true) return true;
  return false;
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
  if (!isFigraniumConfigured()) return { ok: false };
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
 * When `schema` is provided, `data` is parsed strictly; failure → `invalid_response`.
 */
export async function figraniumRunTask<T = unknown>(
  taskId: string,
  options: FigraniumRunOptions & { schema?: z.ZodType<T> } = {}
): Promise<FigraniumRunResult<T>> {
  const id = trimEnv(taskId);
  if (!id || !isFigraniumConfigured()) {
    return { kind: "unavailable", message: "Figranium is not configured" };
  }

  const body: Record<string, unknown> = {};
  if (options.variables) body.variables = options.variables;
  if (options.webhookUrl) body.webhookUrl = options.webhookUrl;
  if (options.statelessExecution != null) body.statelessExecution = options.statelessExecution;
  if (options.sessionId) body.sessionId = options.sessionId;

  let response: Response;
  try {
    response = await figraniumFetch(`/api/tasks/${encodeURIComponent(id)}/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? FIGRANIUM_TIMEOUT_MS
    });
  } catch (error) {
    if (isTimeoutOrAbort(error) || isNetworkReset(error)) {
      return {
        kind: "retryable_error",
        message: "Figranium network/timeout failure"
      };
    }
    return {
      kind: "retryable_error",
      message: "Figranium request failed"
    };
  }

  if (!response.ok) {
    return classifyHttpFailure(response.status);
  }

  const raw: unknown = await response.json().catch(() => null);
  const envelopeParsed = FigraniumEnvelopeSchema.safeParse(raw);
  if (!envelopeParsed.success) {
    return {
      kind: "invalid_response",
      httpStatus: response.status,
      message: "Figranium response failed envelope schema validation"
    };
  }

  const envelope = envelopeParsed.data;
  if (!envelopeSucceeded(envelope)) {
    return {
      kind: "invalid_response",
      httpStatus: response.status,
      message: envelope.error?.trim() || "Figranium task did not succeed"
    };
  }

  if (options.schema) {
    const dataParsed = options.schema.safeParse(envelope.data);
    if (!dataParsed.success) {
      return {
        kind: "invalid_response",
        httpStatus: response.status,
        message: "Figranium task data failed schema validation"
      };
    }
    return {
      kind: "success",
      httpStatus: response.status,
      envelope,
      data: dataParsed.data
    };
  }

  return {
    kind: "success",
    httpStatus: response.status,
    envelope,
    data: envelope.data as T
  };
}
