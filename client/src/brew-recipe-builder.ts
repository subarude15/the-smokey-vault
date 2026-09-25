/**
 * Keeper brew-sheet builder state. Pure so the paste → analyze → review → save
 * flow can be tested without a browser. The UI in BrewRecipeBuilder.tsx applies it.
 */
import { BREW_SHEET_PAGE_ID } from "./brew-sheet-page";

export { BREW_SHEET_PAGE_ID };

/** Matches src/brew_recipe_parser.ts BREW_RECIPE_PARSE_MAX_CHARS. */
export const BREW_SHEET_SOURCE_MAX_CHARS = 100_000;

export const ANALYZE_EMPTY_MESSAGE = "Paste some brewing instructions first.";
export const ANALYZE_TOO_LONG_MESSAGE = "Those instructions are too long to analyze.";
export const ANALYZE_FAILURE_MESSAGE = "We couldn’t turn those brewing instructions into a recipe. Your original text is still here so you can adjust it and try again.";
export const SAVE_FAILURE_MESSAGE = "Couldn’t save this brew recipe.";
export const SAVE_NAME_MESSAGE = "A beer name is required before this recipe can be saved.";
export const NEW_RECIPE_CONFIRM = "Start a new brew recipe? This screen will be cleared. A recipe you already saved stays saved.";

export type BuilderPhase = "paste" | "review" | "saved";
export type BrewRecord = Record<string, unknown>;
export type BrewRowList = "fermentables" | "kettleAdditions" | "whirlpoolAdditions" | "dryHopStages";
export type BrewStringList = "warnings" | "checklist";
export type BrewScalarField =
  | "beerName"
  | "style"
  | "system"
  | "fermenter"
  | "targetPackaged"
  | "fermenterVolume"
  | "boilTime"
  | "targetOg"
  | "targetFg"
  | "targetAbv"
  | "estimatedIbu"
  | "mashEfficiency"
  | "notes";

export type BrewRecipeDraft = {
  beerName: string;
  style: string;
  system: string;
  fermenter: string;
  targetPackaged: string;
  fermenterVolume: string;
  boilTime: string;
  targetOg: string;
  targetFg: string;
  targetAbv: string;
  estimatedIbu: string;
  mashEfficiency: string;
  water: BrewRecord;
  fermentables: BrewRecord[];
  kettleAdditions: BrewRecord[];
  whirlpoolAdditions: BrewRecord[];
  dryHopStages: BrewRecord[];
  fermentation: BrewRecord;
  packaging: BrewRecord;
  warnings: string[];
  checklist: string[];
  notes: string;
};

export type BrewRecipeSaveBody = {
  name: string;
  style: string;
  sourceText: string;
  recipe: BrewRecipeDraft;
};

export type BuilderState = {
  phase: BuilderPhase;
  rawText: string;
  draft: BrewRecipeDraft | null;
  savedId: number | null;
  busy: "idle" | "analyzing" | "saving";
  error: string;
};

export const BLANK_FERMENTABLE: BrewRecord = { ingredient: "", amount: "" };
export const BLANK_KETTLE: BrewRecord = { ingredient: "", amount: "", time: "" };
export const BLANK_WHIRLPOOL: BrewRecord = { ingredient: "", amount: "", temperature: "", time: "" };
export const BLANK_DRY_HOP: BrewRecord = { stage: "", variety: "", amount: "", when: "", temperature: "", gravity: "" };
export const BLANK_FERMENTATION_STEP: BrewRecord = { when: "", temperature: "", gravity: "", action: "" };

export function emptyBuilderState(): BuilderState {
  return { phase: "paste", rawText: "", draft: null, savedId: null, busy: "idle", error: "" };
}

export function fieldText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asRecord(value: unknown): BrewRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as BrewRecord) };
}

function asRows(value: unknown): BrewRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => asRecord(row));
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function draftFromParsed(value: unknown): BrewRecipeDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as BrewRecord;
  const beerName = asString(row.beerName).trim();
  if (!beerName) return null;
  return {
    beerName,
    style: asString(row.style),
    system: asString(row.system),
    fermenter: asString(row.fermenter),
    targetPackaged: asString(row.targetPackaged),
    fermenterVolume: asString(row.fermenterVolume),
    boilTime: asString(row.boilTime),
    targetOg: asString(row.targetOg),
    targetFg: asString(row.targetFg),
    targetAbv: asString(row.targetAbv),
    estimatedIbu: asString(row.estimatedIbu),
    mashEfficiency: asString(row.mashEfficiency),
    water: asRecord(row.water),
    fermentables: asRows(row.fermentables),
    kettleAdditions: asRows(row.kettleAdditions),
    whirlpoolAdditions: asRows(row.whirlpoolAdditions),
    dryHopStages: asRows(row.dryHopStages),
    fermentation: asRecord(row.fermentation),
    packaging: asRecord(row.packaging),
    warnings: asStrings(row.warnings),
    checklist: asStrings(row.checklist),
    notes: asString(row.notes)
  };
}

export function canAnalyze(state: BuilderState): boolean {
  return state.busy === "idle"
    && state.rawText.trim().length > 0
    && state.rawText.length <= BREW_SHEET_SOURCE_MAX_CHARS;
}

export function withRawText(state: BuilderState, rawText: string): BuilderState {
  return { ...state, rawText, error: "" };
}

export function beginAnalyze(state: BuilderState): BuilderState {
  return { ...state, busy: "analyzing", error: "" };
}

export function finishAnalyze(state: BuilderState, recipe: unknown): BuilderState {
  const draft = draftFromParsed(recipe);
  if (!draft) return { ...state, busy: "idle", error: ANALYZE_FAILURE_MESSAGE };
  return { ...state, busy: "idle", error: "", phase: "review", draft, savedId: null };
}

export function failAnalyze(state: BuilderState): BuilderState {
  return { ...state, busy: "idle", error: ANALYZE_FAILURE_MESSAGE };
}

/** Maps a failed parse to keeper-facing copy. Never returns the server string. */
export function publicAnalyzeError(status: number, serverMessage: string): string {
  if (status === 400 && /too long/i.test(serverMessage)) return ANALYZE_TOO_LONG_MESSAGE;
  if (status === 400 && /required/i.test(serverMessage)) return ANALYZE_EMPTY_MESSAGE;
  return ANALYZE_FAILURE_MESSAGE;
}

export function setScalar(draft: BrewRecipeDraft, field: BrewScalarField, value: string): BrewRecipeDraft {
  return { ...draft, [field]: value };
}

export function setWaterField(draft: BrewRecipeDraft, key: string, value: string): BrewRecipeDraft {
  return { ...draft, water: { ...draft.water, [key]: value } };
}

export function updateRow(draft: BrewRecipeDraft, list: BrewRowList, index: number, patch: BrewRecord): BrewRecipeDraft {
  const rows = draft[list].map((row, i) => (i === index ? { ...row, ...patch } : row));
  return { ...draft, [list]: rows };
}

export function addRow(draft: BrewRecipeDraft, list: BrewRowList, row: BrewRecord): BrewRecipeDraft {
  return { ...draft, [list]: [...draft[list], { ...row }] };
}

export function removeRow(draft: BrewRecipeDraft, list: BrewRowList, index: number): BrewRecipeDraft {
  return { ...draft, [list]: draft[list].filter((_, i) => i !== index) };
}

export function setYeast(draft: BrewRecipeDraft, yeast: string): BrewRecipeDraft {
  return { ...draft, fermentation: { ...draft.fermentation, yeast } };
}

export function fermentationSteps(fermentation: BrewRecord): unknown[] {
  return Array.isArray(fermentation.steps) ? fermentation.steps : [];
}

export function patchFermentationStep(draft: BrewRecipeDraft, index: number, patch: BrewRecord): BrewRecipeDraft {
  const steps = fermentationSteps(draft.fermentation).map((step, i) => (
    i === index ? { ...asRecord(step), ...patch } : step
  ));
  return { ...draft, fermentation: { ...draft.fermentation, steps } };
}

export function addFermentationStep(draft: BrewRecipeDraft): BrewRecipeDraft {
  return {
    ...draft,
    fermentation: {
      ...draft.fermentation,
      steps: [...fermentationSteps(draft.fermentation), { ...BLANK_FERMENTATION_STEP }]
    }
  };
}

export function removeFermentationStep(draft: BrewRecipeDraft, index: number): BrewRecipeDraft {
  return {
    ...draft,
    fermentation: {
      ...draft.fermentation,
      steps: fermentationSteps(draft.fermentation).filter((_, i) => i !== index)
    }
  };
}

export function packagingSteps(packaging: BrewRecord): unknown[] {
  return Array.isArray(packaging.steps) ? packaging.steps : [];
}

export function setPackagingStep(draft: BrewRecipeDraft, index: number, value: string): BrewRecipeDraft {
  const steps = packagingSteps(draft.packaging).map((step, i) => (i === index ? value : step));
  return { ...draft, packaging: { ...draft.packaging, steps } };
}

export function addPackagingStep(draft: BrewRecipeDraft): BrewRecipeDraft {
  return { ...draft, packaging: { ...draft.packaging, steps: [...packagingSteps(draft.packaging), ""] } };
}

export function removePackagingStep(draft: BrewRecipeDraft, index: number): BrewRecipeDraft {
  return {
    ...draft,
    packaging: { ...draft.packaging, steps: packagingSteps(draft.packaging).filter((_, i) => i !== index) }
  };
}

export function updateStringItem(draft: BrewRecipeDraft, list: BrewStringList, index: number, value: string): BrewRecipeDraft {
  return { ...draft, [list]: draft[list].map((item, i) => (i === index ? value : item)) };
}

export function addStringItem(draft: BrewRecipeDraft, list: BrewStringList): BrewRecipeDraft {
  return { ...draft, [list]: [...draft[list], ""] };
}

export function removeStringItem(draft: BrewRecipeDraft, list: BrewStringList, index: number): BrewRecipeDraft {
  return { ...draft, [list]: draft[list].filter((_, i) => i !== index) };
}

export function withDraft(state: BuilderState, draft: BrewRecipeDraft): BuilderState {
  return { ...state, draft };
}

export function saveBlockReason(state: BuilderState): string | null {
  if (state.busy !== "idle") return null;
  if (!state.draft) return SAVE_NAME_MESSAGE;
  if (!state.draft.beerName.trim()) return SAVE_NAME_MESSAGE;
  return null;
}

export function brewRecipeSaveBody(state: BuilderState): BrewRecipeSaveBody | null {
  if (!state.draft) return null;
  const name = state.draft.beerName.trim();
  if (!name || name.length > 200) return null;
  const style = state.draft.style.trim();
  if (style.length > 120) return null;
  if (state.rawText.length > BREW_SHEET_SOURCE_MAX_CHARS) return null;
  return { name, style, sourceText: state.rawText, recipe: state.draft };
}

export function beginSave(state: BuilderState): BuilderState {
  return { ...state, busy: "saving", error: "" };
}

export function finishSave(state: BuilderState, id: number): BuilderState {
  return { ...state, busy: "idle", error: "", phase: "saved", savedId: id };
}

export function failSave(state: BuilderState): BuilderState {
  return { ...state, busy: "idle", error: SAVE_FAILURE_MESSAGE };
}

export function savedRecipeId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const id = (payload as { recipe?: { id?: unknown } }).recipe?.id;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

export function editSaved(state: BuilderState): BuilderState {
  if (!state.draft) return state;
  return { ...state, phase: "review", error: "" };
}

export function builderIsDirty(state: BuilderState): boolean {
  return state.rawText.trim().length > 0 || state.draft != null;
}

export function publicSaveError(): string {
  return SAVE_FAILURE_MESSAGE;
}
