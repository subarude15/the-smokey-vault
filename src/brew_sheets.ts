import { z } from "zod";
import { db } from "./db.js";

export const brewRecipeDocumentSchema = z.object({
  beerName: z.string().trim().min(1),
  style: z.string().trim().default(""),
  system: z.string().trim().default(""),
  fermenter: z.string().trim().default(""),
  targetPackaged: z.string().trim().default(""),
  fermenterVolume: z.string().trim().default(""),
  boilTime: z.string().trim().default(""),
  targetOg: z.string().trim().default(""),
  targetFg: z.string().trim().default(""),
  targetAbv: z.string().trim().default(""),
  estimatedIbu: z.string().trim().default(""),
  mashEfficiency: z.string().trim().default(""),
  water: z.record(z.string(), z.unknown()).default({}),
  fermentables: z.array(z.record(z.string(), z.unknown())).default([]),
  kettleAdditions: z.array(z.record(z.string(), z.unknown())).default([]),
  whirlpoolAdditions: z.array(z.record(z.string(), z.unknown())).default([]),
  dryHopStages: z.array(z.record(z.string(), z.unknown())).default([]),
  fermentation: z.record(z.string(), z.unknown()).default({}),
  packaging: z.record(z.string(), z.unknown()).default({}),
  warnings: z.array(z.string()).default([]),
  checklist: z.array(z.string()).default([]),
  notes: z.string().default("")
});

export type BrewRecipeDocument = z.infer<typeof brewRecipeDocumentSchema>;

export const createBrewRecipeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  style: z.string().trim().max(120).default(""),
  sourceText: z.string().max(100_000).default(""),
  recipe: brewRecipeDocumentSchema
});

export const updateBrewRecipeSchema = createBrewRecipeSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required"
);

export const createBrewSessionSchema = z.object({
  brewedAt: z.string().trim().max(64).optional().nullable(),
  status: z.string().trim().min(1).max(40).default("Planned"),
  actuals: z.record(z.string(), z.unknown()).default({}),
  notes: z.string().max(20_000).default("")
});

function parseJsonObject(value: string | null | undefined) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function recipeRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    style: row.style ?? "",
    sourceText: row.source_text ?? "",
    recipe: parseJsonObject(row.recipe_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sessionRow(row: any) {
  return {
    id: row.id,
    recipeId: row.recipe_id,
    brewNumber: row.brew_number,
    brewedAt: row.brewed_at,
    status: row.status,
    actuals: parseJsonObject(row.actuals_json),
    notes: row.notes ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listBrewRecipes() {
  return (db.prepare("SELECT * FROM brew_recipes ORDER BY updated_at DESC, id DESC").all() as any[]).map(recipeRow);
}

export function getBrewRecipe(id: number) {
  const row = db.prepare("SELECT * FROM brew_recipes WHERE id=?").get(id) as any;
  return row ? recipeRow(row) : null;
}

export function createBrewRecipe(input: z.infer<typeof createBrewRecipeSchema>) {
  const value = createBrewRecipeSchema.parse(input);
  const result = db.prepare(`
    INSERT INTO brew_recipes(name, style, source_text, recipe_json)
    VALUES (?, ?, ?, ?)
  `).run(value.name, value.style, value.sourceText, JSON.stringify(value.recipe));
  return getBrewRecipe(Number(result.lastInsertRowid));
}

export function updateBrewRecipe(id: number, input: z.infer<typeof updateBrewRecipeSchema>) {
  const current = getBrewRecipe(id);
  if (!current) return null;
  const value = updateBrewRecipeSchema.parse(input);
  const next = {
    name: value.name ?? current.name,
    style: value.style ?? current.style,
    sourceText: value.sourceText ?? current.sourceText,
    recipe: value.recipe ?? current.recipe
  };
  db.prepare(`
    UPDATE brew_recipes
    SET name=?, style=?, source_text=?, recipe_json=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(next.name, next.style, next.sourceText, JSON.stringify(next.recipe), id);
  return getBrewRecipe(id);
}

export function deleteBrewRecipe(id: number) {
  return db.transaction(() => {
    db.prepare("DELETE FROM brew_sessions WHERE recipe_id=?").run(id);
    const result = db.prepare("DELETE FROM brew_recipes WHERE id=?").run(id);
    return result.changes > 0;
  })();
}

export function listBrewSessions(recipeId: number) {
  return (db.prepare("SELECT * FROM brew_sessions WHERE recipe_id=? ORDER BY brew_number DESC").all(recipeId) as any[]).map(sessionRow);
}

export function createBrewSession(recipeId: number, input: z.infer<typeof createBrewSessionSchema>) {
  if (!getBrewRecipe(recipeId)) return null;
  const value = createBrewSessionSchema.parse(input);
  const next = db.prepare("SELECT COALESCE(MAX(brew_number),0)+1 AS n FROM brew_sessions WHERE recipe_id=?").get(recipeId) as { n: number };
  const result = db.prepare(`
    INSERT INTO brew_sessions(recipe_id, brew_number, brewed_at, status, actuals_json, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(recipeId, next.n, value.brewedAt ?? null, value.status, JSON.stringify(value.actuals), value.notes);
  const row = db.prepare("SELECT * FROM brew_sessions WHERE id=?").get(Number(result.lastInsertRowid)) as any;
  return sessionRow(row);
}
