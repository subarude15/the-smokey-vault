import { resolveCocktailInstructions } from "./cocktail-instructions";

type CocktailRecipeInstructionsProps = {
  method: unknown;
  ingredients?: unknown;
  glassware?: unknown;
  garnish?: unknown;
};

export function CocktailRecipeInstructions({ method, ingredients, glassware, garnish }: CocktailRecipeInstructionsProps) {
  const resolved = resolveCocktailInstructions({ method, ingredients, glassware, garnish });
  if (resolved.kind === "empty") return null;

  if (resolved.kind === "prose") {
    return (
      <div className="recipe-instructions">
        <span className="eyebrow">INSTRUCTIONS</span>
        <p>{resolved.text}</p>
      </div>
    );
  }

  return (
    <div className="recipe-instructions">
      <span className="eyebrow">INSTRUCTIONS</span>
      <ol>
        {resolved.steps.map((step, index) => (
          <li key={`${index}-${step.slice(0, 24)}`}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
