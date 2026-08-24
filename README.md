# The Smokey Vault

A private, self-hosted bar, wine cellar, brewery log, cocktail matcher, and AI mixologist. Guests get a digital bar menu; the master PIN unlocks inventory and maintenance.

## Run with Docker

```bash
docker compose up -d --build
```

Open `http://localhost:6616`. The initial master PIN is `1234`; change it after first launch. Set a strong `SESSION_SECRET` and `DEFAULT_PIN` in a local `.env` before exposing the service.

To provision AI through Docker, copy `.env.example` to `.env` and set `AI_PROVIDER`, `AI_API_KEY`, and `AI_MODEL`.

For alcohol barcode enrichment, set `COLA_API_KEY` (free signup at [app.colacloud.us](https://app.colacloud.us/auth/register)). Lookups run: vault → local cache → COLA Cloud → Open Food Facts. Quota status is available at `/api/cola/quota`.

The SQLite database and daily snapshots live in `./data`. Camera streaming works on `localhost` or HTTPS; plain LAN HTTP automatically supports photo capture instead.

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
