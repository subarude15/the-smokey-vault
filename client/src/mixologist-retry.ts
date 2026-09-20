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
  refinementText: string;
  recipe?: MixologistRecipe;
  loading: boolean;
  retrying: boolean;
  refining: boolean;
  saving: boolean;
  error: string;
  saved: MixologistSaved;
};

type MixologistAction =
  | { type: "edit"; text: string }
  | { type: "edit-refinement"; text: string }
  | { type: "generate-start" }
  | { type: "retry-start" }
  | { type: "refine-start" }
  | { type: "success"; recipe: MixologistRecipe; prompt: string }
  | { type: "failure"; error: string }
  | { type: "save-start" }
  | { type: "save-success"; saved: MixologistSaved }
  | { type: "save-failure"; error: string }
  | { type: "idle" };

export const MIXOLOGIST_REFINEMENTS = [
  ["Less sweet", "Make it less sweet."],
  ["Stronger", "Make it stronger."],
  ["More refreshing", "Make it more refreshing."],
  ["Different spirit", "Use a different base spirit."],
  ["Surprise me", "Surprise me with a twist on this drink."]
] as const;

export function emptyMixologistView(): MixologistView {
  return {
    textarea: "",
    askedPrompt: "",
    refinementText: "",
    loading: false,
    retrying: false,
    refining: false,
    saving: false,
    error: "",
    saved: ""
  };
}

export function reduceMixologist(state: MixologistView, action: MixologistAction): MixologistView {
  switch (action.type) {
    case "edit":
      return { ...state, textarea: action.text };
    case "edit-refinement":
      return { ...state, refinementText: action.text };
    case "generate-start":
      if (state.saving || state.loading) return state;
      return { ...state, loading: true, retrying: false, refining: false, error: "", recipe: undefined, saved: "", refinementText: "" };
    case "retry-start":
      if (state.saving || state.loading) return state;
      return { ...state, loading: true, retrying: true, refining: false, error: "" };
    case "refine-start":
      if (state.saving || state.loading) return state;
      return { ...state, loading: true, refining: true, retrying: false, error: "" };
    case "success":
      return {
        ...state,
        loading: false,
        retrying: false,
        refining: false,
        error: "",
        recipe: action.recipe,
        askedPrompt: action.prompt,
        saved: "",
        refinementText: ""
      };
    case "failure":
      return { ...state, loading: false, retrying: false, refining: false, error: action.error };
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
      return { ...state, loading: false, retrying: false, refining: false };
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
    previous_recipe: recipeFields(previous)
  };
}

export function mixologistRefineBody(askedPrompt: string, previous: MixologistRecipe, refinement: string) {
  return {
    prompt: askedPrompt,
    mode: "refine" as const,
    previous_recipe: recipeFields(previous),
    refinement
  };
}

function recipeFields(previous: MixologistRecipe) {
  return {
    name: previous.name,
    ingredients: previous.ingredients,
    method: previous.method,
    glassware: previous.glassware,
    garnish: previous.garnish,
    season: previous.season,
    notes: previous.notes
  };
}
