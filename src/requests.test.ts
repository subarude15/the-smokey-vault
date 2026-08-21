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

test("guests can request liquor or wine and toggle an up vote", () => {
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
    assert.equal(boards.shelf[0].up, 1);
    assert.equal(boards.shelf[0].mine, 1);
    const cleared = voteNextRequest(boards.shelf[0].id, ALPHA);
    assert.equal(cleared.shelf[0].up, 0);
    assert.equal(cleared.shelf[0].mine, null);
  } finally {
    wipe();
  }
});

test("shelf rejects packaged beer", () => {
  wipe();
  try {
    assert.throws(
      () => addNextRequest({ voter: ALPHA, board: "shelf", kind: "packaged_beer", name: "Hazy IPA" }),
      /liquor and wine/i
    );
  } finally {
    wipe();
  }
});

test("keg and brew options rank by net up/down and do not auto-vote the adder", () => {
  wipe();
  try {
    addNextRequest({ voter: ALPHA, board: "keg", name: "House Pils" });
    addNextRequest({ voter: ALPHA, board: "keg", name: "Vault Stout" });
    const listed = listNextBoards();
    assert.equal(listed.keg[0].up, 0);
    const pils = listed.keg.find((item) => item.name === "House Pils")!;
    const stout = listed.keg.find((item) => item.name === "Vault Stout")!;
    voteNextRequest(pils.id, ALPHA, 1);
    voteNextRequest(pils.id, BRAVO, 1);
    voteNextRequest(stout.id, ALPHA, -1);
    const boards = listNextBoards(BRAVO);
    assert.equal(boards.keg[0].name, "House Pils");
    assert.equal(boards.keg[0].up, 2);
    assert.equal(boards.keg[0].net, 2);
    assert.equal(boards.keg[0].mine, 1);
    assert.equal(boards.keg[1].name, "Vault Stout");
    assert.equal(boards.keg[1].down, 1);
    assert.equal(boards.keg[1].net, -1);
    assert.equal(boards.keg[1].mine, null);
  } finally {
    wipe();
  }
});

test("adding a liquor that's already on the board votes it instead of duplicating", () => {
  wipe();
  try {
    addNextRequest({ voter: ALPHA, board: "shelf", name: "Campari" });
    const boards = addNextRequest({ voter: BRAVO, board: "shelf", name: "campari" });
    assert.equal(boards.shelf.length, 1);
    assert.equal(boards.shelf[0].up, 2);
    assert.equal(boards.shelf[0].mine, 1);
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
    assert.equal(boards.shelf[0].up, 1);
    assert.equal(boards.keg[0].up, 0);
    assert.equal(boards.brew[0].up, 0);
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
