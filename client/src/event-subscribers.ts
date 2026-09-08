/**
 * Pure helpers for the Keeper event-subscriber (invite list) UI.
 * Subscribers live in `event_subscribers` and are separate from Guest messages.
 */

export type SubscriberLike = {
  id: number;
  name: string;
  contact_info: string;
  notes: string;
  created_at: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+]?[\d\s().\-]+$/;

/** Conservative contact → href. Email → mailto:, phone-ish → tel:, else null. */
export function subscriberContactHref(contact: string): string | null {
  const trimmed = String(contact ?? "").trim();
  if (!trimmed) return null;
  if (EMAIL_RE.test(trimmed)) return `mailto:${trimmed}`;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 7 && digits.length <= 15 && PHONE_RE.test(trimmed)) {
    return `tel:${digits}`;
  }
  return null;
}

export function filterEventSubscribers<T extends SubscriberLike>(
  subscribers: T[],
  query: string
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return subscribers;
  return subscribers.filter((row) => {
    const haystack = `${row.name}\n${row.contact_info}\n${row.notes}`.toLowerCase();
    return haystack.includes(needle);
  });
}

export function formatSubscriberJoined(raw: string): string {
  const stamp = Date.parse(raw);
  if (!Number.isFinite(stamp)) return raw || "—";
  return new Date(stamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

export function formatSubscriberContactLine(subscriber: Pick<SubscriberLike, "name" | "contact_info">): string {
  const name = String(subscriber.name ?? "").trim() || "Guest";
  const contact = String(subscriber.contact_info ?? "").trim();
  return contact ? `${name} — ${contact}` : name;
}

export function buildSubscriberContactsText(subscribers: SubscriberLike[]): string {
  return subscribers.map(formatSubscriberContactLine).join("\n");
}

export function escapeCsvField(value: string): string {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function buildSubscribersCsv(subscribers: SubscriberLike[]): string {
  const header = ["Name", "Contact", "Notes", "Joined"].map(escapeCsvField).join(",");
  const rows = subscribers.map((row) =>
    [row.name, row.contact_info, row.notes, row.created_at].map(escapeCsvField).join(",")
  );
  return [header, ...rows].join("\n");
}

export const SUBSCRIBERS_CSV_FILENAME = "smokey-vault-event-subscribers.csv";

/** Trigger a browser download of CSV text (client-side only). */
export function downloadSubscribersCsv(
  subscribers: SubscriberLike[],
  filename = SUBSCRIBERS_CSV_FILENAME,
  createObjectURL: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url: string) => void = (url) => URL.revokeObjectURL(url)
): void {
  const csv = buildSubscribersCsv(subscribers);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  revokeObjectURL(url);
}

export async function copySubscriberContacts(
  subscribers: SubscriberLike[],
  clipboardWrite?: (text: string) => Promise<void>
): Promise<"copied" | "unsupported"> {
  const text = buildSubscriberContactsText(subscribers);
  const write = clipboardWrite
    ?? (typeof navigator !== "undefined" && navigator.clipboard?.writeText
      ? navigator.clipboard.writeText.bind(navigator.clipboard)
      : undefined);
  if (!write) return "unsupported";
  try {
    await write(text);
    return "copied";
  } catch {
    return "unsupported";
  }
}
