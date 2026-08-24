# The Smoky Barrel Bar — Project Context Brief

Paste this whole file into Gemini as the first message of a new chat, then ask your question at the end.

---

## How to use you (instructions for the assistant)

You are helping maintain **The Smoky Barrel Bar** ("The Smokey Vault"), a private home-bar
inventory and guest-portal web app. It runs on an iPad kiosk in a home bar plus phones of
guests on the local network. There is no public internet exposure and no payment processing.

Ground rules for your answers:

1. **Match existing conventions over introducing new ones.** This codebase has strong,
   consistent idioms described below. Do not introduce React Router, Redux, a component
   library, Tailwind class soup in existing files, or an ORM.
2. **Do not invent file paths, settings keys, or API routes.** The real ones are listed below.
   If you need something not listed, say so and ask.
3. **No secrets in SQLite.** API keys live only in environment variables.
4. Prefer small, surgical diffs. `App.tsx` is 2,884 lines; when adding a self-contained
   feature, create a new file in `client/src/` rather than growing it further.
5. Guest-facing copy has a deliberate speakeasy/prohibition tone. Keep it warm and
   in-character, never corporate.
6. Comments only for non-obvious intent or constraints. No narration comments.

---

## Stack and commands

- **Runtime:** Node >= 24, ESM (`"type": "module"`)
- **Server:** Fastify + `better-sqlite3` (synchronous SQLite, WAL mode)
- **Client:** React 19 + Vite, `vite-plugin-pwa` (service worker), `lucide-react` icons
- **Validation:** `zod`
- **QR codes:** `qrcode.react` v4 (renders inline SVG, zero network requests)
- **Tests:** Node's built-in test runner via `tsx --test`
- **Dev host:** Windows 11 / PowerShell. Deployment target is Docker + `docker-compose`.

```bash
npm run dev      # concurrently: tsx watch server + vite dev server
npm run build    # vite build client, then tsc -p tsconfig.server.json
npm start        # node dist/server.js
npm test         # tsx --test src/*.test.ts  (currently 111 tests, all passing)
```

Useful env overrides when running locally: `DB_PATH`, `PORT`, `ADMIN_PIN`.

### Environment variables (`.env.example`)

```
SESSION_SECRET, DEFAULT_PIN
AI_PROVIDER          # openai | anthropic | openrouter | gemini | ollama
AI_API_KEY, AI_MODEL, AI_BASE_URL
GEMINI_API_KEY       # used when AI_PROVIDER=gemini (AI_API_KEY also works)
DISCORD_WEBHOOK_URL  # env var wins over the SQLite setting
COLA_API_KEY, COLA_BURST_LIMIT   # alcohol barcode lookup
BREWFATHER_USER_ID, BREWFATHER_API_KEY  # HTTP Basic userid:apikey, batches.read scope
```

---

## Repo layout

Server (`src/`):

| File | Lines | Purpose |
| --- | --- | --- |
| `server.ts` | 1060 | All Fastify routes, auth, LLM dispatch, background intervals |
| `db.ts` | 296 | Schema DDL, migrations, settings get/set + seeding, backups |
| `cocktails.ts` | 329 | Shelf building, ingredient/cocktail matching, substitutions |
| `speakeasy.ts` | 307 | Patrons, daily votes, messages, events, subscribers, merch |
| `speakeasy-shared.ts` | 169 | Constants/types/helpers shared by client **and** server |
| `discord.ts` | 51 | Webhook embed builder + 5-minute alert flush |
| `brewfather.ts` | 260 | One-way batch sync into Brewery Lab |
| `catalog.ts`, `lookup.ts`, `cola_client.ts`, `overview.ts`, `restock.ts`, `images.ts`, `votes.ts`, `pours.ts`, `reviews.ts`, `requests.ts`, `recipe_import.ts`, `vision_label.ts` | — | Pre-existing subsystems |

Client (`client/src/`):

| File | Lines | Purpose |
| --- | --- | --- |
| `App.tsx` | 2884 | Shell, routing, nav, most pages, all modals, Settings |
| `Scanner.tsx` | 300 | Barcode scanning (`@zxing/browser`) |
| `EventsPage.tsx` | 158 | Events list + admin CRUD + guest RSVP |
| `BreweryLab.tsx` | 156 | 3-tier brewery pipeline view |
| `PatronsPage.tsx` | 119 | Regulars leaderboard |
| `ContactModal.tsx` | 103 | Guest footer + contact modal with name autocomplete |
| `MerchPage.tsx` | 93 | Merch list + admin CRUD |
| `MessagesInbox.tsx` | 86 | Admin inbox |
| `useFormDraft.ts` | 65 | `localStorage` form-draft persistence hook |
| `TipJarPage.tsx` | 64 | Tip handles + QR codes + guest bartender card |
| `SubstitutesDrawer.tsx` | 54 | On-shelf substitute bottles for a cocktail |
| `QrCode.tsx` | 28 | `qrcode.react` wrapper (`QrCode`, `QrTipCard`) |
| `api.ts` | 45 | `fetch` helper that attaches the admin bearer token |
| `catalog.ts` | 134 | Re-exports from `../../src/*` so client code avoids deep imports |

---

## Architecture conventions (important)

**Routing is state-based, not React Router.** `App.tsx` holds a `page` string in `useState`
and renders `{page === "patrons" && <PatronsPage .../>}`. `react-router-dom` is in
`package.json` but is *not* used for app navigation. Do not add routes.

**The `api` helper** (`client/src/api.ts`) wraps `fetch`, prefixes `/api`, attaches
`Authorization: Bearer <token>` from `sessionStorage`, and throws `Error(message)` on
non-2xx. Always use it instead of raw `fetch`.

**Shared code pattern.** Anything both tiers need lives in `src/speakeasy-shared.ts` and is
re-exported through `client/src/catalog.ts`. Client files import from `./catalog`, never
`../../src/...` directly.

**Settings are a string key/value table.** `getSetting`/`setSetting` in `db.ts`. Everything is
a `TEXT` value, so booleans are the strings `"0"`/`"1"` and `enabled_tabs` is a JSON string.
Defaults are seeded at import time in `db.ts` using
`if (getSetting(k) === undefined) setSetting(k, default)` — note the `=== undefined` check so
a deliberately empty string is preserved.

**Public vs admin settings.** `server.ts` has `PUBLIC_SETTING_KEYS`; `GET /api/house` returns
only those, flat, plus a parsed `enabledTabs` object. `PUT /api/settings` accepts
`PUBLIC_SETTING_KEYS` plus `discord_webhook_url`. The client flattens every string value of
`/api/house` into `house.settings` and reads e.g. `house.settings.tip_venmo`.

**Auth.** PIN-based. `POST /api/auth/unlock` with `{ pin }` returns a token held in
`sessionStorage`. Server handlers call a `requireAdmin(request, reply)` guard. Admin-only
pages bypass guest tab gating entirely.

**CSS.** One hand-written `client/src/styles.css`, kebab-case class names, BEM-ish modifiers,
CSS custom properties for theming (dark/light). No CSS modules, no styled-components.

**Errors.** Server throws `SpeakeasyError` (in `speakeasy.ts`) carrying an HTTP status and a
guest-friendly message; routes translate it to a reply.

---

## Data model — tables added for this feature set

```sql
-- Patron-facing locks (added to existing tables via ensureColumn migration)
ALTER TABLE spirits ADD COLUMN blocked_from_ordering INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wines   ADD COLUMN blocked_from_ordering INTEGER NOT NULL DEFAULT 0;

CREATE TABLE patrons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  nickname TEXT DEFAULT '',
  visit_count INTEGER NOT NULL DEFAULT 1,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_patrons_ranking ON patrons(visit_count DESC, updated_at ASC);

CREATE TABLE daily_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_table TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  patron_name TEXT NOT NULL,
  vote_date TEXT NOT NULL,          -- YYYY-MM-DD, rolls at 4:00 AM
  value INTEGER NOT NULL CHECK(value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(target_table, item_id, patron_name, vote_date)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_name TEXT NOT NULL,
  contact_info TEXT NOT NULL,
  body TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  discord_notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_messages_unread ON messages(is_read, created_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, event_date TEXT NOT NULL,
  description TEXT DEFAULT '', image_url TEXT DEFAULT '',
  is_published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE event_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, contact_info TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE merch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, description TEXT DEFAULT '',
  suggested_donation TEXT DEFAULT '', image_url TEXT DEFAULT '',
  is_available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Pre-existing tables include `spirits`, `wines`, `packaged_beer`, `taps`, `brews`, `settings`,
plus vote/pour/review/request tables.

---

## Settings keys

Seeded defaults (`db.ts`): `theme`, `keeperName` (default `"Nick"`), `lastBackupDownload`,
`restockPackagedBelow` (3), `restockSpiritFill` (25), `restockWineBelow` (2), `enabled_tabs`,
`bar_location_text` (`"Located in 19605"`), `house_tip_blurb`, `guest_bartender_enabled`
(`"0"`), `discord_webhook_url` (`""`), `facebook_group_url` (`""`).

Public keys returned by `/api/house`: `enabled_tabs`, `bar_location_text`, `house_tip_blurb`,
`guest_bartender_enabled`, `facebook_group_url`, `tip_venmo`, `tip_cashapp`, `tip_paypal`,
`guest_bartender_name`, `guest_bartender_bio`, `guest_bartender_photo`,
`guest_bartender_applecash`, `guest_bartender_venmo`, `guest_bartender_cashapp`,
`guest_bartender_paypal`.

`enabled_tabs` default JSON:
`{"overview":1,"cocktails":1,"cellar":1,"brewery":1,"patrons":1,"events":1,"tipjar":1,"merch":0,"whatsnext":1}`

Tab keys (`TAB_KEYS` in `speakeasy-shared.ts`): `overview`, `cocktails`, `cellar`, `brewery`,
`patrons`, `events`, `tipjar`, `merch`, `whatsnext`.

---

## Shared constants (`src/speakeasy-shared.ts`)

```ts
VAULT_DAY_ROLL_HOUR = 4          // a 2 AM nightcap counts as the night before
LEADERBOARD_SIZE = 15
MESSAGE_ALERT_DELAY_MS = 5 * 60_000
KIOSK_IDLE_MS = 3 * 60_000
AI_MIXOLOGIST_TIMEOUT_MS = 5000
MAX_PATRON_NAME = 60, MAX_PATRON_NICKNAME = 40
MAX_MESSAGE_BODY = 2000, MAX_CONTACT_INFO = 200
BLOCKED_RIBBON_LABEL = "Not for bar patrons"
TOP_PATRON_BANNER = "👑 #1 Bar Legend & Top Supporter"
AI_UNAVAILABLE_NOTICE = "Sorry. Due to Roo's vet bills, We can't afford all of the AI needed for this feature right now."
```

Helpers: `parseEnabledTabs`, `serializeEnabledTabs`, `vaultDayDate`, `clipText`, `clipBody`,
`isBlocked`, `patronRank`, `tipHandles`, `appleCashLink`.

---

## API surface added in this work

All under `/api`. "Admin" means the bearer token is required.

**Patrons** — `GET /patrons` (public: top 15 by `visit_count DESC, updated_at ASC`; admin:
all, and the response includes an `admin` boolean) · `POST /patrons` (admin) ·
`PUT /patrons/:id` (admin; nickname/notes/visit_count) · `POST /patrons/:id/increment` ·
`POST /patrons/:id/decrement` · `DELETE /patrons/:id`

**Daily votes** — `POST /inventory/:table/:id/daily-vote` with `{ patron_name, value: 1 | -1 }`.
Computes the vault-day string and inserts; a second vote for the same patron/item/day is
rejected with a friendly notice. `GET /inventory/:table/daily-votes` returns tallies.
Deleting an inventory item also clears its `daily_votes` rows.

**Messages** — `POST /messages` (public: `{ sender_name, contact_info, body }`) ·
`GET /messages` (admin) · `GET /messages/unread` (admin, returns `{ unread }`) ·
`PUT /messages/:id/read` · `DELETE /messages/:id`

**Events** — `GET /events` · `POST /events` · `PUT /events/:id` · `DELETE /events/:id`

**Subscribers** — `GET /event-subscribers` (admin) · `POST /event-subscribers` (public RSVP) ·
`DELETE /event-subscribers/:id`

**Merch** — `GET /merch` · `POST /merch` · `PUT /merch/:id` · `DELETE /merch/:id`

**System** — `POST /system/restart` (admin): runs `db.pragma("wal_checkpoint(TRUNCATE)")`,
replies `{ ok: true, restarting: true }`, then `process.exit(0)` after 500 ms. Docker's
restart policy brings the container back.

**Other relevant existing routes** — `GET /house`, `GET /overview`, `GET /settings`,
`PUT /settings`, `GET /cocktails/match`, `GET /restock`, `POST /media/upload`,
`POST /ai/vision`, `GET /next?voter=`, `POST /next`, `POST /next/:id/vote`,
`DELETE /next/:id`, `POST /backups/snapshot`, `GET /health`.

Background interval: every 60 s, `flushDiscordAlerts()` finds unread messages older than
5 minutes with `discord_notified = 0`, posts a Discord embed if a webhook is configured, and
marks them notified.

---

## LLM provider dispatch

`callLlm()` in `server.ts` supports `openai`, `anthropic`, `openrouter`, `gemini`, `ollama`.
Gemini targets:

```
https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}
```

Config resolves from env first, then SQLite settings, falling back to keyless Ollama.
The AI mixologist has a 5-second client-side timeout that shows `AI_UNAVAILABLE_NOTICE`.

---

## Frontend behaviour worth knowing

- **Cocktail substitutions.** `buildShelf()` excludes `blocked_from_ordering === 1` bottles.
  When an ingredient matches via a substitution family, `matchIngredient()` compiles
  `substitute_options: Array<{ name, brand, fill_level }>`, and `matchCocktail()` returns
  `has_substitutes`. The UI shows a "View Substitutes" trigger opening `SubstitutesDrawer`.
- **Kiosk mode.** 3-minute idle timer on `touchstart`/`mousemove`/`keydown` clears the token
  and returns to the guest landing page. A `#ff6b00` "Lock / Hand to Guest" button sits in
  the topbar while admin is active.
- **Form drafts.** `useFormDraft` persists add/edit modal fields to `localStorage` and offers
  to restore them. It compares against a pristine snapshot so merely opening and closing a
  form does not leave a draft behind.
- **Dynamic tab router.** `PAGE_TAB` maps each page id to its controlling tab key;
  `pageEnabled(page, tabs, admin)` returns true for admins and keeper-only pages so a tab can
  always be switched back on. Visiting a disabled page redirects to the first enabled one.
- **Brewery Lab tiers.** "Pouring Now from the Lab" (homebrew on active taps) → "In the Works"
  (`Fermenting` / `Conditioning` with gravities, days in stage, hops) → collapsible
  Archive & Planned.
- **Naming note.** The "What's next" tab was renamed to **"Give us your 2 cents"**. Internal
  identifiers were intentionally left alone: the page id is still `next`, the setting key is
  still `whatsnext`, and the routes are still `/api/next*`. `TAB_LABELS` in `App.tsx` maps tab
  keys to display names for the Settings toggle grid.

---

## Current state

- `npm run build` passes clean. `npm test` passes: **111 tests, 0 failures.**
- Backend verified end-to-end with a scripted smoke pass against a live server: admin unlock,
  patron CRUD and leaderboard ordering, blocked bottles excluded from substitutes, daily-vote
  identity locking, message read/unread counts, event/subscriber/merch CRUD, settings
  round-trip through `/api/house`, delete cascades, and `401` on `/system/restart` without a
  token.
- **Not yet verified visually:** the rendered leaderboard gold banner, the QR code images, and
  the guest bartender card. A browser pass was interrupted before it reported. Treat the
  visual layer as unconfirmed.
- One known pre-existing TypeScript complaint: `main.tsx` `TS2882` on the side-effect import
  of `./styles.css`. Vite handles this fine and `npm run build` succeeds; it is not a
  regression.

## Gotchas that have already bitten us

1. **The PWA service worker caches the JS bundle.** After a rebuild, a normal refresh can
   serve the old app. Hard-reload, or use a different port to get a fresh SW scope. Several
   "the feature is broken" reports turned out to be stale bundles or a database whose
   settings had been changed by hand mid-test.
2. **`enabled_tabs` genuinely hides tabs.** Before concluding a tab is broken, check the
   setting — `merch` defaults to `0`.
3. `better-sqlite3` is a native module; it must be rebuilt for the container's Node ABI.
4. SQLite runs in WAL mode, so `.db-wal` / `.db-shm` files sit beside the database. Checkpoint
   before treating the `.db` file as a complete copy.
5. Settings values are strings. `guest_bartender_enabled` is `"1"`, never `true`.
6. Dev machine is Windows/PowerShell: use `$env:VAR="value"; cmd`, and `;` rather than `&&`.

---

## My question

<!-- Replace this line with what you want help with. -->
