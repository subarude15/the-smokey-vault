# Current task

**Status: active — PR126**

**PR126 — Add event editing and shareable event links**

## Objective

1. Keepers can edit an existing event (title, date, description, image, publish state) without delete/recreate.
2. Guests and Keepers can open a stable deep link to one published event and share/copy that link.

## Boundaries

1. Reuse existing `updateEvent` server behavior; do not invent parallel mutation semantics.
2. Use a small SPA deep-link mechanism (`?event=<id>`); do not add React Router for this PR.
3. Unpublished events must not be guest-accessible via guessed IDs — enforce server-side.
4. Prefer extracted `EventEditor` / `EventDetail` components over growing `App.tsx`.
5. Reuse existing image upload/localization (`ImageField` / `/api/media/upload`) for event images.

## Non-goals

- External event platforms (Facebook/Eventbrite/Google Calendar)
- RSVP redesign, email/SMS invites, recurring events, analytics, QR generation
- Theme work, gallery bulk upload, cocktail image discovery
