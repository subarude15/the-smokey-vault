import { Library, X } from "lucide-react";
import type { SubstituteOption } from "./catalog";

export type SubstituteGroup = {
  ingredient: string;
  options: SubstituteOption[];
};

function fillLabel(fill: number) {
  if (fill >= 95) return "Full bottle";
  if (fill <= 10) return "Nearly out";
  return `${fill}% left`;
}

export function SubstitutesDrawer({ groups, close }: { groups: SubstituteGroup[]; close: () => void }) {
  return (
    <div className="modal-backdrop substitutes-backdrop" role="dialog" aria-modal="true" aria-label="On-shelf substitutes">
      <section className="modal substitutes-drawer">
        <header className="modal-header">
          <div>
            <span className="eyebrow">THE LIBRARY CARD</span>
            <h2><Library size={22}/> On-shelf substitutes</h2>
            <p>What the house can pour in place of the original call.</p>
          </div>
          <button type="button" className="icon-button" onClick={close} aria-label="Close substitutes"><X/></button>
        </header>
        <div className="substitutes-body">
          {groups.map((group) => (
            <article className="substitute-group" key={group.ingredient}>
              <span className="eyebrow">INSTEAD OF</span>
              <h3>{group.ingredient}</h3>
              <ul className="substitute-options">
                {group.options.map((option) => (
                  <li key={`${option.brand}-${option.name}`}>
                    <div>
                      <strong>{option.name}</strong>
                      {option.brand && option.brand.toLowerCase() !== option.name.toLowerCase()
                        ? <small>{option.brand}</small>
                        : null}
                    </div>
                    <span className={`substitute-fill${option.fill_level <= 10 ? " low" : ""}`}>{fillLabel(option.fill_level)}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <footer className="modal-footer">
          <button type="button" className="primary" onClick={close}>Back to the recipe</button>
        </footer>
      </section>
    </div>
  );
}
