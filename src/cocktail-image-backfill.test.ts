/**
 * PR145 — Bounded, fill-missing cocktail photo backfill.
 * Uses an injected discovery function; no live search or remote image hosts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { db } = await import("./db.js");
const { backfillMissingCocktailImages } = await import("./cocktail_image.js");

const PREFIX = `PR145-BF-${Date.now()}`;
const PLACEHOLDER = "__pr145_backfill_placeholder__";

/**
 * The seeded catalog ships ~130 image-less cocktails that would otherwise dominate
 * the bounded backfill. Mask every currently-missing row so the test's own inserts
 * are the only missing rows, then restore exactly afterward.
 */
function isolateMissingRows(): () => void {
  db.prepare("UPDATE cocktails SET image_url = ? WHERE image_url IS NULL OR trim(image_url) = ''").run(PLACEHOLDER);
  return () => {
    db.prepare("UPDATE cocktails SET image_url = '' WHERE image_url = ?").run(PLACEHOLDER);
  };
}

function insertCocktail(args: { name: string; collection?: string; imageUrl?: string }): number {
  const result = db
    .prepare("INSERT INTO cocktails(name, collection, ingredients, image_url) VALUES(?,?,?,?)")
    .run(
      args.name,
      args.collection ?? "IBA Classics",
      JSON.stringify(["30 ml gin"]),
      args.imageUrl ?? ""
    );
  return Number(result.lastInsertRowid);
}

function imageOf(id: number): string {
  const row = db.prepare("SELECT image_url FROM cocktails WHERE id = ?").get(id) as { image_url: string | null };
  return String(row?.image_url ?? "");
}

test("backfill only targets built-in cocktails missing an image and fills them", async () => {
  const restore = isolateMissingRows();
  const missing = insertCocktail({ name: `${PREFIX} Missing` });
  const hasImage = insertCocktail({ name: `${PREFIX} HasImage`, imageUrl: "/api/media/images/existing.webp" });
  const custom = insertCocktail({ name: `${PREFIX} Custom`, collection: "Custom Cocktails" });

  try {
    const seen: number[] = [];
    const result = await backfillMissingCocktailImages({
      limit: 50,
      findImage: async (id) => {
        seen.push(id);
        // Simulate the real fill-missing write so the row reflects an update.
        db.prepare("UPDATE cocktails SET image_url = ? WHERE id = ? AND trim(image_url) = ''")
          .run("/api/media/images/found.webp", id);
        return { status: "updated", image_url: "/api/media/images/found.webp" };
      }
    });

    assert.deepEqual(seen, [missing], "only the missing built-in cocktail is attempted");
    assert.equal(result.attempted, 1);
    assert.equal(result.updated, 1);

    assert.equal(imageOf(missing), "/api/media/images/found.webp");
    assert.equal(imageOf(hasImage), "/api/media/images/existing.webp", "existing image is never overwritten");
    assert.equal(imageOf(custom), "", "custom cocktail left untouched");
  } finally {
    restore();
    db.prepare("DELETE FROM cocktails WHERE id IN (?,?,?)").run(missing, hasImage, custom);
  }
});

test("backfill is bounded by the limit and a no_result leaves the cocktail without a photo", async () => {
  const restore = isolateMissingRows();
  const ids = [1, 2, 3, 4].map((n) => insertCocktail({ name: `${PREFIX} Bound ${n}` }));

  try {
    const seen: number[] = [];
    const result = await backfillMissingCocktailImages({
      limit: 2,
      findImage: async (id) => {
        seen.push(id);
        return { status: "no_result", reason: "no_trustworthy_source" };
      }
    });

    assert.equal(seen.length, 2, "respects the per-run limit");
    assert.deepEqual(seen, ids.slice(0, 2), "attempts the lowest-id missing rows first");
    assert.equal(result.attempted, 2);
    assert.equal(result.updated, 0, "no_result does not count as updated");
    for (const id of ids) {
      assert.equal(imageOf(id), "", "no_result leaves the cocktail without a photo");
    }
  } finally {
    restore();
    db.prepare(`DELETE FROM cocktails WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  }
});

test("backfill survives a discovery error without throwing", async () => {
  const restore = isolateMissingRows();
  const id = insertCocktail({ name: `${PREFIX} Boom` });
  try {
    const result = await backfillMissingCocktailImages({
      limit: 10,
      findImage: async () => {
        throw new Error("search backend down");
      }
    });
    assert.equal(result.attempted, 1);
    assert.equal(result.updated, 0);
    assert.equal(imageOf(id), "");
  } finally {
    restore();
    db.prepare("DELETE FROM cocktails WHERE id = ?").run(id);
  }
});
