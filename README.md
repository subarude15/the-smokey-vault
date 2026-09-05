# The Smokey Vault

A private, self-hosted bar, wine cellar, brewery log, cocktail matcher, and AI mixologist. Guests get a digital bar menu; the master PIN unlocks inventory and maintenance.

## Run with Docker

### Local (laptop)

`docker-compose.local.yml` builds from this repo and stores the database in `./data`. Copy `.env.example` to `.env` and set a strong `SESSION_SECRET` (and any AI / COLA keys you use) before exposing the service.

```bash
cp .env.example .env
docker compose -f docker-compose.local.yml up -d --build
```

Open `http://localhost:6616`. The initial master PIN is `1234` unless you set `DEFAULT_PIN`; change it after first launch.

### Production (Synology NAS)

`docker-compose.yml` is the live NAS stack. It pulls `ghcr.io/subarude15/the-smokey-vault:latest`, maps `6616:8080`, mounts `/volume1/docker/thesmokeyvault/data`, and runs Watchtower. Do not replace it with the local compose.

Keys come from the `.env` sitting next to that file on the NAS. After editing `.env` or the compose file, recreate the container (`docker compose up -d`); a restart is not enough. In Container Manager: Project → Build / Recreate.

To provision AI through Docker, set `AI_PROVIDER`, `AI_API_KEY` / `GEMINI_API_KEY`, and `AI_MODEL` in `.env`. Label reads use Gemini `gemini-3.6-flash`, then OpenRouter, then Anthropic. OpenAI is used only when `OPENAI_API_KEY` is set.

Live barcode scans try Fine Wine & Good Spirits first for liquor and wine (no API key), then one COLA Cloud list/barcode call if that hit is thin. Beer scans use vault → beer cache → Open Food Facts → upcitemdb, with COLA last. Beer name search uses vault → beer cache → [Catalog.beer](https://catalog.beer/signup) (free tier: 1,000 requests/month), with COLA only when results are sparse. Mixers skip catalogs. Set `COLA_API_KEY` for optional TTB records (free signup at [app.colacloud.us](https://app.colacloud.us/auth/register)). Set `CATALOG_BEER_API_KEY` for beer autocomplete and label-read suggestions. Optional `UNTAPPD_SCRAPE_ENABLED=true` can fetch label images from Untappd beer pages after you pick a match (personal use). `COLA_BURST_LIMIT` defaults to 10. Quota pauses COLA only; other catalogs still run. Overnight CSV drops on Import Review — list-only lookups, confirm Ready rows before anything is written to inventory.

The SQLite vault database and daily snapshots live in `./data` locally, or in the NAS data mount in production. Camera streaming works on `localhost` or HTTPS; plain LAN HTTP automatically supports photo capture instead.

### Government alcohol catalogs (PA PLCB + Iowa)

Runtime lookup and the import CLIs share one SQLite file:

- Production Docker: `/app/data/government-catalog.sqlite` (`GOVERNMENT_CATALOG_DB_PATH`)
- Local dev: `./data/government-catalog.sqlite`

Compose dual-mounts the host data folder to both `/data` (vault DB) and `/app/data` (government catalogs) so imports survive image redeploys. The catalog DB is **not** baked into the image (`.dockerignore` excludes `data/`). Startup and Keeper → Enrichment services report the resolved path, whether `/app/data` is writable, whether the DB exists, and file size — they never auto-create or auto-import the catalog.

After copying source files into the container (or onto the mounted volume), run:

```bash
# Paths below assume files were copied to /app/data/imports inside the container.
# Import CLIs run compiled dist/ entrypoints (no tsx or src/ in the runtime image).
docker exec -it smokey-vault sh -lc 'cd /app && npm run catalog:import:pa-spirits -- /app/data/imports/Wholesale_Spirits_Catalog_Full.xlsx'
docker exec -it smokey-vault sh -lc 'cd /app && npm run catalog:import:pa-wines -- /app/data/imports/Wholesale_Wines_Catalog_Full.xlsx'
docker exec -it smokey-vault sh -lc 'cd /app && npm run catalog:import:iowa -- /app/data/imports/iowa_liquor_products.csv'
```

To verify the runtime image locally (builds Docker, runs all three importers, checks persistence):

```bash
npm run verify:catalog-import-docker
```

Confirm Keeper → Settings → Enrichment services shows the government catalog as Ready (or check `/api/admin/enrichment/health`). Override with `GOVERNMENT_CATALOG_DB_PATH` / `GOVERNMENT_CATALOG_DATA_DIR` if needed; importers and lookup honor the same resolver.

## Local development

Requires Node.js 24+ and native build tools for `better-sqlite3`.

```bash
npm install
npm run dev
```

Frontend: `http://localhost:5173`  
API: `http://localhost:8080`  
OpenAPI: `http://localhost:8080/api/docs`

## Appearance

Four skins share one layout: Light, Dark, Punk, and **Angel's Share** — the phone-first, dim-room build where names are set in a label serif, facts in mono, and every gauge (bottle fill, keg remaining, wine counts) is visible to guests. Pick it in `Settings → Appearance`, tap the moon icon in the top bar until it lands, or open `/?theme=angels` on a phone to jump straight in. Theme tokens live in `themePresets` (`client/src/App.tsx`); the Angel's Share layer is `client/src/theme-angels.css` and is scoped to `html[data-theme="angels"]`, so it cannot leak into the other three. Concept, audit, and measured contrast: `docs/design/angels-share-theme.md`.

## Production build

```bash
npm run build
npm start
```

Supported AI providers are OpenAI, Anthropic, OpenRouter, and Ollama. Configure them in `.env`.
