export type MixologistRecipe = {
  name: string;
  ingredients: string[];
  method: string;
  glassware: string;
  garnish: string;
  season: string;
  notes: string;
};

export type MixologistSaved = "" | "keeper" | "guest";

export type MixologistView = {
  textarea: string;
  askedPrompt: string;
  recipe?: MixologistRecipe;
  loading: boolean;
  retrying: boolean;
  saving: boolean;
  error: string;
  saved: MixologistSaved;
};

type MixologistAction =
  | { type: "edit"; text: string }
  | { type: "generate-start" }
  | { type: "retry-start" }
  | { type: "success"; recipe: MixologistRecipe; prompt: string }
  | { type: "failure"; error: string }
  | { type: "save-start" }
  | { type: "save-success"; saved: MixologistSaved }
  | { type: "save-failure"; error: string }
  | { type: "idle" };

export function emptyMixologistView(): MixologistView {
  return { textarea: "", askedPrompt: "", loading: false, retrying: false, saving: false, error: "", saved: "" };
}

export function reduceMixologist(state: MixologistView, action: MixologistAction): MixologistView {
  switch (action.type) {
    case "edit":
      return { ...state, textarea: action.text };
    case "generate-start":
      if (state.saving) return state;
      return { ...state, loading: true, retrying: false, error: "", recipe: undefined, saved: "" };
    case "retry-start":
      if (state.saving) return state;
      return { ...state, loading: true, retrying: true, error: "" };
    case "success":
      return {
        ...state,
        loading: false,
        retrying: false,
        error: "",
        recipe: action.recipe,
        askedPrompt: action.prompt,
        saved: ""
      };
    case "failure":
      return { ...state, loading: false, retrying: false, error: action.error };
    case "save-start":
      if (state.loading || state.saving) return state;
      return { ...state, saving: true, error: "" };
    case "save-success":
      if (!state.saving) return state;
      return { ...state, saving: false, saved: action.saved, error: "" };
    case "save-failure":
      if (!state.saving) return state;
      return { ...state, saving: false, error: action.error };
    case "idle":
      return { ...state, loading: false, retrying: false };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

export function tryAnotherVisible(view: MixologistView): boolean {
  return view.recipe != null;
}

export function mixologistActionsLocked(view: MixologistView): boolean {
  return view.loading || view.saving;
}

export function mixologistGenerateBody(prompt: string) {
  return { prompt };
}

export function mixologistRetryBody(askedPrompt: string, previous: MixologistRecipe) {
  return {
    prompt: askedPrompt,
    mode: "retry" as const,
    previous_recipe: {
      name: previous.name,
      ingredients: previous.ingredients,
      method: previous.method,
      glassware: previous.glassware,
      garnish: previous.garnish,
      season: previous.season,
      notes: previous.notes
    }
  };
}
