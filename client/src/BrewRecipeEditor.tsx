import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import {
  addFermentationStep,
  addPackagingStep,
  addRow,
  addStringItem,
  BLANK_DRY_HOP,
  BLANK_FERMENTABLE,
  BLANK_KETTLE,
  BLANK_WHIRLPOOL,
  fermentationSteps,
  fieldText,
  packagingSteps,
  patchFermentationStep,
  removeFermentationStep,
  removePackagingStep,
  removeRow,
  removeStringItem,
  setPackagingStep,
  setScalar,
  setWaterField,
  setYeast,
  updateRow,
  updateStringItem,
  type BrewRecipeDraft,
  type BrewRecord,
  type BrewRowList,
  type BrewScalarField,
  type BrewStringList
} from "./brew-recipe-builder";
import { waterChemistryView } from "./brew-water-chemistry-view";

const BASIC: { key: BrewScalarField; label: string }[] = [
  { key: "beerName", label: "Beer name" },
  { key: "style", label: "Style" },
  { key: "system", label: "System" },
  { key: "fermenter", label: "Fermenter" },
  { key: "targetPackaged", label: "Target packaged volume" },
  { key: "fermenterVolume", label: "Fermenter volume" },
  { key: "boilTime", label: "Boil time" }
];

const TARGETS: { key: BrewScalarField; label: string }[] = [
  { key: "targetOg", label: "Target OG" },
  { key: "targetFg", label: "Target FG" },
  { key: "targetAbv", label: "Target ABV" },
  { key: "estimatedIbu", label: "Estimated IBU" },
  { key: "mashEfficiency", label: "Mash efficiency" }
];

const WATER: { key: string; label: string }[] = [
  { key: "source", label: "Source" },
  { key: "strikeWater", label: "Strike water" },
  { key: "spargeWater", label: "Sparge water" },
  { key: "totalWater", label: "Total water" },
  { key: "targetMashPh", label: "Target mash pH" },
  { key: "chloridePpm", label: "Chloride ppm" },
  { key: "sulfatePpm", label: "Sulfate ppm" },
  { key: "calciumPpm", label: "Calcium ppm" },
  { key: "sodiumPpm", label: "Sodium ppm" },
  { key: "magnesiumPpm", label: "Magnesium ppm" },
  { key: "notes", label: "Notes" }
];

const ROWS: { list: BrewRowList; title: string; add: string; blank: BrewRecord; fields: { key: string; label: string }[] }[] = [
  {
    list: "fermentables",
    title: "Fermentables",
    add: "Add fermentable",
    blank: BLANK_FERMENTABLE,
    fields: [
      { key: "ingredient", label: "Ingredient" },
      { key: "amount", label: "Amount" },
      { key: "lovibond", label: "Lovibond / color" }
    ]
  },
  {
    list: "kettleAdditions",
    title: "Kettle additions",
    add: "Add kettle addition",
    blank: BLANK_KETTLE,
    fields: [
      { key: "ingredient", label: "Ingredient" },
      { key: "amount", label: "Amount" },
      { key: "time", label: "Time" }
    ]
  },
  {
    list: "whirlpoolAdditions",
    title: "Whirlpool additions",
    add: "Add whirlpool addition",
    blank: BLANK_WHIRLPOOL,
    fields: [
      { key: "ingredient", label: "Ingredient" },
      { key: "amount", label: "Amount" },
      { key: "temperature", label: "Temperature" },
      { key: "time", label: "Time" }
    ]
  },
  {
    list: "dryHopStages",
    title: "Dry hop stages",
    add: "Add dry hop",
    blank: BLANK_DRY_HOP,
    fields: [
      { key: "stage", label: "Stage" },
      { key: "variety", label: "Variety" },
      { key: "amount", label: "Amount" },
      { key: "when", label: "When" },
      { key: "temperature", label: "Temperature" },
      { key: "gravity", label: "Gravity" }
    ]
  }
];

const STEP_FIELDS = [
  { key: "when", label: "When" },
  { key: "temperature", label: "Temperature" },
  { key: "gravity", label: "Gravity" },
  { key: "action", label: "Action" }
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-card brew-sheet-section">
      <span className="eyebrow">{title}</span>
      {children}
    </section>
  );
}

function TextInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} autoComplete="off"/>
    </label>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="secondary brew-sheet-remove" onClick={onClick}>{label}</button>;
}

function WaterChemistryPanel({ chemistry }: { chemistry: ReturnType<typeof waterChemistryView> }) {
  return (
    <div className="brew-water-calc" aria-live="polite">
      <p className="brew-water-calc-title">Calculated water treatment</p>
      <div className="brew-water-calc-grid">
        <div>
          <span className="brew-water-calc-label">Source water</span>
          <p>{chemistry.source}</p>
        </div>
        <div>
          <span className="brew-water-calc-label">Water volumes</span>
          {chemistry.volumes.length ? chemistry.volumes.map((row) => (
            <p key={row.label}>{row.label}: {row.value}</p>
          )) : <p className="field-hint">Add strike and sparge volumes to calculate salts.</p>}
        </div>
      </div>
      <div>
        <span className="brew-water-calc-label">Target mineral profile</span>
        {chemistry.targets.length ? chemistry.targets.map((row) => (
          <p key={row.label}>{row.label}: {row.value}</p>
        )) : <p className="field-hint">No mineral targets were supplied by this recipe.</p>}
      </div>
      {chemistry.totalSalts.length > 0 ? (
        <div className="brew-water-calc-grid">
          {chemistry.canSplit ? (
            <>
              <div>
                <span className="brew-water-calc-label">Mash salt additions</span>
                {chemistry.mashSalts.map((row) => <p key={`mash-${row.label}`}>{row.label} — {row.value}</p>)}
              </div>
              <div>
                <span className="brew-water-calc-label">Sparge salt additions</span>
                {chemistry.spargeSalts.map((row) => <p key={`sparge-${row.label}`}>{row.label} — {row.value}</p>)}
              </div>
            </>
          ) : (
            <div>
              <span className="brew-water-calc-label">Calculated salt additions</span>
              {chemistry.totalSalts.map((row) => <p key={`total-${row.label}`}>{row.label} — {row.value}</p>)}
            </div>
          )}
          <div>
            <span className="brew-water-calc-label">Achieved profile</span>
            {chemistry.achieved.map((row) => <p key={`ach-${row.label}`}>{row.label}: {row.value}</p>)}
          </div>
        </div>
      ) : null}
      {chemistry.mineralStatus && <p className="field-hint">{chemistry.mineralStatus}</p>}
      <div>
        <span className="brew-water-calc-label">Mash pH</span>
        <p>Target mash pH: {chemistry.mashPhTarget}</p>
        <p>88% Lactic Acid — {chemistry.lactic}</p>
        <p className="field-hint">{chemistry.mashPhNote}</p>
        <p>{chemistry.measuredLine}</p>
      </div>
    </div>
  );
}

export function BrewRecipeEditor({
  draft,
  disabled,
  onChange
}: {
  draft: BrewRecipeDraft;
  disabled: boolean;
  onChange: (draft: BrewRecipeDraft) => void;
}) {
  const chemistry = waterChemistryView(draft);
  return (
    <fieldset className="brew-sheet-editor" disabled={disabled}>
      <Section title="Basic info">
        <div className="form-grid">
          {BASIC.map((field) => (
            <TextInput
              key={field.key}
              label={field.label}
              value={draft[field.key]}
              onChange={(value) => onChange(setScalar(draft, field.key, value))}
            />
          ))}
        </div>
      </Section>
      <Section title="Targets">
        <div className="form-grid">
          {TARGETS.map((field) => (
            <TextInput
              key={field.key}
              label={field.label}
              value={draft[field.key]}
              onChange={(value) => onChange(setScalar(draft, field.key, value))}
            />
          ))}
        </div>
      </Section>
      <Section title="Water">
        <div className="form-grid">
          {WATER.map((field) => (
            <TextInput
              key={field.key}
              label={field.label}
              value={fieldText(draft.water[field.key])}
              onChange={(value) => onChange(setWaterField(draft, field.key, value))}
            />
          ))}
        </div>
        <WaterChemistryPanel chemistry={chemistry}/>
      </Section>
      {ROWS.map((section) => (
        <Section key={section.list} title={section.title}>
          {draft[section.list].map((row, index) => (
            <div className="brew-sheet-row" key={`${section.list}-${index}`}>
              {section.fields.map((field) => (
                <TextInput
                  key={field.key}
                  label={field.label}
                  value={fieldText(row[field.key])}
                  onChange={(value) => onChange(updateRow(draft, section.list, index, { [field.key]: value }))}
                />
              ))}
              <RemoveButton label="Remove" onClick={() => onChange(removeRow(draft, section.list, index))}/>
            </div>
          ))}
          <button type="button" className="secondary" onClick={() => onChange(addRow(draft, section.list, section.blank))}>
            <Plus size={16}/> {section.add}
          </button>
        </Section>
      ))}
      <Section title="Fermentation">
        <div className="form-grid">
          <TextInput label="Yeast" value={fieldText(draft.fermentation.yeast)} onChange={(value) => onChange(setYeast(draft, value))}/>
        </div>
        {fermentationSteps(draft.fermentation).map((step, index) => {
          const row = step && typeof step === "object" && !Array.isArray(step) ? step as BrewRecord : null;
          return (
            <div className="brew-sheet-row" key={`ferment-${index}`}>
              {row ? STEP_FIELDS.map((field) => (
                <TextInput
                  key={field.key}
                  label={field.label}
                  value={fieldText(row[field.key])}
                  onChange={(value) => onChange(patchFermentationStep(draft, index, { [field.key]: value }))}
                />
              )) : <p className="field-hint">This fermentation detail stays with the recipe.</p>}
              <RemoveButton label="Remove" onClick={() => onChange(removeFermentationStep(draft, index))}/>
            </div>
          );
        })}
        <button type="button" className="secondary" onClick={() => onChange(addFermentationStep(draft))}>
          <Plus size={16}/> Add fermentation step
        </button>
      </Section>
      <Section title="Packaging">
        {packagingSteps(draft.packaging).map((step, index) => (
          <div className="brew-sheet-row" key={`pack-${index}`}>
            {typeof step === "string" ? (
              <TextInput label="Step" value={step} onChange={(value) => onChange(setPackagingStep(draft, index, value))}/>
            ) : (
              <p className="field-hint">This packaging detail stays with the recipe.</p>
            )}
            <RemoveButton label="Remove" onClick={() => onChange(removePackagingStep(draft, index))}/>
          </div>
        ))}
        <button type="button" className="secondary" onClick={() => onChange(addPackagingStep(draft))}>
          <Plus size={16}/> Add packaging step
        </button>
      </Section>
      <StringSection title="Warnings" list="warnings" draft={draft} addLabel="Add warning" onChange={onChange}/>
      <StringSection title="Checklist" list="checklist" draft={draft} addLabel="Add checklist item" onChange={onChange}/>
      <Section title="Notes">
        <label>
          <span>Notes</span>
          <textarea rows={5} value={draft.notes} onChange={(event) => onChange(setScalar(draft, "notes", event.target.value))}/>
        </label>
      </Section>
    </fieldset>
  );
}

function StringSection({
  title,
  list,
  draft,
  addLabel,
  onChange
}: {
  title: string;
  list: BrewStringList;
  draft: BrewRecipeDraft;
  addLabel: string;
  onChange: (draft: BrewRecipeDraft) => void;
}) {
  return (
    <Section title={title}>
      {draft[list].map((item, index) => (
        <div className="brew-sheet-row" key={`${list}-${index}`}>
          <TextInput label={title} value={item} onChange={(value) => onChange(updateStringItem(draft, list, index, value))}/>
          <RemoveButton label="Remove" onClick={() => onChange(removeStringItem(draft, list, index))}/>
        </div>
      ))}
      <button type="button" className="secondary" onClick={() => onChange(addStringItem(draft, list))}>
        <Plus size={16}/> {addLabel}
      </button>
    </Section>
  );
}
