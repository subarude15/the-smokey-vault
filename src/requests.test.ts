import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { addNextRequest, deleteNextRequest, listNextBoards, voteNextRequest } from "./requests.js";

const ALPHA = "voter-alpha-1";
const BRAVO = "voter-bravo-2";

function wipe() {
  db.prepare("DELETE FROM stock_request_votes").run();
  db.prepare("DELETE FROM stock_requests").run();
}

test("guests can request a bottle and vote once", () => {
  wipe();
  try {
    const boards = addNextRequest({
      voter: ALPHA,
      board: "shelf",
      kind: "spirits",
      name: "Green Chartreuse",
      maker: "Chartreuse"
    });
    assert.equal(boards.shelf.length, 1);
    assert.equal(boards.shelf[0].name, "Green Chartreuse");
    assert.equal(boards.shelf[0].votes, 1);
    assert.equal(boards.shelf[0].mine, true);
    const cleared = voteNextRequest(boards.shelf[0].id, ALPHA);
    assert.equal(cleared.shelf[0].votes, 0);
    assert.equal(cleared.shelf[0].mine, false);
  } finally {
    wipe();
  }
});

test("two browsers keep separate votes and the board ranks by count", () => {
  wipe();
  try {
    addNextRequest({ voter: ALPHA, board: "keg", name: "House Pils" });
    const second = addNextRequest({ voter: ALPHA, board: "keg", name: "Vault Stout" });
    voteNextRequest(second.keg.find((item) => item.name === "House Pils")!.id, BRAVO);
    const boards = listNextBoards(BRAVO);
    assert.equal(boards.keg[0].name, "House Pils");
    assert.equal(boards.keg[0].votes, 2);
    assert.equal(boards.keg[0].mine, true);
    assert.equal(boards.keg[1].name, "Vault Stout");
    assert.equal(boards.keg[1].votes, 1);
    assert.equal(boards.keg[1].mine, false);
  } finally {
    wipe();
  }
});

test("adding a name that's already on the board votes it instead of duplicating", () => {
  wipe();
  try {
    addNextRequest({ voter: ALPHA, board: "brew", name: "Pilsner" });
    const boards = addNextRequest({ voter: BRAVO, board: "brew", name: "pilsner" });
    assert.equal(boards.brew.length, 1);
    assert.equal(boards.brew[0].votes, 2);
    assert.equal(boards.brew[0].mine, true);
  } finally {
    wipe();
  }
});

test("shelf, keg, and brew stay on their own boards", () => {
  wipe();
  try {
    addNextRequest({ voter: ALPHA, board: "shelf", kind: "wines", name: "Village Rouge", maker: "Foo" });
    addNextRequest({ voter: ALPHA, board: "keg", name: "Pilsner" });
    addNextRequest({ voter: ALPHA, board: "brew", name: "Pilsner" });
    const boards = listNextBoards(ALPHA);
    assert.equal(boards.shelf[0].kind, "wines");
    assert.equal(boards.keg[0].kind, "keg");
    assert.equal(boards.brew[0].kind, "brew");
    assert.equal(boards.keg[0].votes, 1);
    assert.equal(boards.brew[0].votes, 1);
  } finally {
    wipe();
  }
});

test("blank names are rejected and admin can remove a request", () => {
  wipe();
  try {
    assert.throws(() => addNextRequest({ voter: ALPHA, board: "shelf", name: "  " }), /name/i);
    const boards = addNextRequest({ voter: ALPHA, board: "shelf", name: "Campari" });
    assert.equal(deleteNextRequest(boards.shelf[0].id), true);
    assert.equal(listNextBoards(ALPHA).shelf.length, 0);
  } finally {
    wipe();
  }
});
