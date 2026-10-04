import { isEmailAddress, parseMailbox } from "./mail.js";
import {
  deliverOwnerMail,
  escapeHtml,
  type NotifyDeps,
  type NotifyOutcome
} from "./message-notification.js";
import type { EventRsvp, HouseEvent, RsvpStatus } from "./speakeasy-shared.js";

function singleLine(value: string, max = 300): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim().slice(0, max);
}

function statusLabel(status: RsvpStatus): string {
  switch (status) {
    case "going":
      return "Going";
    case "maybe":
      return "Maybe";
    case "declined":
      return "Can't make it";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function buildWebsiteRsvpMail(input: {
  event: Pick<HouseEvent, "title">;
  rsvp: Pick<EventRsvp, "id" | "name" | "contact_info" | "status" | "party_size" | "notes">;
}): { subject: string; text: string; html: string; replyTo?: string } {
  const name = singleLine(input.rsvp.name) || "A guest";
  const title = singleLine(input.event.title) || "an event";
  const contact = singleLine(input.rsvp.contact_info) || "Not provided";
  const notes = String(input.rsvp.notes ?? "").replace(/\u0000/g, "").trim() || "None";
  const status = statusLabel(input.rsvp.status);
  const party = String(input.rsvp.party_size);
  const replyTo = isEmailAddress(input.rsvp.contact_info.trim())
    ? parseMailbox(input.rsvp.contact_info.trim()) ?? undefined
    : undefined;

  const lines = [
    "A guest RSVP'd from the website.",
    "",
    `Event: ${title}`,
    `Name: ${name}`,
    `Status: ${status}`,
    `Party size: ${party}`,
    `Contact: ${contact}`,
    `Notes: ${notes}`
  ];

  const rows: Array<[string, string]> = [
    ["Event", title],
    ["Name", name],
    ["Status", status],
    ["Party size", party],
    ["Contact", contact],
    ["Notes", notes]
  ];
  const table = rows.map(([label, value]) =>
    `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`
  ).join("");

  return {
    subject: singleLine(`RSVP: ${name} is ${status.toLowerCase()} for ${title}`, 120),
    text: lines.join("\n"),
    html: [
      "<!DOCTYPE html>",
      "<html><body>",
      "<p>A guest RSVP'd from the website.</p>",
      `<table>${table}</table>`,
      "</body></html>"
    ].join(""),
    replyTo
  };
}

/** Website guest RSVPs only. Mail failure never throws. */
export async function notifyOwnersOfWebsiteRsvp(
  event: Pick<HouseEvent, "id" | "title">,
  rsvp: EventRsvp,
  deps: NotifyDeps = {}
): Promise<NotifyOutcome> {
  const built = buildWebsiteRsvpMail({ event, rsvp });
  return deliverOwnerMail(built, deps, {
    context: { eventId: event.id, rsvpId: rsvp.id },
    sent: "Emailed website RSVP notification",
    failed: "Website RSVP email notification failed",
    skippedSmtp: "Website RSVP email notification skipped: SMTP is not configured"
  });
}
