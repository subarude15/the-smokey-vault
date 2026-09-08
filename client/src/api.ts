export type Item = Record<string, string | number | null> & { id: number };

const TOKEN_KEY = "smokey-token";

/** sessionStorage when available; otherwise in-memory (Node tests / non-browser). */
function tokenStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  try {
    if (typeof sessionStorage !== "undefined") return sessionStorage;
  } catch {
    // Private mode / blocked storage — fall through to memory.
  }
  const memory = new Map<string, string>();
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => { memory.set(key, String(value)); },
    removeItem: (key) => { memory.delete(key); }
  };
}

const storage = tokenStorage();
let adminToken = storage.getItem(TOKEN_KEY) ?? "";

/** True when a 401 rejection happened with no App listener yet (boot-time race). */
let keeperAuthRejectedPending = false;

export function setToken(token: string) {
  adminToken = token;
  storage.setItem(TOKEN_KEY, token);
  // A fresh unlock supersedes any prior unconsumed rejection.
  keeperAuthRejectedPending = false;
}

export function clearToken() {
  adminToken = "";
  storage.removeItem(TOKEN_KEY);
}

/** Carries the status so callers can tell a refused request from an unreachable server. */
export class ApiError extends Error {
  readonly status: number;
  /** Structured eligibility / domain reason when the server provides one. */
  readonly reason: string | null;
  constructor(message: string, status: number, reason: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.reason = reason;
  }
}

export const UNREACHABLE_STATUS = 0;

type KeeperAuthRejectedListener = () => void;
const keeperAuthRejectedListeners = new Set<KeeperAuthRejectedListener>();

/**
 * Subscribe to Keeper bearer rejection (authenticated request → HTTP 401).
 * Returns an unsubscribe function. Used by App to call handToGuest().
 * If a rejection already occurred before any listener registered (mount race),
 * the new listener is invoked once immediately so the signal is not lost.
 */
export function onKeeperAuthRejected(listener: KeeperAuthRejectedListener): () => void {
  keeperAuthRejectedListeners.add(listener);
  if (keeperAuthRejectedPending) {
    keeperAuthRejectedPending = false;
    try {
      listener();
    } catch {
      // UI listeners must not break the API error path.
    }
  }
  return () => { keeperAuthRejectedListeners.delete(listener); };
}

/**
 * Tear down an invalid Keeper session once: clear the stored token and notify
 * listeners. Concurrent 401s only notify on the first clear (idempotent).
 * With no listeners yet, the rejection stays pending until App subscribes.
 */
export function notifyKeeperAuthRejected(): void {
  const stillHadToken = Boolean(adminToken);
  clearToken();
  if (!stillHadToken) return;
  if (keeperAuthRejectedListeners.size === 0) {
    keeperAuthRejectedPending = true;
    return;
  }
  keeperAuthRejectedPending = false;
  for (const listener of [...keeperAuthRejectedListeners]) {
    try {
      listener();
    } catch {
      // UI listeners must not break the API error path.
    }
  }
}

/** Shared path for authenticated 401s from api() and authenticated direct fetches. */
function rejectKeeperSessionIfAuthenticated(sentAuth: boolean): void {
  if (!sentAuth) return;
  notifyKeeperAuthRejected();
}

function encodeApiBody(body: BodyInit | null | undefined): BodyInit | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (typeof FormData !== "undefined" && body instanceof FormData) return body;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body;
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) return body as BodyInit;
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return body;
  // Plain objects were a footgun: Content-Type became application/json while the
  // runtime sent "[object Object]" / empty, and Fastify answered "Bad Request".
  if (typeof body === "object") return JSON.stringify(body);
  return body;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const sentAuth = Boolean(adminToken);
  const body = encodeApiBody(options.body);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      body,
      headers: {
        ...(body != null && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
        ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
        ...options.headers
      }
    });
  } catch (error) {
    // Preserve aborts so callers (mixologist timeout) can tell cancel from downtime.
    if (options.signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("Cannot reach the vault server", UNREACHABLE_STATUS);
  }
  if (!response.ok) {
    if (response.status === 401) rejectKeeperSessionIfAuthenticated(sentAuth);
    const payload = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      message?: string;
      reason?: string;
    };
    // Prefer the intentional server error string. Fastify content-type failures use
    // error:"Bad Request" with the detail in message — surface message then.
    const message =
      payload.error && payload.error !== "Bad Request"
        ? payload.error
        : payload.message || payload.error || "Request failed";
    throw new ApiError(message, response.status, payload.reason ?? null);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export async function downloadExport(format: "db" | "json" | "csv", table?: string) {
  const sentAuth = Boolean(adminToken);
  const response = await fetch(`/api/export?format=${format}${table ? `&table=${table}` : ""}`, {
    headers: adminToken ? { authorization: `Bearer ${adminToken}` } : {}
  });
  if (!response.ok) {
    if (response.status === 401) rejectKeeperSessionIfAuthenticated(sentAuth);
    throw new Error("Export failed");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = format === "db" ? "smokeyvault.db" : `smokeyvault.${format}`;
  link.click();
  URL.revokeObjectURL(url);
}

export const tokenExists = () => Boolean(adminToken);
