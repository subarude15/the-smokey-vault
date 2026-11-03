/**
 * Keeper-editable homepage message (plain text). Guests only see the published
 * value when enabled; disable hides without clearing the saved draft.
 */

export const DEFAULT_HOMEPAGE_MESSAGE = "Pull up a stool. Tonight's yours.";
export const MAX_HOMEPAGE_MESSAGE = 200;
export const HOMEPAGE_MESSAGE_KEY = "homepage_message";
export const HOMEPAGE_MESSAGE_ENABLED_KEY = "homepage_message_enabled";

/** Strip tags / controls and clip to the recommended max. Keeps intentional newlines. */
export function sanitizeHomepageMessage(value: unknown): string {
  let text = String(value ?? "");
  text = text.replace(/<[^>]*>/g, "");
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  text = text.replace(/\r\n?/g, "\n");
  if (text.length > MAX_HOMEPAGE_MESSAGE) text = text.slice(0, MAX_HOMEPAGE_MESSAGE);
  return text;
}

export function normalizeHomepageMessageEnabled(value: unknown): "0" | "1" {
  if (value === undefined || value === null || value === "") return "1";
  return value === "1" || value === true || value === "true" ? "1" : "0";
}

/**
 * Guest/Keeper homepage copy when the message is enabled. Returns null when
 * disabled so the UI can hide it without discarding settings.
 */
export function publishedHomepageMessage(settings?: Record<string, string> | null): string | null {
  if (normalizeHomepageMessageEnabled(settings?.[HOMEPAGE_MESSAGE_ENABLED_KEY]) !== "1") return null;
  const raw = settings?.[HOMEPAGE_MESSAGE_KEY];
  const text = sanitizeHomepageMessage(
    raw === undefined || raw === "" ? DEFAULT_HOMEPAGE_MESSAGE : raw,
  );
  if (!text.replace(/\s/g, "").length) return DEFAULT_HOMEPAGE_MESSAGE;
  return text.trimEnd();
}
