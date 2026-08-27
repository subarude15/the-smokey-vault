import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera, ChevronLeft, ChevronRight, CircleAlert, Download, Film, ImagePlus, Trash2, Upload, X
} from "lucide-react";
import { api } from "./api";
import {
  MAX_GALLERY_BYTES, MAX_GALLERY_CAPTION, MAX_PATRON_NAME, type GalleryMedia, type Patron
} from "./catalog";

const ACCEPTED = "image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime";

function stamp(iso: string) {
  const parsed = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function megabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export function GalleryPage({ admin, keeperName }: { admin: boolean; keeperName: string }) {
  const [media, setMedia] = useState<GalleryMedia[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [lightboxId, setLightboxId] = useState<number | null>(null);

  const load = useCallback(() => {
    api<{ media: GalleryMedia[] }>("/gallery")
      .then((data) => { setMedia(data.media ?? []); setError(""); })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the gallery."));
  }, []);
  useEffect(() => { load(); }, [load]);

  const lightboxIndex = media.findIndex((item) => item.id === lightboxId);
  const active = lightboxIndex >= 0 ? media[lightboxIndex] : null;

  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setLightboxId(null);
      if (event.key === "ArrowLeft" && lightboxIndex > 0) setLightboxId(media[lightboxIndex - 1].id);
      if (event.key === "ArrowRight" && lightboxIndex < media.length - 1) setLightboxId(media[lightboxIndex + 1].id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, lightboxIndex, media]);

  async function removeItem(item: GalleryMedia) {
    if (!confirm("Delete this from the gallery?")) return;
    try {
      await api(`/gallery/${item.id}`, { method: "DELETE" });
      if (lightboxId === item.id) setLightboxId(null);
      setNotice("Deleted");
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not delete that item");
    }
  }

  return <>
    <div className="page-title">
      <span className="eyebrow">THE BAR GALLERY</span>
      <h1>Nights at The Smokey Barrel.</h1>
      <p>{admin
        ? "Everything patrons have snapped or filmed at the bar. Delete anything that should not be here."
        : `Add your own shot from tonight. ${keeperName} keeps the good ones.`}</p>
    </div>

    {error && <div className="ai-error load-error"><CircleAlert/><div><strong>Could not load the gallery</strong><span>{error}</span></div><button className="secondary" onClick={load}>Retry</button></div>}

    <div className="gallery-toolbar">
      <button type="button" className="primary" onClick={() => setUploadOpen(true)}>
        <Camera size={17}/> Add a photo or clip
      </button>
      <span className="gallery-count">{media.length} {media.length === 1 ? "memory" : "memories"}</span>
    </div>

    {!media.length ? <div className="empty-state"><Camera size={38}/><h3>No photos yet</h3><p>Be the first to put a night on the wall.</p></div> :
      <div className="gallery-grid">{media.map((item) => (
        <figure className="gallery-tile" key={item.id}>
          <button type="button" className="gallery-open" onClick={() => setLightboxId(item.id)} aria-label={item.caption || `Open ${item.media_type}`}>
            {item.media_type === "video"
              ? <><video src={item.url} preload="metadata" muted playsInline/><span className="gallery-play"><Film size={18}/></span></>
              : <img src={item.url} alt={item.caption || "Bar photo"} loading="lazy"/>}
          </button>
          <figcaption>
            {item.caption ? <strong>{item.caption}</strong> : null}
            <small>Captured by {item.uploaded_by}</small>
            <small className="gallery-stamp">{stamp(item.created_at)}</small>
          </figcaption>
          {admin && <button type="button" className="icon-button danger gallery-delete" aria-label="Delete" onClick={() => void removeItem(item)}><Trash2 size={16}/></button>}
        </figure>
      ))}</div>}

    {uploadOpen && <UploadModal
      close={() => setUploadOpen(false)}
      done={(message) => { setUploadOpen(false); setNotice(message); load(); }}
    />}

    {active && <div className="modal-backdrop gallery-lightbox" role="dialog" aria-modal="true" aria-label="Gallery viewer">
      <button type="button" className="icon-button lightbox-close" onClick={() => setLightboxId(null)} aria-label="Close"><X/></button>
      {lightboxIndex > 0 && <button type="button" className="icon-button lightbox-nav prev" onClick={() => setLightboxId(media[lightboxIndex - 1].id)} aria-label="Previous"><ChevronLeft/></button>}
      {lightboxIndex < media.length - 1 && <button type="button" className="icon-button lightbox-nav next" onClick={() => setLightboxId(media[lightboxIndex + 1].id)} aria-label="Next"><ChevronRight/></button>}
      <figure className="lightbox-stage">
        {active.media_type === "video"
          ? <video src={active.url} controls autoPlay playsInline preload="metadata"/>
          : <img src={active.url} alt={active.caption || "Bar photo"}/>}
        <figcaption>
          <div>
            {active.caption ? <strong>{active.caption}</strong> : null}
            <small>Captured by {active.uploaded_by} · {stamp(active.created_at)}</small>
          </div>
          <div className="lightbox-actions">
            <a className="secondary" href={active.download_url} download><Download size={18}/> Download</a>
            {admin && <button type="button" className="secondary danger" onClick={() => void removeItem(active)}><Trash2 size={18}/> Delete</button>}
          </div>
        </figcaption>
      </figure>
    </div>}

    {notice && <div className="toast" onAnimationEnd={() => setNotice("")}>{notice}</div>}
  </>;
}

function UploadModal({ close, done }: { close: () => void; done: (message: string) => void }) {
  const [names, setNames] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [caption, setCaption] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ patrons: Patron[] }>("/patrons")
      .then((data) => setNames((data.patrons ?? []).map((patron) => patron.name)))
      .catch(() => setNames([]));
  }, []);

  function choose(list: FileList | null) {
    const picked = list?.[0] ?? null;
    if (!picked) return;
    if (picked.size > MAX_GALLERY_BYTES) {
      setError(`That file is ${megabytes(picked.size)}. The limit is ${megabytes(MAX_GALLERY_BYTES)}.`);
      setFile(null);
      return;
    }
    setError("");
    setFile(picked);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      // Text fields must precede the file so the server sees them while streaming.
      body.append("uploaded_by", name.trim() || "Patron");
      body.append("caption", caption.trim());
      body.append("media", file);
      await api<GalleryMedia>("/gallery/upload", { method: "POST", body });
      done("Added to the gallery");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload that");
    } finally {
      setBusy(false);
    }
  }

  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Add to the gallery">
    <form className="modal gallery-upload" onSubmit={submit}>
      <header className="modal-header">
        <div><span className="eyebrow">ADD TO THE WALL</span><h2>Share tonight.</h2><p>Photos and short clips, up to {megabytes(MAX_GALLERY_BYTES)}.</p></div>
        <button type="button" className="icon-button" onClick={close} aria-label="Close"><X/></button>
      </header>

      <div className="gallery-pick">
        <button type="button" className="secondary" onClick={() => cameraRef.current?.click()}><Camera size={17}/> Take a photo or video</button>
        <button type="button" className="secondary" onClick={() => pickerRef.current?.click()}><ImagePlus size={17}/> Choose from device</button>
        <input ref={cameraRef} type="file" accept={ACCEPTED} capture="environment" hidden onChange={(e) => choose(e.target.files)}/>
        <input ref={pickerRef} type="file" accept={ACCEPTED} hidden onChange={(e) => choose(e.target.files)}/>
      </div>

      {file && <p className="gallery-chosen">{file.type.startsWith("video/") ? <Film size={15}/> : <ImagePlus size={15}/>} {file.name} · {megabytes(file.size)}</p>}

      <label><span>Your name</span>
        <input list="gallery-patron-names" autoComplete="off" value={name} maxLength={MAX_PATRON_NAME} onChange={(e) => setName(e.target.value)} placeholder="Regulars: start typing"/>
        <datalist id="gallery-patron-names">{names.map((entry) => <option key={entry} value={entry}/>)}</datalist>
      </label>
      <label><span>Caption</span>
        <input value={caption} maxLength={MAX_GALLERY_CAPTION} onChange={(e) => setCaption(e.target.value)} placeholder="Optional"/>
      </label>

      {error ? <p className="error">{error}</p> : null}
      <footer className="modal-footer">
        <button type="button" className="secondary" onClick={close}>Cancel</button>
        <button className="primary" disabled={busy || !file}><Upload size={16}/> {busy ? "Uploading…" : "Add to gallery"}</button>
      </footer>
    </form>
  </div>;
}
