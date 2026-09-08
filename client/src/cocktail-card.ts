export type CocktailCardReadiness = "ready" | "almost" | "missing" | string;

export type CocktailReadinessPresentation = {
  label: string;
  tone: "ready" | "almost" | "missing";
};

export function cocktailReadinessPresentation(readiness: CocktailCardReadiness): CocktailReadinessPresentation {
  if (readiness === "ready") return { label: "Ready", tone: "ready" };
  if (readiness === "almost") return { label: "One bottle away", tone: "almost" };
  return { label: "Missing ingredients", tone: "missing" };
}

export function missingIngredientSummary(missing: unknown, limit = 2): string {
  if (!Array.isArray(missing) || missing.length === 0) return "";
  const items = missing.map((entry) => String(entry).trim()).filter(Boolean);
  if (!items.length) return "";
  const safeLimit = Math.max(1, Math.floor(limit));
  const shown = items.slice(0, safeLimit);
  const remainder = items.length - shown.length;
  return `Missing: ${shown.join(", ")}${remainder > 0 ? ` +${remainder}` : ""}`;
}
