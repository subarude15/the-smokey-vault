/**
 * Share / copy helpers for published event deep links.
 * Prefer Web Share API; fall back to Clipboard; otherwise surface the URL.
 */

export type EventSharePayload = {
  title: string;
  text: string;
  url: string;
};

export type EventShareResult = "shared" | "copied" | "fallback" | "cancelled";

export function buildEventSharePayload(
  event: { title: string; event_date?: string },
  url: string
): EventSharePayload {
  const title = String(event.title ?? "").trim() || "Event";
  const date = String(event.event_date ?? "").trim();
  const text = date ? `${title} — ${date}` : title;
  return { title, text, url };
}

export async function shareOrCopyEventLink(
  payload: EventSharePayload,
  apis: {
    canShare?: boolean;
    share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
    clipboardWrite?: (text: string) => Promise<void>;
  } = {}
): Promise<EventShareResult> {
  const canShare = apis.canShare
    ?? (typeof navigator !== "undefined" && typeof navigator.share === "function");
  const share = apis.share
    ?? (canShare && typeof navigator !== "undefined" ? navigator.share.bind(navigator) : undefined);
  const clipboardWrite = apis.clipboardWrite
    ?? (typeof navigator !== "undefined" && navigator.clipboard?.writeText
      ? navigator.clipboard.writeText.bind(navigator.clipboard)
      : undefined);

  if (share) {
    try {
      await share({ title: payload.title, text: payload.text, url: payload.url });
      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return "cancelled";
      // Share failed — fall through to clipboard.
    }
  }

  if (clipboardWrite) {
    try {
      await clipboardWrite(payload.url);
      return "copied";
    } catch {
      // Clipboard failed — fall through to visible URL fallback.
    }
  }

  return "fallback";
}
