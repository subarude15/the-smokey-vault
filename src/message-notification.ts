import { createMessage } from "./speakeasy.js";
import type { GuestMessage } from "./speakeasy-shared.js";
import {
  createSmtpTransport,
  isEmailAddress,
  parseMailbox,
  readSmtpConfig,
  type MailTransport,
  type OutboundMail
} from "./mail.js";

/** ponytail: one SMTP send, first 10 unique addresses. Raise this if more owners need a copy. */
const MAX_NOTIFICATION_RECIPIENTS = 10;

export type MailLog = {
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
};

export type GuestMessageNotice = {
  id?: number;
  sender_name?: string | null;
  contact_info?: string | null;
  body?: string | null;
  created_at?: string | null;
};

export type NotifyDeps = {
  env?: NodeJS.ProcessEnv;
  transport?: MailTransport | null;
  pageUrl?: unknown;
  vaultUrl?: unknown;
  logger?: MailLog;
};

export type NotifyOutcome =
  | { status: "skipped"; reason: "no_recipients" | "smtp_unconfigured" }
  | { status: "sent"; recipients: string[] }
  | { status: "failed"; recipients: string[]; error: string };

export type BuiltGuestMessageMail = OutboundMail;

let transportOverride: { current: MailTransport | null } | undefined;

/** Route tests inject a transport without standing up SMTP. Pass undefined to clear. */
export function setGuestMessageMailTransportForTests(transport: MailTransport | null | undefined): void {
  transportOverride = transport === undefined ? undefined : { current: transport };
}

export function parseNotificationEmails(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const email = part.trim();
    const key = email.toLowerCase();
    if (!isEmailAddress(email) || seen.has(key)) continue;
    seen.add(key);
    out.push(email);
    if (out.length >= MAX_NOTIFICATION_RECIPIENTS) break;
  }
  return out;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** http(s) only, no embedded credentials. */
export function safeHttpUrl(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 500 || /[\r\n\s]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Page context is included only when the Referer host is this vault (request host
 * or VAULT_PUBLIC_URL). An arbitrary Referer is not turned into a link in the email.
 */
export function relevantPageUrl(referer: unknown, allowed: Array<string | null | undefined>): string | null {
  const page = safeHttpUrl(referer);
  if (!page) return null;
  const pageHost = new URL(page).host.toLowerCase();
  for (const candidate of allowed) {
    if (!candidate) continue;
    const asUrl = safeHttpUrl(candidate) ?? safeHttpUrl(`http://${String(candidate).trim()}`);
    if (!asUrl) continue;
    if (new URL(asUrl).host.toLowerCase() === pageHost) return page;
  }
  return null;
}

export function vaultLinkFromRequest(parts: {
  configured?: string | null;
  protocol?: string | null;
  host?: string | null;
}): string | null {
  const configured = safeHttpUrl(parts.configured);
  if (configured) return configured;
  const host = String(parts.host ?? "").trim();
  if (!host || /[\s/\\]/.test(host)) return null;
  const protocol = parts.protocol === "https" ? "https" : parts.protocol === "http" ? "http" : null;
  if (!protocol) return null;
  return safeHttpUrl(`${protocol}://${host}/`);
}

function singleLine(value: string, max = 300): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim().slice(0, max);
}

function present(value: string | null | undefined, fallback: string): string {
  const text = singleLine(String(value ?? ""));
  return text || fallback;
}

function messageBody(value: string | null | undefined): string {
  const text = String(value ?? "").replace(/\u0000/g, "").trim();
  return text || "(No message text)";
}

function receivedLabel(createdAt: string | null | undefined): string {
  const raw = singleLine(String(createdAt ?? ""));
  if (!raw) return "Not available";
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return `${raw} UTC`;
  return raw;
}

export function buildGuestMessageMail(input: GuestMessageNotice & { pageUrl?: unknown; vaultUrl?: unknown }): BuiltGuestMessageMail {
  const name = present(input.sender_name, "Not provided");
  const contact = present(input.contact_info, "Not provided");
  const body = messageBody(input.body);
  const received = receivedLabel(input.created_at);
  const pageUrl = safeHttpUrl(input.pageUrl);
  const vaultUrl = safeHttpUrl(input.vaultUrl);
  const replyTo = parseMailbox(String(input.contact_info ?? "").trim()) ?? undefined;
  const subjectName = present(input.sender_name, "a guest");
  const subject = singleLine(`Vault message from ${subjectName}`, 120);

  const lines = [
    "A guest left a message at the vault.",
    "",
    `From: ${name}`,
    `Contact: ${contact}`,
    `Received: ${received}`,
    "Source: Guest contact form"
  ];
  if (pageUrl) lines.push(`Page: ${pageUrl}`);
  lines.push("", "Message:", body);
  if (vaultUrl) lines.push("", `Open Smokey Vault: ${vaultUrl}`, "The message is in Keeper → Messages.");

  const rows = [
    ["From", name],
    ["Contact", contact],
    ["Received", received],
    ["Source", "Guest contact form"]
  ];
  if (pageUrl) rows.push(["Page", pageUrl]);
  const table = rows.map(([label, value]) =>
    `<tr><th align="left">${escapeHtml(label ?? "")}</th><td>${escapeHtml(value ?? "")}</td></tr>`
  ).join("");
  const link = vaultUrl
    ? `<p><a href="${escapeHtml(vaultUrl)}">Open Smokey Vault</a></p><p>The message is in Keeper → Messages.</p>`
    : "";
  const html = [
    "<!DOCTYPE html>",
    "<html><body>",
    "<p>A guest left a message at the vault.</p>",
    `<table>${table}</table>`,
    `<p style="white-space:pre-wrap">${escapeHtml(body)}</p>`,
    link,
    "</body></html>"
  ].join("");

  return {
    to: [],
    subject,
    text: lines.join("\n"),
    html,
    replyTo
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "Email notification failed";
}

function redactSecret(message: string, secret: string): string {
  const safe = secret && secret.length >= 4 ? message.replaceAll(secret, "[redacted]") : message;
  return safe.slice(0, 500);
}

function resolveTransport(env: NodeJS.ProcessEnv, explicit: MailTransport | null | undefined): MailTransport | null {
  if (explicit !== undefined) return explicit;
  if (transportOverride) return transportOverride.current;
  const config = readSmtpConfig(env);
  return config ? createSmtpTransport(config) : null;
}

/**
 * Sends the owner notification. Never throws: a provider failure is logged and returned.
 * No recipients (feature off) is silent. Recipients without SMTP are a warning.
 */
export async function notifyOwnersOfGuestMessage(message: GuestMessageNotice, deps: NotifyDeps = {}): Promise<NotifyOutcome> {
  const env = deps.env ?? process.env;
  const recipients = parseNotificationEmails(env.MESSAGE_NOTIFICATION_EMAILS);
  const messageId = message.id;
  if (recipients.length === 0) return { status: "skipped", reason: "no_recipients" };

  const transport = resolveTransport(env, deps.transport);
  if (!transport) {
    deps.logger?.warn(
      { messageId, recipients: recipients.length },
      "Guest message email notification skipped: SMTP is not configured"
    );
    return { status: "skipped", reason: "smtp_unconfigured" };
  }

  const built = buildGuestMessageMail({
    ...message,
    pageUrl: deps.pageUrl,
    vaultUrl: deps.vaultUrl
  });
  // Redact even when host/from are missing, so a thrown client error cannot echo SMTP_PASS into logs.
  const secret = (env.SMTP_PASS ?? "").replace(/[\r\n]/g, "");
  try {
    await transport.send({ ...built, to: recipients });
    deps.logger?.info({ messageId, recipients: recipients.length }, "Emailed guest message notification");
    return { status: "sent", recipients };
  } catch (error) {
    const safe = redactSecret(errorText(error), secret);
    deps.logger?.error(
      { messageId, recipients: recipients.length, error: safe },
      "Guest message email notification failed"
    );
    return { status: "failed", recipients, error: safe };
  }
}

/**
 * Stores the guest message, then notifies. Validation errors still throw.
 * Notification problems do not.
 */
export async function acceptGuestMessage(
  input: { sender_name?: unknown; contact_info?: unknown; body?: unknown },
  deps: NotifyDeps = {}
): Promise<GuestMessage> {
  const message = createMessage(input);
  try {
    await notifyOwnersOfGuestMessage(message, deps);
  } catch (error) {
    const secret = ((deps.env ?? process.env).SMTP_PASS ?? "").replace(/[\r\n]/g, "");
    deps.logger?.error(
      { messageId: message.id, error: redactSecret(errorText(error), secret) },
      "Guest message email notification failed"
    );
  }
  return message;
}
