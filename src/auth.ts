/**
 * Admin-session and PIN authorization helpers.
 * Inventory mutations and future enrichment mutations must use requireAdmin.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyPin } from "./db.js";

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
