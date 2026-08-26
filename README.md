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

To provision AI through Docker, set `AI_PROVIDER`, `AI_API_KEY`, and `AI_MODEL` in `.env`.

For alcohol barcode enrichment, set `COLA_API_KEY` (free signup at [app.colacloud.us](https://app.colacloud.us/auth/register)). Lookups run: vault → local cache → COLA Cloud → Open Food Facts. Quota status is available at `/api/cola/quota`.

The SQLite database and daily snapshots live in `./data` locally, or in the NAS data mount in production. Camera streaming works on `localhost` or HTTPS; plain LAN HTTP automatically supports photo capture instead.

## Local development

Requires Node.js 24+ and native build tools for `better-sqlite3`.

```bash
npm install
npm run dev
```

Frontend: `http://localhost:5173`  
API: `http://localhost:8080`  
OpenAPI: `http://localhost:8080/api/docs`

## Production build

```bash
npm run build
npm start
```

Supported AI providers are OpenAI, Anthropic, OpenRouter, and Ollama. Configure them in `.env`.
