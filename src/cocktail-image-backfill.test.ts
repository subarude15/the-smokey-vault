/**
 * PR145 — Bounded, fill-missing cocktail photo backfill with cursor rotation.
 * Uses an injected discovery function; no live search or remote image hosts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { db, setSetting } = await import("./db.js");
const { backfillMissingCocktailImages, COCKTAIL_IMAGE_BACKFILL_CURSOR } = await import("./cocktail_image.js");

const PREFIX = `PR145-BF-${Date.now()}`;
const PLACEHOLDER = "__pr145_backfill_placeholder__";

/**
 * The seeded catalog ships ~130 image-less cocktails that would otherwise dominate
 * the bounded backfill. Mask every currently-missing row so the test's own inserts
 * are the only eligible rows, and reset the rotation cursor for determinism.
 */
function isolateMissingRows(): () => void {
  db.prepare("UPDATE cocktails SET image_url = ? WHERE image_url IS NULL OR trim(image_url) = ''").run(PLACEHOLDER);
  setSetting(COCKTAIL_IMAGE_BACKFILL_CURSOR, "0");
  return () => {
    db.prepare("UPDATE cocktails SET image_url = '' WHERE image_url = ?").run(PLACEHOLDER);
    setSetting(COCKTAIL_IMAGE_BACKFILL_CURSOR, "0");
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

test("repeated runs rotate past persistent no-results and eventually reach later cocktails", async () => {
  const restore = isolateMissingRows();
  // Five eligible cocktails; discovery always returns no result.
  const ids = [1, 2, 3, 4, 5].map((n) => insertCocktail({ name: `${PREFIX} Rotate ${n}` }));

  try {
    const runs: number[][] = [];
    const findImage = async (id: number) => {
      return { status: "no_result", reason: "no_trustworthy_source" } as const;
    };

    // Three bounded runs of 2 should cover all five distinct rows despite the first
    // two always returning no result.
    for (let i = 0; i < 3; i++) {
      const seen: number[] = [];
      await backfillMissingCocktailImages({
        limit: 2,
        findImage: async (id) => {
          seen.push(id);
          return findImage(id);
        }
      });
      runs.push(seen);
    }

    assert.deepEqual(runs[0], ids.slice(0, 2), "run 1 attempts the first two");
    assert.deepEqual(runs[1], ids.slice(2, 4), "run 2 advances past the first group (no re-retry)");
    // Run 1 and run 2 must be disjoint — proof the leading no-results do not starve later rows.
    assert.equal(runs[0].some((id) => runs[1].includes(id)), false);

    // The later cocktail (ids[4]) is reached only because the cursor advanced.
    const covered = new Set([...runs[0], ...runs[1], ...runs[2]]);
    for (const id of ids) {
      assert.ok(covered.has(id), `cocktail ${id} was eventually attempted`);
    }
    assert.ok(runs[2].includes(ids[4]), "the last cocktail is reached on run 3");
    // Every row is still image-less (all were no-result) — a valid outcome.
    for (const id of ids) assert.equal(imageOf(id), "");
  } finally {
    restore();
    db.prepare(`DELETE FROM cocktails WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  }
});

test("a no_result leaves the cocktail without a photo and is not counted as updated", async () => {
  const restore = isolateMissingRows();
  const id = insertCocktail({ name: `${PREFIX} None` });
  try {
    const result = await backfillMissingCocktailImages({
      limit: 5,
      findImage: async () => ({ status: "no_result", reason: "no_trustworthy_source" })
    });
    assert.equal(result.attempted, 1);
    assert.equal(result.updated, 0);
    assert.equal(imageOf(id), "");
  } finally {
    restore();
    db.prepare("DELETE FROM cocktails WHERE id = ?").run(id);
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
