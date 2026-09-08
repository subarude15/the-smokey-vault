# Current task

**Status: in progress — PR132**

PR132 — Keeper Event Subscriber List.

Build a Keeper-only invite-list management experience on the Events page for people who asked to receive party/event updates (`event_subscribers`). Keep subscribers separate from Guest messages.

## Objectives

- Keeper-only Invite List with name, contact, notes, joined date, and total count
- Contact mailto:/tel: links where obvious; plain text otherwise
- Client-side search across name / contact / notes
- Remove with confirmation via existing DELETE endpoint
- Export CSV (full list) and Copy contacts actions
- Clear loading / error / empty states (do not mask API failures as empty)
- Preserve public guest signup via POST /api/event-subscribers
- Privacy regression: Guest cannot GET/DELETE; Keeper can; POST stays public

## File boundaries

- Prefer `client/src/EventSubscriberList.tsx`, `client/src/event-subscribers.ts`, Events page wiring, styles, focused tests, ROADMAP / CURRENT_TASK
- Prefer no schema changes and no new endpoints unless a small list/auth fix is required

## Non-goals

Outbound email/SMS, CRM, Mailchimp/Twilio, merge into messages, tagging, per-event RSVP, bulk delete, Gallery albums (PR131), Events redesign
