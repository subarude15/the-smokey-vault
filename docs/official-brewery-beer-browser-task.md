# Official Brewery Beer Browser Task (Figranium)

Optional rendered-browser fallback for PR103 official brewery product-page discovery.

## When it runs

1. Static PR103 discovery runs first.
2. Browser fallback is eligible only when static returns `unsupported_static_site`,
   or `not_found` with positive JS app-shell evidence.
3. Static `matched` results never invoke the browser.

## Environment

Reuse existing:

- `FIGRANIUM_BASE_URL`
- `FIGRANIUM_API_KEY`

Add:

- `FIGRANIUM_OFFICIAL_BEER_TASK_ID`

Do **not** reuse FWGS task IDs.

## Suggested Figranium task

**Name:** Official Brewery Render

**Input variables:**

- `url` (required)
- `beerName` (optional, informational)
- `breweryName` (optional, informational)

**Behavior:**

1. Navigate to `{$url}`
2. Wait for rendered page / network idle within a bounded timeout (15–30s)
3. Return JSON data:
   - `finalUrl` (required)
   - `title` (optional)
   - `html` (preferred) and/or same-page `links[]` with `{ href, text }`

**Hard rules:**

- No login / credentials
- No CAPTCHA bypass
- No third-party search
- No arbitrary user JS
- No generic proxy behavior

Smokey Vault validates official-domain locks and product identity after render.
