/**
 * Admin-session and PIN authorization helpers.
 * Inventory mutations and future enrichment mutations must use requireAdmin.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyPin } from "./db.js";

/** Values that must never be used as HMAC keys — they are public or empty. */
const PLACEHOLDER_SESSION_SECRETS = new Set([
  "",
  "replace-with-a-long-random-value",
  "change-this-on-your-server"
]);

export function isUsableSessionSecret(value: string | undefined | null): value is string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && !PLACEHOLDER_SESSION_SECRETS.has(trimmed);
}

/**
 * Picks a signing secret that is not empty and not a documented placeholder.
 * NAS compose sets SESSION_SECRET=${SESSION_SECRET:-}, which becomes "" when
 * the key is missing from .env — `??` does not treat "" as missing, so the old
 * `${dbPath}:smokey-vault` fallback never ran and tokens were HMAC'd with "".
 */
export function resolveSessionSecret(
  envValue: string | undefined,
  storedValue?: string | null,
  generate: () => string = () => randomBytes(32).toString("hex")
): { secret: string; persist: boolean; source: "env" | "stored" | "generated" } {
  if (isUsableSessionSecret(envValue)) return { secret: envValue.trim(), persist: false, source: "env" };
  if (isUsableSessionSecret(storedValue)) return { secret: storedValue.trim(), persist: false, source: "stored" };
  return { secret: generate(), persist: true, source: "generated" };
}

export function createAdminToken(secret: string, exp = Date.now() + 15 * 60_000): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function isAdmin(header: string | undefined, secret: string): boolean {
  const raw = header?.replace(/^Bearer /i, "");
  if (!raw) return false;
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now();
  } catch {
    return false;
  }
}

export function requireAdmin(
  request: { headers: { authorization?: string } },
  reply: { code: (n: number) => { send: (v: unknown) => unknown } },
  secret: string
) {
  if (!isAdmin(request.headers.authorization, secret)) {
    return reply.code(401).send({ error: "Admin session required" });
  }
}

function samePin(pin: string, candidate?: string) {
  if (!candidate) return false;
  const a = Buffer.from(pin);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Stored keeper PIN, plus optional env overrides (ADMIN_PIN / MASTER_PIN)
 * for recovery when the stored PIN is forgotten.
 */
export function pinAccepted(pin: string): boolean {
  return (
    verifyPin(pin) ||
    samePin(pin, process.env.ADMIN_PIN) ||
    samePin(pin, process.env.MASTER_PIN)
  );
}
