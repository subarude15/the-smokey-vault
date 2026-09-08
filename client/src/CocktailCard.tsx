import { GlassWater, Star } from "lucide-react";
import { cocktailReadinessPresentation, missingIngredientSummary } from "./cocktail-card";
import { cocktailMethodSummary } from "./cocktail-instructions";
import "./cocktail-card.css";

export type CocktailCardDrink = {
  id: number | string;
  name: string;
  image_url?: unknown;
  readiness?: string;
  method?: unknown;
  glassware?: unknown;
  collection?: unknown;
  season?: unknown;
  missing?: unknown;
  notes?: unknown;
  bartender_fav?: unknown;
};

type CocktailCardProps = {
  drink: CocktailCardDrink;
  admin: boolean;
  onOpen: () => void;
  onToggleFavorite?: () => void;
  favoriteBusy?: boolean;
};

export function CocktailCard({ drink, admin, onOpen, onToggleFavorite, favoriteBusy = false }: CocktailCardProps) {
  const readiness = cocktailReadinessPresentation(String(drink.readiness ?? "missing"));
  const imageUrl = String(drink.image_url ?? "").trim();
  const method = cocktailMethodSummary(drink.method);
  const glassware = String(drink.glassware ?? "").trim();
  const collection = String(drink.collection ?? "").trim();
  const season = String(drink.season ?? "").trim();
  const notes = String(drink.notes ?? "").trim();
  const missing = missingIngredientSummary(drink.missing);
  const favorite = Number(drink.bartender_fav ?? 0) > 0;
  const styleLine = [collection, season && season !== "All" ? season : "", method, glassware].filter(Boolean).join(" · ");

  return (
    <article className={`cocktail-card cocktail-card-${readiness.tone}`}>
      <button type="button" className="cocktail-card-main" onClick={onOpen} aria-label={`Open ${drink.name} recipe`}>
        <div className="cocktail-card-media" aria-hidden={imageUrl ? undefined : true}>
          {imageUrl ? <img src={imageUrl} alt={drink.name}/> : <GlassWater aria-hidden="true"/>}
        </div>
        <div className="cocktail-card-copy">
          <div className="cocktail-card-heading">
            <span className={`cocktail-readiness cocktail-readiness-${readiness.tone}`}>{readiness.label}</span>
            {favorite ? <span className="cocktail-favorite-tag"><Star size={13} aria-hidden="true"/> Favorite</span> : null}
          </div>
          <h3>{drink.name}</h3>
          {styleLine ? <p className="cocktail-card-style">{styleLine}</p> : null}
          {missing ? <p className="cocktail-card-missing">{missing}</p> : null}
          {notes ? <p className="cocktail-card-notes">{notes}</p> : null}
        </div>
      </button>
      {admin && onToggleFavorite ? (
        <div className="cocktail-card-keeper" aria-label="Keeper controls">
          <button
            type="button"
            className={favorite ? "secondary active" : "secondary"}
            aria-pressed={favorite}
            disabled={favoriteBusy}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite();
            }}
          >
            <Star size={16} aria-hidden="true"/>
            {favoriteBusy ? "Saving…" : favorite ? "Favorite" : "Add favorite"}
          </button>
        </div>
      ) : null}
    </article>
  );
}
