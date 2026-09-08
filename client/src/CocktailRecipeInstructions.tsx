import { parseCocktailInstructions } from "./cocktail-instructions";

type CocktailRecipeInstructionsProps = {
  method: unknown;
};

export function CocktailRecipeInstructions({ method }: CocktailRecipeInstructionsProps) {
  const parsed = parseCocktailInstructions(method);
  if (parsed.kind === "empty") return null;

  if (parsed.kind === "method") {
    return (
      <div className="recipe-instructions recipe-instructions-method">
        <span className="eyebrow">METHOD</span>
        <strong>{parsed.label}</strong>
      </div>
    );
  }

  if (parsed.kind === "prose") {
    return (
      <div className="recipe-instructions">
        <span className="eyebrow">INSTRUCTIONS</span>
        <p>{parsed.text}</p>
      </div>
    );
  }

  return (
    <div className="recipe-instructions">
      <span className="eyebrow">INSTRUCTIONS</span>
      <ol>
        {parsed.steps.map((step, index) => (
          <li key={`${index}-${step.slice(0, 24)}`}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
