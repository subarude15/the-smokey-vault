import { useState } from "react";
import { ArrowLeft, Download, LoaderCircle, Printer } from "lucide-react";
import { BREW_SHEET_PDF_ERROR } from "../../src/brew_sheet_pdf_shared";
import { downloadBrewSheetPdf } from "./api";
import { BrewSheetDocument } from "./BrewSheetDocument";

/** App chrome around the paper. The document itself does not know about navigation. */
export function BrewSheetPreview({
  recipe,
  recipeId,
  beerName,
  canDownload,
  onBack
}: {
  recipe: unknown;
  recipeId: number | null;
  beerName: string;
  canDownload: boolean;
  onBack: () => void;
}) {
  return (
    <div className="brew-sheet-preview">
      <div className="brew-sheet-preview-bar">
        <button type="button" className="secondary back-button" onClick={onBack}>
          <ArrowLeft size={16}/> Back to Recipe
        </button>
        <button type="button" className="secondary" onClick={() => window.print()}>
          <Printer size={16}/> Print Preview
        </button>
        {canDownload && recipeId != null && <BrewSheetPdfDownload recipeId={recipeId} beerName={beerName}/>}
      </div>
      <div className="brew-sheet-fit">
        <div className="brew-sheet-page">
          <BrewSheetDocument recipe={recipe}/>
        </div>
      </div>
    </div>
  );
}

export function BrewSheetPdfDownload({ recipeId, beerName }: { recipeId: number; beerName: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <span className="brew-sheet-pdf">
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => {
          if (busy) return;
          setBusy(true);
          setError("");
          void downloadBrewSheetPdf(recipeId, beerName).then(
            () => setBusy(false),
            () => {
              setError(BREW_SHEET_PDF_ERROR);
              setBusy(false);
            }
          );
        }}
      >
        {busy ? <LoaderCircle className="spinner" size={16}/> : <Download size={16}/>}
        {busy ? "Generating PDF…" : "Download PDF"}
      </button>
      {error ? <span className="brew-sheet-pdf-error" role="alert">{error}</span> : null}
    </span>
  );
}
