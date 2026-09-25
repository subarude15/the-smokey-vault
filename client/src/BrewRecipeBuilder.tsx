import { useEffect, useState } from "react";
import { ArrowLeft, CircleAlert, LoaderCircle, Plus, Save } from "lucide-react";
import { api, ApiError } from "./api";
import { BrewRecipeEditor } from "./BrewRecipeEditor";
import { BrewSheetPreview } from "./BrewSheetPreview";
import {
  ANALYZE_EMPTY_MESSAGE,
  ANALYZE_TOO_LONG_MESSAGE,
  BREW_AGAIN_FAILURE_MESSAGE,
  BREW_AGAIN_UNSAVED_CONFIRM,
  DELETE_FAILURE_MESSAGE,
  LEAVE_RECIPE_CONFIRM,
  LOAD_FAILURE_MESSAGE,
  NEW_RECIPE_CONFIRM,
  SAVE_FAILURE_MESSAGE,
  addSession,
  beginAnalyze,
  beginSave,
  brewAgainRequest,
  brewRecipeSaveBody,
  brewSheetFingerprint,
  BREW_SHEET_SOURCE_MAX_CHARS,
  builderIsDirty,
  canAnalyze,
  deleteRecipeConfirm,
  editSaved,
  emptyBuilderState,
  failAnalyze,
  failBrew,
  failSave,
  finishAnalyze,
  finishSave,
  initialLibraryState,
  leaveNeedsConfirm,
  closePreview,
  openPreview,
  openSavedRecipe,
  publicAnalyzeError,
  recipeCardLine,
  recipeCardsFromList,
  saveBlockReason,
  savedRecipeId,
  sessionDateLabel,
  sessionFromPayload,
  showCreatedSession,
  withDraft,
  withRawText,
  type BuilderPhase,
  type BuilderState,
  type RecipeCard
} from "./brew-recipe-builder";

function heading(phase: BuilderPhase, beerName: string, brewNotice: string): { title: string; subtitle: string } {
  switch (phase) {
    case "library":
      return {
        title: "Brew Sheet Builder.",
        subtitle: "Saved recipes you can open, edit, or brew again."
      };
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
    case "preview":
      return {
        title: "Brew sheet preview.",
        subtitle: beerName
          ? `Print-style sheet for ${beerName}. Nothing is exported from this screen.`
          : "Print-style sheet for this saved recipe. Nothing is exported from this screen."
      };
    case "saved":
      if (brewNotice) {
        return {
          title: `${brewNotice}.`,
          subtitle: beerName
            ? `${beerName} stays the same recipe. This is a new numbered brew.`
            : "This is a new numbered brew of the saved recipe."
        };
      }
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
  const [state, setState] = useState<BuilderState>(initialLibraryState);
  const [cards, setCards] = useState<RecipeCard[]>([]);
  const [libraryStatus, setLibraryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [baseline, setBaseline] = useState("");
  const copy = heading(state.phase, state.draft?.beerName.trim() ?? "", state.brewNotice);
  const analyzing = state.busy === "analyzing";
  const saving = state.busy === "saving";

  async function refreshLibrary(announce: boolean) {
    if (announce) setLibraryStatus("loading");
    try {
      const payload = await api<unknown>("/admin/brewery/recipes");
      setCards(recipeCardsFromList(payload));
      setLibraryStatus("ready");
    } catch {
      if (announce) setLibraryStatus("error");
    }
  }

  useEffect(() => { void refreshLibrary(true); }, []);

  function startNew() {
    if (builderIsDirty(state) && state.phase !== "library" && !window.confirm(NEW_RECIPE_CONFIRM)) return;
    setBaseline("");
    setState(emptyBuilderState());
  }

  function backToLibrary() {
    if (leaveNeedsConfirm(state, baseline) && !window.confirm(LEAVE_RECIPE_CONFIRM)) return;
    setBaseline("");
    setState(initialLibraryState());
    void refreshLibrary(cards.length === 0);
  }

  async function openRecipe(id: number) {
    setState((current) => ({ ...current, busy: "loading", error: "" }));
    try {
      const payload = await api<unknown>(`/admin/brewery/recipes/${id}`);
      const next = openSavedRecipe(payload);
      if (!next) {
        setState((current) => ({ ...initialLibraryState(), error: LOAD_FAILURE_MESSAGE }));
        return;
      }
      setBaseline(brewSheetFingerprint(next));
      setState(next);
    } catch {
      setState((current) => ({ ...current, busy: "idle", phase: "library", error: LOAD_FAILURE_MESSAGE }));
    }
  }

  async function brewAgain(id: number) {
    if (state.savedId === id && leaveNeedsConfirm(state, baseline) && !window.confirm(BREW_AGAIN_UNSAVED_CONFIRM)) return;
    const request = brewAgainRequest(id);
    const fromLibrary = state.phase === "library" || state.savedId !== id;
    setState((current) => ({ ...current, busy: "brewing", error: "" }));
    try {
      const created = await api<unknown>(request.path, { method: request.method, body: JSON.stringify(request.body) });
      const session = sessionFromPayload(created);
      if (!session) {
        setState(failBrew);
        return;
      }
      if (fromLibrary) {
        const detail = await api<unknown>(`/admin/brewery/recipes/${id}`);
        const opened = openSavedRecipe(detail);
        if (!opened) {
          setState(failBrew);
          return;
        }
        const next = showCreatedSession(opened, session);
        setBaseline(brewSheetFingerprint(next));
        setState(next);
      } else {
        setState((current) => addSession(current, session));
      }
      void refreshLibrary(false);
    } catch {
      setState(failBrew);
    }
  }

  async function removeRecipe() {
    if (state.savedId == null) return;
    if (!window.confirm(deleteRecipeConfirm(state.draft?.beerName ?? ""))) return;
    const id = state.savedId;
    setState((current) => ({ ...current, busy: "deleting", error: "" }));
    try {
      await api(`/admin/brewery/recipes/${id}`, { method: "DELETE" });
      setBaseline("");
      setState(initialLibraryState());
      await refreshLibrary(true);
    } catch {
      setState((current) => ({ ...current, busy: "idle", error: DELETE_FAILURE_MESSAGE }));
    }
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
      setBaseline(brewSheetFingerprint({ rawText: state.rawText, draft: state.draft, savedId: id }));
      setState((current) => finishSave(current, id));
      void refreshLibrary(false);
    } catch {
      setState(failSave);
    }
  }

  const alert = state.phase === "library" && libraryStatus === "error" && !state.error
    ? LOAD_FAILURE_MESSAGE
    : state.error;

  return (
    <div className={state.phase === "preview" ? "brew-sheet-builder is-preview" : "brew-sheet-builder"}>
      {state.phase !== "library" && state.phase !== "preview" && (
        <button type="button" className="secondary back-button" onClick={backToLibrary} disabled={state.busy !== "idle"}>
          <ArrowLeft size={16}/> Back to Recipes
        </button>
      )}
      {state.phase !== "preview" && <div className="toolbar">
        <div className="page-title">
          <span className="eyebrow">Smokey Barrel Brewery</span>
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
        {state.phase === "library" && (
          <button type="button" className="primary" onClick={startNew}>
            <Plus size={16}/> New Brew Recipe
          </button>
        )}
        {state.phase === "paste" && (
          <button type="button" className="primary" onClick={startNew} disabled={state.busy !== "idle"}>
            <Plus size={16}/> New Brew Recipe
          </button>
        )}
      </div>}
      {alert && (
        <div className="ai-error" role="alert">
          <CircleAlert size={18}/>
          <span>{alert}</span>
          {state.phase === "library" && libraryStatus === "error" && (
            <button type="button" className="secondary" onClick={() => void refreshLibrary(true)}>Retry</button>
          )}
        </div>
      )}
      {state.phase === "library" && (
        <Library
          cards={cards}
          status={libraryStatus}
          busy={state.busy === "brewing" || state.busy === "loading"}
          onCreate={startNew}
          onOpen={(id) => void openRecipe(id)}
          onBrewAgain={(id) => void brewAgain(id)}
        />
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
            <button type="button" className="secondary" onClick={() => setState(openPreview)}>Preview Brew Sheet</button>
            <button type="button" className="primary" onClick={() => { if (state.savedId != null) void brewAgain(state.savedId); }} disabled={state.busy !== "idle" || state.savedId == null}>
              {state.busy === "brewing" ? <LoaderCircle className="spinner" size={16}/> : null}
              {state.busy === "brewing" ? "Starting brew…" : "Brew Again"}
            </button>
            <button type="button" className="secondary brew-sheet-delete" onClick={() => void removeRecipe()} disabled={state.busy !== "idle"}>
              Delete Recipe
            </button>
          </div>
        </section>
      )}
      {state.phase === "preview" && state.draft && (
        <BrewSheetPreview recipe={state.draft} onBack={() => setState(closePreview)}/>
      )}
      {state.savedId != null && (state.phase === "review" || state.phase === "saved") && (
        <BrewHistory sessions={state.sessions} notice={state.phase === "review" ? state.brewNotice : ""}/>
      )}
      {state.phase === "review" && state.draft && (
        <>
          <div className="brew-sheet-actions">
            <button type="button" className="primary" onClick={() => void saveRecipe()} disabled={saving || !brewRecipeSaveBody(state)}>
              {saving ? <LoaderCircle className="spinner" size={16}/> : <Save size={16}/>}
              {saving ? "Saving…" : state.savedId ? "Save changes" : "Save Recipe"}
            </button>
            {state.savedId != null && (
              <button type="button" className="secondary" onClick={() => setState(openPreview)}>Preview Brew Sheet</button>
            )}
            {state.savedId != null && (
              <button type="button" className="secondary" onClick={() => { if (state.savedId != null) void brewAgain(state.savedId); }} disabled={state.busy !== "idle"}>
                Brew Again
              </button>
            )}
          </div>
          <details className="brew-sheet-source-preview">
            <summary>Brewing instructions</summary>
            <pre>{state.rawText}</pre>
          </details>
          <BrewRecipeEditor
            draft={state.draft}
            disabled={state.busy !== "idle"}
            onChange={(draft) => setState((current) => withDraft(current, draft))}
          />
          <div className="brew-sheet-actions">
            <button type="button" className="primary" onClick={() => void saveRecipe()} disabled={saving || !brewRecipeSaveBody(state)}>
              <Save size={16}/> {saving ? "Saving…" : state.savedId ? "Save changes" : "Save Recipe"}
            </button>
            {state.savedId != null && (
              <button type="button" className="secondary brew-sheet-delete" onClick={() => void removeRecipe()} disabled={state.busy !== "idle"}>
                Delete Recipe
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Library({
  cards,
  status,
  busy,
  onCreate,
  onOpen,
  onBrewAgain
}: {
  cards: RecipeCard[];
  status: "loading" | "ready" | "error";
  busy: boolean;
  onCreate: () => void;
  onOpen: (id: number) => void;
  onBrewAgain: (id: number) => void;
}) {
  if (status === "loading") return <p className="field-hint" role="status">Loading recipes.</p>;
  if (status === "error") return null;
  if (!cards.length) {
    return (
      <section className="settings-card">
        <h2>No brew recipes yet.</h2>
        <p>Paste a recipe and let Smokey Vault turn it into a reusable brew sheet.</p>
        <button type="button" className="primary" onClick={onCreate}><Plus size={16}/> Create First Recipe</button>
      </section>
    );
  }
  return (
    <div className="brew-sheet-list">
      <span className="eyebrow">Saved recipes</span>
      {cards.map((card) => {
        const line = recipeCardLine(card);
        return (
          <article className="settings-card brew-sheet-card" key={card.id}>
            <h2>{card.name}</h2>
            {card.style ? <p>{card.style}</p> : null}
            {line ? <p className="brew-sheet-meta">{line}</p> : null}
            {card.updatedLabel ? <p className="field-hint">{card.updatedLabel}</p> : null}
            <div className="brew-sheet-actions">
              <button type="button" className="secondary" onClick={() => onOpen(card.id)} disabled={busy}>Open</button>
              <button type="button" className="primary" onClick={() => onBrewAgain(card.id)} disabled={busy}>Brew Again</button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function BrewHistory({ sessions, notice }: { sessions: BuilderState["sessions"]; notice: string }) {
  return (
    <section className="settings-card">
      <span className="eyebrow">Brew history</span>
      {notice ? <p role="status">{notice}</p> : null}
      {!sessions.length ? <p className="field-hint">No brews yet. Brew Again starts Brew #1.</p> : (
        <div className="brew-sheet-sessions">
          {sessions.map((session) => {
            const date = sessionDateLabel(session);
            return (
              <div className="brew-sheet-session" key={session.id}>
                <strong>Brew #{session.brewNumber}</strong>
                {date ? <span>{date}</span> : null}
                <span>{session.status}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
