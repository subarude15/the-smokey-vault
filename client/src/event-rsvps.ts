/**
 * Pure helpers for per-event RSVPs. Distinct from the general invite list
 * (`event_subscribers`): this tracks responses to one event.
 */

import {
  RSVP_SOURCES,
  RSVP_STATUSES,
  type EventRsvp,
  type EventRsvpSummary,
  type RsvpSource,
  type RsvpStatus
} from "./catalog";
import { escapeCsvField } from "./event-subscribers";

export const RSVP_STATUS_LABELS: Record<RsvpStatus, string> = {
  going: "Going",
  maybe: "Maybe",
  declined: "Can't make it"
};

export const RSVP_SOURCE_LABELS: Record<RsvpSource, string> = {
  website: "Website",
  facebook: "Facebook",
  text: "Text",
  phone: "Phone",
  other: "Other"
};

export function rsvpStatusLabel(status: RsvpStatus): string {
  return RSVP_STATUS_LABELS[status];
}

export function rsvpSourceLabel(source: RsvpSource): string {
  return RSVP_SOURCE_LABELS[source];
}

export function formatRsvpSummary(summary: EventRsvpSummary): string {
  const going = `${summary.going} Going`;
  const maybe = `${summary.maybe} Maybe`;
  const declined = `${summary.declined} Declined`;
  const expected = summary.expected_guests === 1
    ? "1 expected guest"
    : `${summary.expected_guests} expected guests`;
  return `${going} · ${maybe} · ${declined} · ${expected}`;
}

export function formatRsvpStamp(raw: string): string {
  const stamp = Date.parse(raw);
  if (!Number.isFinite(stamp)) return raw || "—";
  return new Date(stamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export function emptyRsvpSummary(): EventRsvpSummary {
  return { going: 0, maybe: 0, declined: 0, expected_guests: 0 };
}

export function rsvpCsvFilename(eventTitle: string): string {
  const slug = eventTitle.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event";
  return `smokey-vault-event-rsvps-${slug}.csv`;
}

export function buildRsvpsCsv(eventTitle: string, rsvps: EventRsvp[]): string {
  const header = ["Event", "Name", "Status", "Party Size", "Contact", "Source", "Notes", "Created", "Updated"]
    .map(escapeCsvField)
    .join(",");
  const rows = rsvps.map((row) =>
    [
      eventTitle,
      row.name,
      rsvpStatusLabel(row.status),
      String(row.party_size),
      row.contact_info,
      rsvpSourceLabel(row.source),
      row.notes,
      row.created_at,
      row.updated_at
    ].map(escapeCsvField).join(",")
  );
  return [header, ...rows].join("\n");
}

export function downloadRsvpsCsv(
  eventTitle: string,
  rsvps: EventRsvp[],
  filename = rsvpCsvFilename(eventTitle),
  createObjectURL: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url: string) => void = (url) => URL.revokeObjectURL(url)
): void {
  const csv = buildRsvpsCsv(eventTitle, rsvps);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  revokeObjectURL(url);
}

export function copyRsvpContact(
  contact: string,
  clipboardWrite?: (text: string) => Promise<void>
): Promise<"copied" | "unsupported" | "empty"> {
  const text = contact.trim();
  if (!text) return Promise.resolve("empty");
  const write = clipboardWrite
    ?? (typeof navigator !== "undefined" && navigator.clipboard?.writeText
      ? navigator.clipboard.writeText.bind(navigator.clipboard)
      : undefined);
  if (!write) return Promise.resolve("unsupported");
  return write(text).then(
    () => "copied" as const,
    () => "unsupported" as const
  );
}

export { RSVP_SOURCES, RSVP_STATUSES };
