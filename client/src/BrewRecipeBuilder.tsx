import { useState } from "react";
import { CircleAlert, LoaderCircle, Plus, Save } from "lucide-react";
import { api, ApiError } from "./api";
import { BrewRecipeEditor } from "./BrewRecipeEditor";
import {
  ANALYZE_EMPTY_MESSAGE,
  ANALYZE_TOO_LONG_MESSAGE,
  SAVE_FAILURE_MESSAGE,
  beginAnalyze,
  beginSave,
  brewRecipeSaveBody,
  BREW_SHEET_SOURCE_MAX_CHARS,
  builderIsDirty,
  canAnalyze,
  editSaved,
  emptyBuilderState,
  failAnalyze,
  failSave,
  finishAnalyze,
  finishSave,
  NEW_RECIPE_CONFIRM,
  publicAnalyzeError,
  saveBlockReason,
  savedRecipeId,
  withDraft,
  withRawText,
  type BuilderPhase,
  type BuilderState
} from "./brew-recipe-builder";

function heading(phase: BuilderPhase, beerName: string): { title: string; subtitle: string } {
  switch (phase) {
    case "paste":
      return {
        title: "New Brew Recipe.",
        subtitle: "Paste the brewing instructions. Analyze turns them into fields you can check before anything is saved."
      };
    case "review":
      return {
        title: "Review the recipe.",
        subtitle: "Edit anything that looks off. Nothing is stored until you save."
      };
    case "saved":
      return {
        title: "Recipe saved.",
        subtitle: beerName
          ? `${beerName} is in the brew sheet book. The original instructions stayed with it.`
          : "The original instructions stayed with this recipe."
      };
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

export function BrewRecipeBuilder() {
  const [state, setState] = useState<BuilderState>(emptyBuilderState);
  const copy = heading(state.phase, state.draft?.beerName.trim() ?? "");
  const analyzing = state.busy === "analyzing";
  const saving = state.busy === "saving";

  function startNew() {
    if (builderIsDirty(state) && !window.confirm(NEW_RECIPE_CONFIRM)) return;
    setState(emptyBuilderState());
  }

  async function analyze() {
    if (!state.rawText.trim()) {
      setState((current) => ({ ...current, error: ANALYZE_EMPTY_MESSAGE }));
      return;
    }
    if (state.rawText.length > BREW_SHEET_SOURCE_MAX_CHARS) {
      setState((current) => ({ ...current, error: ANALYZE_TOO_LONG_MESSAGE }));
      return;
    }
    if (!canAnalyze(state)) return;
    const text = state.rawText;
    setState(beginAnalyze);
    try {
      const payload = await api<{ recipe: unknown }>("/admin/brewery/parse-recipe", {
        method: "POST",
        body: JSON.stringify({ text })
      });
      setState((current) => finishAnalyze({ ...current, rawText: text }, payload.recipe));
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 502;
      const serverMessage = error instanceof ApiError ? error.message : "";
      const message = publicAnalyzeError(status, serverMessage);
      setState((current) => ({ ...failAnalyze(current), rawText: current.rawText || text, error: message }));
    }
  }

  async function saveRecipe() {
    const reason = saveBlockReason(state);
    const body = brewRecipeSaveBody(state);
    if (reason || !body) {
      setState((current) => ({ ...current, error: reason ?? SAVE_FAILURE_MESSAGE }));
      return;
    }
    const savedId = state.savedId;
    setState(beginSave);
    try {
      const payload = await api<unknown>(
        savedId ? `/admin/brewery/recipes/${savedId}` : "/admin/brewery/recipes",
        { method: savedId ? "PATCH" : "POST", body: JSON.stringify(body) }
      );
      const id = savedRecipeId(payload);
      if (id == null) {
        setState(failSave);
        return;
      }
      setState((current) => finishSave(current, id));
    } catch {
      setState(failSave);
    }
  }

  return (
    <div className="brew-sheet-builder">
      <div className="toolbar">
        <div className="page-title">
          <span className="eyebrow">Smokey Barrel Brewery</span>
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
        {state.phase !== "saved" && (
          <button type="button" className="primary" onClick={startNew} disabled={state.busy !== "idle"}>
            <Plus size={16}/> New Brew Recipe
          </button>
        )}
      </div>
      {state.error && (
        <div className="ai-error" role="alert">
          <CircleAlert size={18}/>
          <span>{state.error}</span>
        </div>
      )}
      {state.phase === "paste" && (
        <section className="settings-card">
          <label>
            <span>Paste brewing instructions</span>
            <textarea
              className="brew-sheet-source"
              value={state.rawText}
              maxLength={BREW_SHEET_SOURCE_MAX_CHARS}
              rows={16}
              disabled={analyzing}
              onChange={(event) => setState((current) => withRawText(current, event.target.value))}
            />
          </label>
          <p className="field-hint">{state.rawText.length.toLocaleString("en-US")} / {BREW_SHEET_SOURCE_MAX_CHARS.toLocaleString("en-US")}</p>
          <div className="brew-sheet-actions">
            <button type="button" className="primary" onClick={() => void analyze()} disabled={!canAnalyze(state)}>
              {analyzing ? <LoaderCircle className="spinner" size={16}/> : null}
              {analyzing ? "Analyzing…" : "Analyze Recipe"}
            </button>
          </div>
          {analyzing && <p className="field-hint" role="status">Reading the brewing instructions.</p>}
        </section>
      )}
      {state.phase === "saved" && (
        <section className="settings-card">
          <div className="brew-sheet-actions">
            <button type="button" className="secondary" onClick={() => setState(editSaved)}>Edit Recipe</button>
            <button type="button" className="primary" onClick={startNew}><Plus size={16}/> New Recipe</button>
          </div>
        </section>
      )}
      {state.phase === "review" && state.draft && (
        <>
          <div className="brew-sheet-actions">
            <button type="button" className="primary" onClick={() => void saveRecipe()} disabled={saving || !brewRecipeSaveBody(state)}>
              {saving ? <LoaderCircle className="spinner" size={16}/> : <Save size={16}/>}
              {saving ? "Saving…" : state.savedId ? "Save changes" : "Save Recipe"}
            </button>
          </div>
          <details className="brew-sheet-source-preview">
            <summary>Brewing instructions</summary>
            <pre>{state.rawText}</pre>
          </details>
          <BrewRecipeEditor
            draft={state.draft}
            disabled={saving}
            onChange={(draft) => setState((current) => withDraft(current, draft))}
          />
          <div className="brew-sheet-actions">
            <button type="button" className="primary" onClick={() => void saveRecipe()} disabled={saving || !brewRecipeSaveBody(state)}>
              <Save size={16}/> {saving ? "Saving…" : state.savedId ? "Save changes" : "Save Recipe"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
