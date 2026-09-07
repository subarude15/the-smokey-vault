import { useEffect, useState } from "react";
import { ArrowLeft, Beer, FlaskConical, Hop, Thermometer } from "lucide-react";
import { api, type Item } from "./api";
import { ImageField } from "./ImageField";
import { TastingProfileView } from "./BottlePublicContent";
import {
  BREW_FLAVOR_OPTIONS,
  brewGuestStatusLabel,
  brewPresentationName,
  formatGravity,
  normalizeBrewStatus,
  onTapLabel,
  parseList,
  parseTagInput,
  serializeList
} from "./catalog";

function abvText(brew: Item): string {
  const abv = Number(brew.calculated_abv ?? brew.abv ?? 0);
  return abv > 0 ? `${abv.toFixed(1)}% ABV` : "";
}

function gravityText(brew: Item): string {
  const og = formatGravity(brew.measured_og ?? brew.target_og);
  const fg = formatGravity(brew.measured_fg ?? brew.target_fg);
  if (og && fg) return `OG ${og} → FG ${fg}`;
  if (og) return `OG ${og}`;
  if (fg) return `FG ${fg}`;
  return "";
}

function listField(value: unknown): string[] {
  return parseList(value);
}

export function BreweryLabDetail({
  brew,
  tapNumbers,
  admin,
  onClose,
  onSaved
}: {
  brew: Item;
  tapNumbers: number[];
  admin: boolean;
  onClose: () => void;
  onSaved: (next: Item) => void;
}) {
  const pouring = tapNumbers.length > 0;
  const statusLabel = brewGuestStatusLabel(brew.status, { pouring });
  const name = brewPresentationName(brew);
  const style = String(brew.style ?? "").trim();
  const abv = abvText(brew);
  const description = String(brew.guest_description ?? "").trim();
  const tasting = String(brew.tasting_notes ?? "").trim();
  const flavors = listField(brew.flavors);
  const tags = listField(brew.tags);
  const hops = listField(brew.hops);
  const gravity = gravityText(brew);
  const image = String(brew.image_url ?? brew.display_image_url ?? "").trim();

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [displayName, setDisplayName] = useState(String(brew.display_name ?? ""));
  const [guestDescription, setGuestDescription] = useState(String(brew.guest_description ?? ""));
  const [tastingNotes, setTastingNotes] = useState(String(brew.tasting_notes ?? ""));
  const [flavorList, setFlavorList] = useState(listField(brew.flavors));
  const [tagList, setTagList] = useState(listField(brew.tags));
  const [imageUrl, setImageUrl] = useState(String(brew.image_url ?? ""));
  const [flavorDraft, setFlavorDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");

  useEffect(() => {
    setEditing(false);
    setError("");
    setDisplayName(String(brew.display_name ?? ""));
    setGuestDescription(String(brew.guest_description ?? ""));
    setTastingNotes(String(brew.tasting_notes ?? ""));
    setFlavorList(listField(brew.flavors));
    setTagList(listField(brew.tags));
    setImageUrl(String(brew.image_url ?? ""));
    setFlavorDraft("");
    setTagDraft("");
  }, [brew.id]);

  async function savePresentation() {
    setSaving(true);
    setError("");
    try {
      const payload: Record<string, unknown> = {
        display_name: displayName.trim(),
        guest_description: guestDescription.trim(),
        tasting_notes: tastingNotes.trim(),
        flavors: serializeList(flavorList),
        tags: serializeList(tagList)
      };
      // Only send image_url when the Keeper actually changed it; server also
      // compares against stored image before flipping keeper_owns_image.
      const previousImage = String(brew.image_url ?? "").trim();
      if (imageUrl.trim() !== previousImage) {
        payload.image_url = imageUrl;
      }
      const next = await api<Item>(`/inventory/brews/${brew.id}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      onSaved(next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save presentation.");
    } finally {
      setSaving(false);
    }
  }

  function toggleFlavor(value: string) {
    setFlavorList((current) =>
      current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]
    );
  }

  if (editing && admin) {
    return (
      <div className="lab-detail">
        <button type="button" className="secondary back-button" onClick={() => setEditing(false)}>
          <ArrowLeft size={16}/> Cancel edit
        </button>
        <div className="page-title">
          <span className="eyebrow">KEEPER PRESENTATION</span>
          <h1>Edit guest-facing details</h1>
          <p>These fields stay in The Smokey Vault. Brewfather sync will not overwrite them.</p>
        </div>
        {error ? <div className="ai-error load-error"><div><strong>Could not save</strong><span>{error}</span></div></div> : null}
        <div className="form-grid lab-edit-grid">
          <label className="full">
            <span>Display name</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={String(brew.batch_name ?? "Guest-facing name")}/>
            <small className="field-hint">Optional override. Leave blank to use the Brewfather batch name.</small>
          </label>
          <label className="full">
            <span>About this beer</span>
            <textarea value={guestDescription} onChange={(e) => setGuestDescription(e.target.value)} placeholder="Short guest-facing description…"/>
          </label>
          <label className="full">
            <span>Tasting notes</span>
            <textarea value={tastingNotes} onChange={(e) => setTastingNotes(e.target.value)} placeholder="Aroma / palate / finish…"/>
          </label>
          <div className="full">
            <span className="eyebrow">FLAVOR PROFILE</span>
            <div className="chip-row">
              {BREW_FLAVOR_OPTIONS.map((value) => (
                <button
                  type="button"
                  key={value}
                  className={`chip${flavorList.includes(value) ? " active" : ""}`}
                  onClick={() => toggleFlavor(value)}
                >{value}</button>
              ))}
            </div>
            <div className="tag-input-row">
              <input value={flavorDraft} onChange={(e) => setFlavorDraft(e.target.value)} placeholder="Add a custom flavor"/>
              <button
                type="button"
                className="secondary"
                disabled={!flavorDraft.trim()}
                onClick={() => {
                  const next = flavorDraft.trim();
                  if (!next) return;
                  setFlavorList((current) => current.includes(next) ? current : [...current, next]);
                  setFlavorDraft("");
                }}
              >Add</button>
            </div>
            {flavorList.length > 0 ? (
              <div className="chip-row detail-chips">
                {flavorList.map((value) => (
                  <button type="button" className="chip active" key={value} onClick={() => toggleFlavor(value)}>{value} ×</button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="full">
            <span className="eyebrow">TAGS</span>
            <div className="tag-input-row">
              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                placeholder="#hoppy #house"
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  setTagList(parseTagInput([...tagList, tagDraft].join(" ")));
                  setTagDraft("");
                }}
              />
              <button
                type="button"
                className="secondary"
                disabled={!tagDraft.trim()}
                onClick={() => {
                  setTagList(parseTagInput([...tagList, tagDraft].join(" ")));
                  setTagDraft("");
                }}
              >Add tags</button>
            </div>
            {tagList.length > 0 ? (
              <div className="chip-row detail-chips">
                {tagList.map((value) => (
                  <button
                    type="button"
                    className="chip active"
                    key={value}
                    onClick={() => setTagList((current) => current.filter((entry) => entry !== value))}
                  >#{value} ×</button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="full">
            <span className="eyebrow">PHOTO</span>
            <ImageField value={imageUrl} onChange={setImageUrl}/>
          </div>
        </div>
        <div className="lab-footer-actions">
          <button type="button" className="primary" disabled={saving} onClick={() => void savePresentation()}>
            {saving ? "Saving…" : "Save presentation"}
          </button>
          <button type="button" className="secondary" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="lab-detail">
      <button type="button" className="secondary back-button" onClick={onClose}>
        <ArrowLeft size={16}/> Back to Brewery Lab
      </button>

      <section className="lab-detail-hero">
        <div className="lab-detail-image">
          {image ? <img src={image} alt=""/> : (pouring ? <Beer size={36}/> : <FlaskConical size={36}/>)}
        </div>
        <div className="lab-detail-copy">
          <span className={`lab-stage ${normalizeBrewStatus(brew.status).toLowerCase()}${pouring ? " pouring" : ""}`}>
            {statusLabel}
          </span>
          {pouring ? <span className="lab-tap-line">{onTapLabel(tapNumbers)}</span> : null}
          <h1>{name}</h1>
          <div className="meta">
            {style ? <span>{style}</span> : null}
            {abv ? <span>{abv}</span> : null}
            {String(brew.maker ?? "").trim() ? <span>{String(brew.maker)}</span> : null}
          </div>
          {description ? <p className="lab-about">{description}</p> : null}
          {admin ? (
            <div className="lab-footer-actions">
              <button type="button" className="primary" onClick={() => setEditing(true)}>Edit presentation</button>
            </div>
          ) : null}
        </div>
      </section>

      {flavors.length > 0 ? (
        <div className="detail-chip-block">
          <span className="eyebrow">FLAVOR PROFILE</span>
          <div className="chip-row detail-chips">
            {flavors.map((value) => <span className="chip static" key={value}>{value}</span>)}
          </div>
        </div>
      ) : null}

      {tags.length > 0 ? (
        <div className="detail-chip-block">
          <span className="eyebrow">TAGS</span>
          <div className="chip-row detail-chips">
            {tags.map((value) => <span className="chip static" key={value}>#{value}</span>)}
          </div>
        </div>
      ) : null}

      {tasting ? <TastingProfileView text={tasting} /> : null}

      <details className="lab-tech-details">
        <summary>Brewing details</summary>
        <div className="lab-stats">
          {gravity ? <span><Thermometer size={13}/> {gravity}</span> : null}
          {hops.length ? <span><Hop size={13}/> {hops.slice(0, 8).join(", ")}</span> : null}
          {String(brew.batch_name ?? "").trim() ? <span>Batch: {String(brew.batch_name)}</span> : null}
          {String(brew.brew_date ?? "").trim() ? <span>Brewed {String(brew.brew_date)}</span> : null}
          {admin && String(brew.brewfather_id ?? "").trim() ? <span>Brewfather ID {String(brew.brewfather_id)}</span> : null}
        </div>
        {String(brew.schedule ?? "").trim() ? <p className="lab-about">{String(brew.schedule)}</p> : null}
        {admin && String(brew.notes ?? "").trim() ? (
          <div className="bottle-notes">
            <span className="eyebrow">BREW NOTES</span>
            <p>{String(brew.notes)}</p>
          </div>
        ) : null}
      </details>
    </div>
  );
}
