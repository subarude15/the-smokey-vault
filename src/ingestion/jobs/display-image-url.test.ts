/**
 * Display-only enrichment image fallback for inventory UI.
 * Leaves inventory.image_url untouched; attaches derived display_image_url.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import {
  attachInventoryDisplayImageUrl,
  clearProductImagesForTests,
  inventoryHasUserImage,
  resolveInventoryDisplayImageUrl,
  upsertProductImage
} from "./index.js";

const CAPTAIN_UPC = "087000201156";
const ENRICHED_URL = "https://cdn.example.com/captain-morgan-original-spiced.jpg";
const USER_IMAGE = "/api/media/images/user-shelf-captain.jpg";
const LOOKUP_URL = "https://cdn.example.com/lookup-candidate.jpg";
const REJECTED_URL = "https://cdn.example.com/rejected-candidate.jpg";

function insertSpirit(overrides: Record<string, unknown> = {}) {
  const row = {
    name: "Captain Morgan Original Spiced Rum",
    brand: "Captain Morgan",
    category: "Rum",
    abv: 35,
    volume_ml: 750,
    upc: CAPTAIN_UPC,
    image_url: "",
    ...overrides
  };
  const result = db.prepare(`
    INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.name, row.brand, row.category, row.abv, row.volume_ml, row.upc, row.image_url);
  const id = Number(result.lastInsertRowid);
  return db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
}

function cleanup() {
  clearProductImagesForTests();
  db.prepare("DELETE FROM spirits WHERE upc = ? OR name LIKE 'DisplayImage%'").run(CAPTAIN_UPC);
}

function seedAcceptedEnrichment(entityId: number, url = ENRICHED_URL) {
  upsertProductImage({
    entityType: "spirits",
    entityId,
    url,
    sourceType: "approved",
    sourceUrl: "https://www.captainmorgan.com/products/original-spiced-rum",
    width: 1200,
    height: 1600,
    mimeType: "image/jpeg",
    score: 75,
    verified: true,
    rejectionReason: null
  });
}

test("A. user inventory image wins over accepted enrichment", () => {
  cleanup();
  const spirit = insertSpirit({
    name: "DisplayImage UserWins",
    image_url: USER_IMAGE
  });
  seedAcceptedEnrichment(Number(spirit.id));

  assert.equal(inventoryHasUserImage(spirit, "spirits", Number(spirit.id)), true);
  assert.equal(
    resolveInventoryDisplayImageUrl("spirits", Number(spirit.id), spirit),
    USER_IMAGE
  );

  const attached = attachInventoryDisplayImageUrl("spirits", spirit);
  assert.equal(attached.display_image_url, USER_IMAGE);
  assert.equal(attached.image_url, USER_IMAGE);
});

test("B. accepted enrichment is display fallback when inventory has no user image", () => {
  cleanup();
  const spirit = insertSpirit({ name: "DisplayImage EnrichmentFallback", image_url: "" });
  seedAcceptedEnrichment(Number(spirit.id));

  assert.equal(inventoryHasUserImage(spirit, "spirits", Number(spirit.id)), false);
  assert.equal(
    resolveInventoryDisplayImageUrl("spirits", Number(spirit.id), spirit),
    ENRICHED_URL
  );
  assert.equal(attachInventoryDisplayImageUrl("spirits", spirit).display_image_url, ENRICHED_URL);
});

test("C. placeholder path when neither user nor accepted enrichment exists", () => {
  cleanup();
  const spirit = insertSpirit({ name: "DisplayImage Placeholder", image_url: "" });

  assert.equal(resolveInventoryDisplayImageUrl("spirits", Number(spirit.id), spirit), null);
  assert.equal(attachInventoryDisplayImageUrl("spirits", spirit).display_image_url, null);
});

test("D. lookup / unverified / rejected candidates never become the hero", () => {
  cleanup();
  const spirit = insertSpirit({ name: "DisplayImage RejectLookup", image_url: "" });

  upsertProductImage({
    entityType: "spirits",
    entityId: Number(spirit.id),
    url: LOOKUP_URL,
    sourceType: "lookup",
    verified: false,
    score: 40,
    rejectionReason: null
  });
  assert.equal(resolveInventoryDisplayImageUrl("spirits", Number(spirit.id), spirit), null);

  upsertProductImage({
    entityType: "spirits",
    entityId: Number(spirit.id),
    url: REJECTED_URL,
    sourceType: "approved",
    verified: false,
    score: 10,
    rejectionReason: "score_below_threshold"
  });
  assert.equal(resolveInventoryDisplayImageUrl("spirits", Number(spirit.id), spirit), null);

  upsertProductImage({
    entityType: "spirits",
    entityId: Number(spirit.id),
    url: "https://cdn.example.com/unknown-source.jpg",
    sourceType: "unknown",
    verified: true,
    score: 90,
    rejectionReason: null
  });
  assert.equal(resolveInventoryDisplayImageUrl("spirits", Number(spirit.id), spirit), null);
});

test("E. selecting enrichment display fallback does not write inventory.image_url", () => {
  cleanup();
  const spirit = insertSpirit({ name: "DisplayImage CanonicalUnchanged", image_url: "" });
  seedAcceptedEnrichment(Number(spirit.id));

  const before = db.prepare("SELECT image_url FROM spirits WHERE id=?").get(spirit.id) as {
    image_url: string;
  };
  assert.equal(before.image_url, "");

  const display = resolveInventoryDisplayImageUrl("spirits", Number(spirit.id), spirit);
  assert.equal(display, ENRICHED_URL);

  const after = db.prepare("SELECT image_url FROM spirits WHERE id=?").get(spirit.id) as {
    image_url: string;
  };
  assert.equal(after.image_url, "");
  assert.notEqual(after.image_url, ENRICHED_URL);
});

test("F. public derived field is URL-only (no diagnostics / provenance leak)", () => {
  cleanup();
  const spirit = insertSpirit({ name: "DisplayImage PublicSafe", image_url: "" });
  seedAcceptedEnrichment(Number(spirit.id));

  const attached = attachInventoryDisplayImageUrl("spirits", {
    ...spirit,
    secret_notes: "keeper-only"
  });

  assert.equal(attached.display_image_url, ENRICHED_URL);
  assert.equal(Object.prototype.hasOwnProperty.call(attached, "score"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(attached, "verified"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(attached, "source_type"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(attached, "diagnostics"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(attached, "provenance"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(attached, "rejection_reason"), false);
  // Only the URL field is added; no enrichment metadata bag.
  assert.equal(
    Object.keys(attached).filter((key) => key.startsWith("display_")).join(","),
    "display_image_url"
  );
});

test("Captain Morgan regression: accepted enrichment fills display when no user image", () => {
  cleanup();
  const spirit = insertSpirit({
    name: "Captain Morgan Original Spiced Rum",
    brand: "Captain Morgan",
    upc: CAPTAIN_UPC,
    image_url: ""
  });
  seedAcceptedEnrichment(Number(spirit.id), ENRICHED_URL);

  const attached = attachInventoryDisplayImageUrl("spirits", spirit);
  assert.equal(attached.display_image_url, ENRICHED_URL);
  assert.equal(String(attached.image_url ?? "").trim(), "");
  assert.equal(inventoryHasUserImage(spirit, "spirits", Number(spirit.id)), false);
});
