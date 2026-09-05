# Official Brewery Beer Browser Task (Figranium)

Operational runbook for the optional rendered-browser fallback used by official
brewery product-page discovery (PR103 static path + PR104 browser adapter).

This document is about **task contract + safe validation tooling**. It does not
introduce a new beer provider, change ranking/provenance, or touch FWGS.

## When it runs

1. Static PR103 discovery runs first.
2. Browser fallback is eligible only when static returns `unsupported_static_site`,
   or `not_found` with positive JS app-shell evidence.
3. Static `matched` results never invoke the browser.
4. When `FIGRANIUM_OFFICIAL_BEER_TASK_ID` is unset, static discovery continues
   normally and browser is a no-op.

## Environment

Reuse existing Figranium client config:

- `FIGRANIUM_BASE_URL`
- `FIGRANIUM_API_KEY`

Dedicated brewery-render task (never reuse FWGS task IDs):

- `FIGRANIUM_OFFICIAL_BEER_TASK_ID`

Optional discovery kill-switch (default enabled):

- `OFFICIAL_BREWERY_DISCOVERY_ENABLED` (`false` / `0` / `off` disables)

### Synology / Docker Compose

Pass the dedicated task ID into the app container the same way as other
Figranium vars (compose already wires base URL / API key / FWGS task IDs):

```yaml
FIGRANIUM_OFFICIAL_BEER_TASK_ID: ${FIGRANIUM_OFFICIAL_BEER_TASK_ID:-}
```

Set the value in the host `.env` used by Synology Compose. Do **not** put
secrets in git.

## Task creation (manual)

Figranium task definitions are managed in the Figranium UI/API. This repo does
not automate task creation. Create (or import) a task with the contract below.

### Task name

`Official Brewery Render`

### Input variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `url` | **yes** | Navigation target (official brewery HTTP(S) URL) |
| `beerName` | no | Informational only — must **not** invent product identity |
| `breweryName` | no | Informational only — must **not** invent product identity |

Navigation expression: open `{$url}` (or Figranium’s equivalent variable
substitution for `url`).

### Task responsibility (only)

1. Navigate to `{$url}`
2. Wait for browser-rendered content (bounded)
3. Return final URL
4. Return page title
5. Return rendered HTML and/or bounded page links

### Must not

- Decide whether the page is the correct beer
- Call search engines
- Crawl third-party sites
- Bypass CAPTCHA / login / credentials
- Rotate proxies or act as a generic proxy
- Run arbitrary user-provided JavaScript
- Persist cookies across unrelated brewery runs unless Figranium naturally
  scopes sessions that way

Smokey Vault remains responsible for official-domain validation, beer identity
matching, metadata extraction, canonical URL authority, persistence, and
provenance (`official_brewery` confidence unchanged).

### Wait / timeout

- Prefer: DOM ready, then a short rendered-content wait
- Avoid forever-wait on strict network-idle (analytics-heavy brewery sites)
- Suggested total page render budget: **≤ 20–25 seconds**
- Smokey Vault adapter timeout: `OFFICIAL_BEER_BROWSER_TIMEOUT_MS` (25s)

### Age gates (optional, narrow)

If the site shows a simple local age-confirmation UI **and** Figranium primitives
allow a deterministic click:

- Click a visible button whose label contains one of: `Enter`, `I am 21`,
  `Yes`, `Confirm`
- No personal information, no login, no CAPTCHA
- Do not add broad autonomous click behavior

### Cookie banners (optional, narrow)

If a standard consent banner blocks navigation, the task may dismiss it with a
generic, narrowly scoped action. Do not retain cookies between unrelated
brewery runs unless the platform already does so by design.

### HTML size

Return enough rendered DOM for PR103 extraction, not unlimited content.

- Prefer `document.documentElement.outerHTML`
- Cap around **500 KB – 1 MB** if Figranium can truncate

### Link extraction

Return bounded links from the rendered DOM only (do not crawl them):

- Suggested maximum: **100–200** links
- Each item: `{ "href": "...", "text": "..." }`
- Smokey Vault strips off-domain links after return

### Output schema (required contract)

```json
{
  "finalUrl": "https://official-brewery-domain/...",
  "title": "...",
  "html": "...",
  "links": [
    { "href": "...", "text": "..." }
  ]
}
```

Rules:

- `finalUrl` is **required** (adapter also accepts `final_url`)
- At least one of `html` or `links` must be usable
- Empty HTML + empty links → rejected (`invalid_result`)
- Off-domain `finalUrl` → rejected (`off_domain`)

### Sanitized conceptual task definition

Figranium export formats vary by version. Use this as an operator checklist
(not a secret-bearing import file):

```json
{
  "name": "Official Brewery Render",
  "variables": ["url", "beerName", "breweryName"],
  "navigation": { "url": "{$url}" },
  "wait": {
    "domReady": true,
    "renderedContentMs": 3000,
    "totalBudgetMs": 25000
  },
  "optionalActions": {
    "ageGateButtons": ["Enter", "I am 21", "Yes", "Confirm"],
    "cookieBanner": "dismiss_if_blocking"
  },
  "extract": {
    "finalUrl": "location.href",
    "title": "document.title",
    "html": {
      "source": "document.documentElement.outerHTML",
      "maxBytes": 1048576
    },
    "links": {
      "selector": "a[href]",
      "fields": ["href", "text"],
      "max": 200
    }
  },
  "prohibitions": [
    "no_search_engines",
    "no_third_party_crawl",
    "no_captcha_bypass",
    "no_login",
    "no_arbitrary_user_js",
    "no_generic_proxy"
  ]
}
```

Do **not** commit API keys, cookies, credentials, or private environment values.

## Smoke harness (read-only)

```bash
npm run smoke:official-beer-browser -- \
  --brewery "Tröegs Independent Brewing" \
  --beer "Perpetual IPA" \
  --url "https://troegs.com"
```

Browser-adapter only (proves Figranium task wiring):

```bash
npm run smoke:official-beer-browser -- \
  --browser-only \
  --brewery "Tröegs Independent Brewing" \
  --beer "Perpetual IPA" \
  --url "https://troegs.com"
```

Preset fixtures (operational only — not canonical product records):

```bash
npm run smoke:official-beer-browser -- --presets
```

Includes:

- Tröegs Perpetual IPA
- Dogfish Head 60 Minute IPA
- Yards Brawler
- Victory Golden Monkey
- Negative control: Yards + “Quantum Pickle Imperial Lager”

Guarantees:

- Calls discovery / browser adapter only
- Never writes inventory, beer_cache, product_images, enrichment_sources,
  product_content, or SQLite
- Never enqueues enrichment jobs
- Never prints API keys, cookies, full HTML, or raw Figranium blobs

When configuration is missing, the CLI prints only yes/no for:

- `FIGRANIUM_BASE_URL`
- `FIGRANIUM_API_KEY`
- `FIGRANIUM_OFFICIAL_BEER_TASK_ID`

## Expected control behavior

| Target | Expectation |
| --- | --- |
| Yards Brawler (`yardsbrewing.com`) | Static discovery usually succeeds → **browser calls: 0** |
| Victory Golden Monkey (`victorybeer.com`) | Static preferred → browser unnecessary when static works |
| Tröegs Perpetual IPA (`troegs.com`) | If JS-dependent: static may fail → browser fallback → `matched` with `exact_name` or `strong_name` on `troegs.com` |
| Dogfish Head 60 Minute IPA (`dogfish.com`) | Same as Tröegs; product URL must stay on Dogfish registered domain |
| Nonsense beer on Yards | **Not matched** — no fabricated official evidence |

Do not weaken domain lock, match strictness, SSRF rules, or provenance to force
smoke green. Diagnose real failures (task unconfigured, age gate, timeout,
iframe, identity reject, etc.).

## Troubleshooting

| Symptom / reason | What to check |
| --- | --- |
| `task_unconfigured` / `official_beer_browser_unconfigured` | Set `FIGRANIUM_OFFICIAL_BEER_TASK_ID` (and base URL + API key) |
| `timeout` | Inspect Figranium wait strategy; keep ≤ ~25s; avoid strict network-idle forever |
| `off_domain` | Browser navigated outside official brewery registered domain |
| `invalid_result` / `missing_final_url` / `empty_render` | Task extraction does not match contract |
| `browser_no_strong_match` | DOM rendered, but beer identity did not validate |
| `unsupported_static_site` | Static path insufficient; browser unavailable or no usable DOM |
| Auth / 401 from Figranium | `FIGRANIUM_API_KEY` wrong or missing (CLI prints configured yes/no only) |
| Static controls unexpectedly use browser | Site HTML changed; confirm with `--presets` observability fields |

## Live validation from this development environment

Ran `npm run smoke:official-beer-browser -- --presets` with outbound HTTP available
but **no Figranium credentials** configured:

| Target | Status | Match | Browser used | Notes |
| --- | --- | --- | --- | --- |
| Yards Brawler | `matched` | `exact_name` | no | Static control — browser correctly unused |
| Victory Golden Monkey | `matched` | `exact_name` | no | Static control — browser correctly unused |
| Tröegs Perpetual IPA | `not_found` | `none` | no | Static miss; browser skipped (`browser_unconfigured`) |
| Dogfish Head 60 Minute IPA | `not_found` | `none` | no | Static miss; browser skipped (`browser_unconfigured`) |
| Yards Quantum Pickle Imperial Lager | `not_found` | `none` | no | Negative control — no fabricated official evidence |

**Live Figranium smoke test not performed from development environment.**
After merge, run the same presets against production Figranium with
`FIGRANIUM_OFFICIAL_BEER_TASK_ID` set to validate the JS-site browser fallback.

## Boundaries (do not cross)

- No new beer provider / search ranking / provenance changes
- No FWGS task ID reuse (`FIGRANIUM_FWGS_*`)
- No public `/api/browser` or guest URL fetcher
- No DB schema / migrations for browser cache
- No Google / Bing / Untappd / BeerAdvocate / retailer fallbacks
- No Gemini / Ollama involvement
