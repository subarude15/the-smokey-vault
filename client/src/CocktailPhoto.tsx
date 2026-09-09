import React, { useRef, useState } from "react";
import { ImageField } from "./ImageField";
import { api } from "./api";

type Candidate = { image_url: string; source_url: string };

/** Native dialog provides focus containment, Escape dismissal and focus return. */
export function CocktailPhoto({ id, name, imageUrl, admin, onSaved }: {
  id: number; name: string; imageUrl: string; admin: boolean; onSaved: (url: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  function open(edit: boolean) {
    setEditing(edit);
    setDraft(imageUrl);
    setCandidates([]);
    setNotice("");
    setError("");
    dialog.current?.showModal();
  }
  async function search() {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{ candidates: Candidate[] }>(`/cocktails/${id}/image-options`, { method: "POST", body: "{}" });
      setCandidates(result.candidates);
      if (!result.candidates.length) setNotice("No alternative photos found. You can upload a photo or paste an image URL below.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not search for photos"); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError("");
    try {
      const result = await api<{ image_url: string }>(`/cocktails/${id}/image`, {
        method: "PUT", body: JSON.stringify({ image_url: draft, expected_image_url: imageUrl })
      });
      onSaved(result.image_url);
      dialog.current?.close();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save photo"); }
    finally { setBusy(false); }
  }
  return <div className="cocktail-photo">
    {imageUrl && <button type="button" className="cocktail-photo-open" onClick={() => open(false)} aria-label={`View full photo of ${name}`}>
      <img className="recipe-hero" src={imageUrl} alt={name}/>
      <span>View full photo</span>
    </button>}
    {admin && <button type="button" className="secondary" onClick={() => open(true)}>{imageUrl ? "Replace photo" : "Choose photo"}</button>}
    <dialog ref={dialog} className="cocktail-photo-dialog" aria-label={editing ? `Choose photo for ${name}` : `Photo of ${name}`} onCancel={event => { if (busy) event.preventDefault(); }}>
      <header className="modal-header"><h2>{editing ? "Choose photo" : name}</h2><button type="button" className="secondary" disabled={busy} onClick={() => dialog.current?.close()}>Close</button></header>
      {!editing ? <img className="cocktail-photo-full" src={imageUrl} alt={name}/> : admin && <>
        <p>Your current photo stays until you select Save photo.</p>
        <fieldset disabled={busy} className="cocktail-photo-controls">
          <button type="button" className="secondary" onClick={() => void search()}>{busy ? "Working…" : "Find alternatives"}</button>
          <div className="cocktail-photo-options">{candidates.map(candidate => <button type="button" key={candidate.image_url} aria-pressed={draft === candidate.image_url} onClick={() => setDraft(candidate.image_url)}>
            <img src={candidate.image_url} alt={`Photo from ${new URL(candidate.source_url).hostname}`}/>
            <span>{new URL(candidate.source_url).hostname}</span>
          </button>)}</div>
          <ImageField value={draft} onChange={setDraft}/>
          {draft && <img className="cocktail-photo-preview" src={draft} alt="Selected photo preview"/>}
          <button type="button" className="primary" disabled={!draft || draft === imageUrl || !draft.startsWith("/api/media/images/")} onClick={() => void save()}>Save photo</button>
        </fieldset>
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert" className="error">{error}</p>}
      </>}
    </dialog>
  </div>;
}
