import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { castVote, getVoteTally, summarizeVotes } from "./votes.js";

function insertBeer() {
  return Number(db.prepare(
    "INSERT INTO packaged_beer(brewery, name, style, abv) VALUES(?, ?, ?, ?)"
  ).run("Tröegs", "Nugget Nectar", "Imperial Amber", 7.5).lastInsertRowid);
}

test("summarizeVotes shows 9/10 when nine guests go up and one goes down", () => {
  const tally = summarizeVotes(9, 1);
  assert.equal(tally.net, 8);
  assert.equal(tally.score, 9);
  assert.equal(tally.total, 10);
});

test("one browser can vote once and switch or clear it", () => {
  const itemId = insertBeer();
  try {
    const up = castVote("packaged_beer", itemId, "voter-alpha-1", 1);
    assert.equal(up.up, 1);
    assert.equal(up.mine, 1);
    const switched = castVote("packaged_beer", itemId, "voter-alpha-1", -1);
    assert.equal(switched.up, 0);
    assert.equal(switched.down, 1);
    assert.equal(switched.mine, -1);
    const cleared = castVote("packaged_beer", itemId, "voter-alpha-1", -1);
    assert.equal(cleared.total, 0);
    assert.equal(cleared.mine, null);
    assert.equal(cleared.score, null);
  } finally {
    db.prepare("DELETE FROM votes WHERE item_id=?").run(itemId);
    db.prepare("DELETE FROM packaged_beer WHERE id=?").run(itemId);
  }
});

test("two browsers keep separate votes", () => {
  const itemId = insertBeer();
  try {
    castVote("packaged_beer", itemId, "voter-alpha-1", 1);
    castVote("packaged_beer", itemId, "voter-bravo-2", 1);
    const tally = getVoteTally("packaged_beer", itemId, "voter-alpha-1");
    assert.equal(tally.up, 2);
    assert.equal(tally.score, 10);
    assert.equal(tally.mine, 1);
  } finally {
    db.prepare("DELETE FROM votes WHERE item_id=?").run(itemId);
    db.prepare("DELETE FROM packaged_beer WHERE id=?").run(itemId);
  }
});
