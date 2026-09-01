#!/usr/bin/env bash
# Verify production Docker image can run npm run catalog:import:* against /app/data.
# Requires: docker, npm, native build tools (same as CI).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-smokey-vault-catalog-verify:local}"
DATA_DIR="$(mktemp -d)"
FIXTURES_DIR="$(mktemp -d)"
CONTAINER1="smokey-catalog-verify-1"
CONTAINER2="smokey-catalog-verify-2"
DB_PATH="/app/data/government-catalog.sqlite"
HOST_DB="$DATA_DIR/government-catalog.sqlite"

cleanup() {
  docker rm -f "$CONTAINER1" "$CONTAINER2" >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR" "$FIXTURES_DIR"
}
trap cleanup EXIT

cd "$ROOT"

echo "==> Building TypeScript (includes catalog import CLIs in dist/)"
npm run build >/dev/null

echo "==> Generating import fixtures"
node dist/generate-catalog-import-fixtures.js "$FIXTURES_DIR"

echo "==> Building runtime Docker image"
docker build -t "$IMAGE" .

echo "==> Starting container with dual /data + /app/data mount"
docker run -d --name "$CONTAINER1" \
  -v "$DATA_DIR:/data" \
  -v "$DATA_DIR:/app/data" \
  -v "$FIXTURES_DIR:/app/data/imports:ro" \
  -e NODE_ENV=production \
  -e GOVERNMENT_CATALOG_DB_PATH="$DB_PATH" \
  "$IMAGE" >/dev/null

echo "==> Running PA spirits importer"
docker exec "$CONTAINER1" sh -lc \
  'cd /app && npm run catalog:import:pa-spirits -- /app/data/imports/pa-spirits-fixture.xlsx'

echo "==> Running PA wines importer"
docker exec "$CONTAINER1" sh -lc \
  'cd /app && npm run catalog:import:pa-wines -- /app/data/imports/pa-wines-fixture.xlsx'

echo "==> Running Iowa importer"
docker exec "$CONTAINER1" sh -lc \
  'cd /app && npm run catalog:import:iowa -- /app/data/imports/iowa-fixture.csv'

test -f "$HOST_DB"
SIZE1="$(stat -c%s "$HOST_DB")"
test "$SIZE1" -gt 0

echo "==> Verifying all three datasets in $DB_PATH"
docker exec "$CONTAINER1" node -e "
const Database = require('better-sqlite3');
const db = new Database('$DB_PATH', { readonly: true });
const rows = db.prepare(
  \"SELECT dataset, COUNT(*) AS sources FROM catalog_sources WHERE is_current = 1 GROUP BY dataset ORDER BY dataset\"
).all();
const expected = ['iowa', 'plcb_spirits', 'plcb_wines'];
for (const dataset of expected) {
  if (!rows.some((r) => r.dataset === dataset)) {
    console.error('Missing dataset:', dataset, rows);
    process.exit(1);
  }
}
const products = db.prepare('SELECT COUNT(*) AS c FROM catalog_products WHERE is_current = 1').get();
if (products.c < 3) {
  console.error('Expected >= 3 current products, got', products.c);
  process.exit(1);
}
console.log('datasets ok:', rows.map((r) => r.dataset + ':' + r.sources).join(', '));
"

echo "==> Recreating container; catalog must survive on mounted volume"
docker rm -f "$CONTAINER1" >/dev/null

docker run -d --name "$CONTAINER2" \
  -v "$DATA_DIR:/data" \
  -v "$DATA_DIR:/app/data" \
  -v "$FIXTURES_DIR:/app/data/imports:ro" \
  -e NODE_ENV=production \
  -e GOVERNMENT_CATALOG_DB_PATH="$DB_PATH" \
  "$IMAGE" >/dev/null

test -f "$HOST_DB"
SIZE2="$(stat -c%s "$HOST_DB")"
test "$SIZE1" = "$SIZE2"

docker exec "$CONTAINER2" node -e "
const Database = require('better-sqlite3');
const db = new Database('$DB_PATH', { readonly: true });
const count = db.prepare('SELECT COUNT(*) AS c FROM catalog_sources WHERE is_current = 1').get().c;
if (count < 3) {
  console.error('Expected >= 3 sources after recreate, got', count);
  process.exit(1);
}
console.log('persisted sources:', count);
"

echo ""
echo "OK: PA spirits, PA wines, and Iowa importers run in the runtime image;"
echo "    all write to $DB_PATH on the persistent mount and survive container recreation."
