import { ArrowLeft, Printer } from "lucide-react";
import { BrewSheetDocument } from "./BrewSheetDocument";

/** App chrome around the paper. The document itself does not know about navigation. */
export function BrewSheetPreview({ recipe, onBack }: { recipe: unknown; onBack: () => void }) {
  return (
    <div className="brew-sheet-preview">
      <div className="brew-sheet-preview-bar">
        <button type="button" className="secondary back-button" onClick={onBack}>
          <ArrowLeft size={16}/> Back to Recipe
        </button>
        <button type="button" className="secondary" onClick={() => window.print()}>
          <Printer size={16}/> Print Preview
        </button>
      </div>
      <div className="brew-sheet-fit">
        <div className="brew-sheet-page">
          <BrewSheetDocument recipe={recipe}/>
        </div>
      </div>
    </div>
  );
}
