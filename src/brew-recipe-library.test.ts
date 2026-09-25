import assert from "node:assert/strict";
import test from "node:test";
import { db } from "./db.js";

test("brew recipe library routes list, open, brew again, and delete sessions with the recipe", async () => {
  const { app, createTestAdminToken } = await import("./server.js");
  const headers = { authorization: `Bearer ${createTestAdminToken()}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/admin/brewery/recipes",
    headers,
    payload: {
      name: "Candy Cloud Hazy DIPA",
      style: "Hazy DIPA",
      sourceText: "original instructions",
      recipe: {
        beerName: "Candy Cloud Hazy DIPA",
        style: "Hazy DIPA",
        targetOg: "1.080",
        targetAbv: "~7.8%",
        water: { sodiumPpm: "40", magnesiumPpm: "10" }
      }
    }
  });
  assert.equal(created.statusCode, 201);
  const id = (created.json() as { recipe: { id: number } }).recipe.id;
  const recipesBefore = (db.prepare("SELECT COUNT(*) AS n FROM brew_recipes").get() as { n: number }).n;

  try {
    const anonymous = await app.inject({ method: "GET", url: "/api/admin/brewery/recipes" });
    assert.equal(anonymous.statusCode, 401);

    const list = await app.inject({ method: "GET", url: "/api/admin/brewery/recipes", headers });
    assert.equal(list.statusCode, 200);
    const listed = (list.json() as { recipes: { id: number }[] }).recipes;
    assert.equal(listed.some((row) => row.id === id), true);

    const detail = await app.inject({ method: "GET", url: `/api/admin/brewery/recipes/${id}`, headers });
    assert.equal(detail.statusCode, 200);
    const body = detail.json() as {
      recipe: { sourceText: string; recipe: { water: { sodiumPpm: string } } };
      sessions: unknown[];
    };
    assert.equal(body.recipe.sourceText, "original instructions");
    assert.equal(body.recipe.recipe.water.sodiumPpm, "40");
    assert.deepEqual(body.sessions, []);

    const first = await app.inject({
      method: "POST",
      url: `/api/admin/brewery/recipes/${id}/sessions`,
      headers,
      payload: { status: "Planned" }
    });
    assert.equal(first.statusCode, 201);
    const firstSession = (first.json() as { session: { brewNumber: number; recipeId: number } }).session;
    assert.equal(firstSession.brewNumber, 1);
    assert.equal(firstSession.recipeId, id);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM brew_recipes").get() as { n: number }).n, recipesBefore);

    const second = await app.inject({
      method: "POST",
      url: `/api/admin/brewery/recipes/${id}/sessions`,
      headers,
      payload: {}
    });
    assert.equal(second.statusCode, 201);
    assert.equal((second.json() as { session: { brewNumber: number } }).session.brewNumber, 2);

    const again = await app.inject({ method: "GET", url: `/api/admin/brewery/recipes/${id}`, headers });
    const numbers = (again.json() as { sessions: { brewNumber: number }[] }).sessions.map((row) => row.brewNumber);
    assert.deepEqual(numbers, [2, 1]);

    const removed = await app.inject({ method: "DELETE", url: `/api/admin/brewery/recipes/${id}`, headers });
    assert.equal(removed.statusCode, 204);
    const missing = await app.inject({ method: "GET", url: `/api/admin/brewery/recipes/${id}`, headers });
    assert.equal(missing.statusCode, 404);
    const leftover = db.prepare("SELECT COUNT(*) AS n FROM brew_sessions WHERE recipe_id=?").get(id) as { n: number };
    assert.equal(leftover.n, 0);
  } finally {
    db.prepare("DELETE FROM brew_sessions WHERE recipe_id=?").run(id);
    db.prepare("DELETE FROM brew_recipes WHERE id=?").run(id);
  }
});
