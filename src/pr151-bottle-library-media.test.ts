/**
 * PR151 — Bottle Library media frame + inventory loading/empty/error state model.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inventoryViewState } from "../client/src/inventory-view-state.ts";
import { spiritCardImageUrl } from "../client/src/SpiritCardMedia.tsx";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mediaSrc = readFileSync(join(root, "client/src/SpiritCardMedia.tsx"), "utf8");
const cardSrc = readFileSync(join(root, "client/src/TapSpiritInventoryCard.tsx"), "utf8");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const skeletonSrc = readFileSync(join(root, "client/src/SpiritShelfSkeleton.tsx"), "utf8");
const cssSrc = readFileSync(join(root, "client/src/tap-spirit-card.css"), "utf8");

test("spiritCardImageUrl prefers display_image_url then image_url", () => {
  assert.equal(spiritCardImageUrl({ display_image_url: "/a.webp", image_url: "/b.webp" }), "/a.webp");
  assert.equal(spiritCardImageUrl({ image_url: "/b.webp" }), "/b.webp");
  assert.equal(spiritCardImageUrl({}), "");
  assert.equal(spiritCardImageUrl({ display_image_url: "  ", image_url: null }), "");
});

test("image URL present → SpiritCardMedia renders an img with bottle alt text", () => {
  assert.match(mediaSrc, /const showImage = Boolean\(src\) && !broken;/);
  assert.match(mediaSrc, /alt=\{spiritMediaAlt\(item\)\}/);
});

test("missing image URL → branded placeholder renders (not a Lucide bottle icon)", () => {
  assert.match(mediaSrc, /function SpiritMediaPlaceholder/);
  assert.match(mediaSrc, /spirit-card-media-placeholder/);
  assert.match(mediaSrc, /<SbMark/);
  assert.doesNotMatch(mediaSrc, /from "lucide-react"/);
  assert.match(cardSrc, /<SpiritCardMedia item=\{item\}\/>/);
});

test("image load error → same branded placeholder; no Keeper media mutation", () => {
  assert.match(mediaSrc, /onError=\{\(\) => setFailedSrc\(src\)\}/);
  assert.match(mediaSrc, /Never mutates stored image_url/);
  assert.doesNotMatch(mediaSrc, /\bapi\s*[<(]|method:\s*["']PUT["']/);
});

test("loading state does not show the empty shelf message", () => {
  assert.equal(
    inventoryViewState({ loading: true, error: "", itemCount: 0, filteredCount: 0 }),
    "loading"
  );
  assert.match(appSrc, /viewState === "loading"/);
  assert.match(appSrc, /SpiritShelfSkeleton/);
  assert.match(skeletonSrc, /aria-busy="true"/);
  assert.match(skeletonSrc, /aria-hidden="true"/);
  assert.match(
    appSrc,
    /viewState === "loading" \?[\s\S]*?viewState === "empty" \?[\s\S]*emptyTitle/
  );
});

test("successful zero-row response shows the empty state", () => {
  assert.equal(
    inventoryViewState({ loading: false, error: "", itemCount: 0, filteredCount: 0 }),
    "empty"
  );
  assert.match(appSrc, /viewState === "empty"/);
  assert.match(appSrc, /Nothing on the shelf yet/);
});

test("error state does not show the empty state", () => {
  assert.equal(
    inventoryViewState({ loading: false, error: "boom", itemCount: 0, filteredCount: 0 }),
    "error"
  );
  assert.match(appSrc, /viewState === "error"/);
  assert.match(
    appSrc,
    /viewState === "error" \?[\s\S]*?viewState === "loading" \?[\s\S]*?viewState === "empty" \?/
  );
});

test("loaded populated state renders normal spirit cards", () => {
  assert.equal(
    inventoryViewState({ loading: false, error: "", itemCount: 2, filteredCount: 2 }),
    "populated"
  );
  assert.match(appSrc, /module\.id === "spirits"[\s\S]*<SpiritInventoryCard/);
});

test("existing bottle-card interactions remain intact", () => {
  assert.match(cardSrc, /onOpenDetail/);
  assert.match(cardSrc, /keeper-card-controls|keeper-controls/);
  assert.match(cardSrc, /pourSpirit/);
  assert.match(cardSrc, /blocked_from_ordering/);
  assert.match(cssSrc, /\.domain-card-media\{[^}]*aspect-ratio:4\/5/);
  assert.match(cssSrc, /\.spirit-card-media\{/);
  assert.match(cssSrc, /spirit-card-media-placeholder/);
});

test("filtered-empty is distinct from shelf-empty", () => {
  assert.equal(
    inventoryViewState({ loading: false, error: "", itemCount: 3, filteredCount: 0 }),
    "filtered-empty"
  );
});
