import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { createReview, deleteReview, deleteReviewsForItem, listReviews } from "./reviews.js";

function insertBeer() {
  return Number(db.prepare(
    "INSERT INTO packaged_beer(brewery, name, style, abv) VALUES(?, ?, ?, ?)"
  ).run("Tröegs", "Nugget Nectar", "Imperial Amber", 7.5).lastInsertRowid);
}

test("guests can post a named review and admin can delete it", () => {
  const itemId = insertBeer();
  try {
    const review = createReview("packaged_beer", itemId, "  Sam  ", "Bright orange peel and sticky malt.");
    assert.equal(review.author, "Sam");
    assert.equal(listReviews("packaged_beer", itemId).length, 1);
    assert.equal(deleteReview(review.id), true);
    assert.equal(listReviews("packaged_beer", itemId).length, 0);
  } finally {
    db.prepare("DELETE FROM packaged_beer WHERE id=?").run(itemId);
  }
});

test("reviews require a name, body, and a real bottle", () => {
  const itemId = insertBeer();
  try {
    assert.throws(() => createReview("packaged_beer", itemId, "", "Nice"), /name/i);
    assert.throws(() => createReview("packaged_beer", itemId, "Sam", "   "), /review/i);
    assert.throws(() => createReview("packaged_beer", 999999, "Sam", "Nice"), /not found/i);
  } finally {
    db.prepare("DELETE FROM packaged_beer WHERE id=?").run(itemId);
  }
});

test("deleting a bottle also clears its reviews", () => {
  const itemId = insertBeer();
  createReview("packaged_beer", itemId, "Alex", "A cellar favorite.");
  deleteReviewsForItem("packaged_beer", itemId);
  db.prepare("DELETE FROM packaged_beer WHERE id=?").run(itemId);
  assert.equal(listReviews("packaged_beer", itemId).length, 0);
});
