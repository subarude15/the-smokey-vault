# The Smokey Vault

A private, self-hosted bar / wine cellar / brewery log / cocktail matcher with an optional AI mixologist. Fastify + SQLite (`better-sqlite3`) API backend and a Vite + React (TypeScript) PWA frontend.

## Cursor Cloud specific instructions

These notes are for agents running in the Cursor Cloud VM after the startup update script has already run. Standard commands live in `README.md` and `package.json` scripts — this section only captures the non-obvious gotchas.

### Node version / PATH gotcha (important)

- The app requires **Node.js 24+** (`package.json` `engines`). Node 24 is installed via `nvm` (default alias `24`).
- A fixed `/exec-daemon/node` (Node 22) sits ahead of `nvm` in `PATH` and is re-injected at the front for every non-interactive command spawned by the tooling. Interactive shells are fixed via a `PATH` prepend appended to `~/.bashrc`, so a normal terminal already resolves Node 24 (`node -v` → v24.x).
- If you run a one-off non-interactive command and get Node 22, prepend nvm's Node 24 to `PATH` within that command:
  `export PATH="$(nvm which 24 | xargs dirname):$PATH"` (after sourcing `~/.nvm/nvm.sh`), or just run it from an interactive shell / the tmux dev session.

### better-sqlite3 native build gotcha (important)

- `npm`/`npm rebuild` in this environment runs under a **script-blocking sandbox** (you'll see `npm warn allow-scripts ...`). This means `better-sqlite3`'s `node-gyp rebuild` install script is **NOT** executed by `npm install`, so the native addon (`node_modules/better-sqlite3/build/Release/better_sqlite3.node`) is missing and `require("better-sqlite3")` fails.
- The startup update script works around this by invoking `node-gyp` directly with `--force_build=1`. If you ever reinstall deps manually and the server can't load `better-sqlite3`, rebuild it directly (do NOT rely on `npm rebuild`, which the sandbox silently no-ops):
  ```bash
  cd node_modules/better-sqlite3 && \
    node "$(npm root -g)/npm/node_modules/node-gyp/bin/node-gyp.js" rebuild --release --force_build=1
  ```
- The install-time and run-time Node must match (native ABI). Always build and run under Node 24.

### Running the app (development)

- `npm run dev` runs both processes via `concurrently`: the Fastify API (`tsx watch src/server.ts`) on **:8080** and the Vite dev server on **:5173** (Vite proxies `/api` → `:8080`). Open **http://localhost:5173**. Both support hot reload.
- No API keys are required for core features. `COLA_API_KEY` (alcohol barcode enrichment) and AI provider keys (`AI_PROVIDER`/`AI_API_KEY`/`AI_MODEL`, or `OPENAI_API_KEY` etc.) are optional; the AI Mixologist and barcode-enrichment features stay disabled/limited without them.
- SQLite lives at `./data/smokeyvault.db` in dev (auto-created, schema + ~118 seeded cocktails on first boot). Daily backups go to `./data/backups`. The `data/` dir is gitignored except `.gitkeep`.
- Admin mode is gated by a master PIN (default **1234**, from `DEFAULT_PIN`). Unlock via the lock icon in the top-right header to add/edit/delete inventory.

### Build / typecheck

- There is no separate lint or unit-test setup in this repo. `npm run build` = `vite build` (client → `client/dist`) + `tsc -p tsconfig.server.json` (server → `dist`); the `tsc` step doubles as the type check. `npm start` runs the compiled production server on :8080.
