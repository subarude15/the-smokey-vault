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
  error: string;
  saved: MixologistSaved;
};

type MixologistAction =
  | { type: "edit"; text: string }
  | { type: "generate-start" }
  | { type: "retry-start" }
  | { type: "success"; recipe: MixologistRecipe; prompt: string }
  | { type: "failure"; error: string }
  | { type: "saved"; saved: MixologistSaved }
  | { type: "idle" };

export function emptyMixologistView(): MixologistView {
  return { textarea: "", askedPrompt: "", loading: false, retrying: false, error: "", saved: "" };
}

export function reduceMixologist(state: MixologistView, action: MixologistAction): MixologistView {
  switch (action.type) {
    case "edit":
      return { ...state, textarea: action.text };
    case "generate-start":
      return { ...state, loading: true, retrying: false, error: "", recipe: undefined, saved: "" };
    case "retry-start":
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
    case "saved":
      return { ...state, saved: action.saved, error: "" };
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
  return view.loading;
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
