import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Camera, ChevronLeft, ChevronRight, CircleAlert, Download, Film, ImagePlus, Trash2, Upload, X
} from "lucide-react";
import { api } from "./api";
import {
  MAX_GALLERY_BYTES, MAX_GALLERY_CAPTION, MAX_PATRON_NAME, type GalleryMedia, type Patron
} from "./catalog";
import {
  canRemoveGalleryUpload,
  formatGalleryBatchPartialMessage,
  formatGalleryBatchSuccessMessage,
  formatGalleryUploadProgress,
  formatGalleryUploadSummary,
  galleryUploadsReadyToSend,
  isVideoFile,
  megabytes,
  mergeGallerySelections,
  prepareGalleryUploadRetry,
  removeGalleryUpload,
  setGalleryUploadStatus,
  summarizeGalleryUploads,
  type PendingGalleryUpload
} from "./gallery-upload";

const ACCEPTED = "image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime";

function stamp(iso: string) {
  const parsed = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
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
        <Camera size={17}/> Add photos or clips
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
      refresh={load}
      done={(message) => { setUploadOpen(false); setNotice(message); load(); }}
      notify={setNotice}
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

function statusLabel(item: PendingGalleryUpload): string {
  switch (item.status) {
    case "pending": return "Ready";
    case "rejected": return "Too large";
    case "uploading": return "Uploading…";
    case "success": return "Uploaded";
    case "failed": return "Failed";
    default: {
      const _exhaustive: never = item.status;
      return _exhaustive;
    }
  }
}

function UploadModal({
  close,
  done,
  refresh,
  notify
}: {
  close: () => void;
  done: (message: string) => void;
  refresh: () => void;
  notify: (message: string) => void;
}) {
  const [names, setNames] = useState<string[]>([]);
  const [items, setItems] = useState<PendingGalleryUpload[]>([]);
  const [name, setName] = useState("");
  const [caption, setCaption] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [batchNote, setBatchNote] = useState("");
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ patrons: Patron[] }>("/patrons")
      .then((data) => setNames((data.patrons ?? []).map((patron) => patron.name)))
      .catch(() => setNames([]));
  }, []);

  const counts = summarizeGalleryUploads(items);
  const uploadable = galleryUploadsReadyToSend(items);
  const canSubmit = !busy && uploadable.length > 0;
  const canRetry = !busy && counts.failed > 0 && counts.pending === 0 && counts.uploading === 0;

  function choose(list: FileList | null) {
    if (!list?.length) return;
    setError("");
    setBatchNote("");
    setItems((prev) => mergeGallerySelections(prev, Array.from(list), MAX_GALLERY_BYTES));
    if (cameraRef.current) cameraRef.current.value = "";
    if (pickerRef.current) pickerRef.current.value = "";
  }

  function removeItem(id: string) {
    setItems((prev) => removeGalleryUpload(prev, id));
    setBatchNote("");
  }

  async function uploadPending(current: PendingGalleryUpload[]) {
    const queue = galleryUploadsReadyToSend(current);
    if (!queue.length) return { successDelta: 0, failedDelta: 0, finalItems: current };

    const uploadedBy = name.trim() || "Patron";
    const sharedCaption = caption.trim();
    let working = current;
    let successDelta = 0;
    let failedDelta = 0;
    const total = queue.length;

    setBusy(true);
    setError("");
    setBatchNote("");

    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      setProgress(formatGalleryUploadProgress(index + 1, total));
      working = setGalleryUploadStatus(working, item.id, "uploading");
      setItems(working);

      try {
        const body = new FormData();
        // Text fields must precede the file so the server sees them while streaming.
        body.append("uploaded_by", uploadedBy);
        body.append("caption", sharedCaption);
        body.append("media", item.file);
        await api<GalleryMedia>("/gallery/upload", { method: "POST", body });
        working = setGalleryUploadStatus(working, item.id, "success");
        successDelta += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not upload that";
        working = setGalleryUploadStatus(working, item.id, "failed", message);
        failedDelta += 1;
      }
      setItems(working);
    }

    setBusy(false);
    setProgress("");
    return { successDelta, failedDelta, finalItems: working };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!uploadable.length) return;

    const { successDelta, failedDelta, finalItems } = await uploadPending(items);
    const finalCounts = summarizeGalleryUploads(finalItems);

    if (successDelta > 0 && failedDelta === 0 && finalCounts.failed === 0) {
      done(formatGalleryBatchSuccessMessage(finalCounts.success || successDelta));
      return;
    }

    if (successDelta > 0) refresh();

    if (failedDelta > 0) {
      const note = formatGalleryBatchPartialMessage(finalCounts.success, finalCounts.failed);
      setBatchNote(note);
      notify(note);
      return;
    }

    if (!successDelta && !failedDelta) {
      setError("Nothing to upload. Remove oversized files or choose photos again.");
    }
  }

  async function retryFailed() {
    const prepared = prepareGalleryUploadRetry(items);
    setItems(prepared);
    const { successDelta, failedDelta, finalItems } = await uploadPending(prepared);
    const finalCounts = summarizeGalleryUploads(finalItems);

    if (successDelta > 0 && failedDelta === 0 && finalCounts.failed === 0) {
      done(formatGalleryBatchSuccessMessage(finalCounts.success || successDelta));
      return;
    }

    if (successDelta > 0) refresh();

    if (finalCounts.failed > 0) {
      const note = formatGalleryBatchPartialMessage(finalCounts.success, finalCounts.failed);
      setBatchNote(note);
      notify(note);
    }
  }

  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Add to the gallery">
    <form className="modal gallery-upload" onSubmit={(event) => void submit(event)}>
      <header className="modal-header">
        <div>
          <span className="eyebrow">ADD TO THE WALL</span>
          <h2>Share tonight.</h2>
          <p>Choose several photos or clips from your device. Each item can be up to {megabytes(MAX_GALLERY_BYTES)}.</p>
        </div>
        <button type="button" className="icon-button" onClick={close} aria-label="Close" disabled={busy}><X/></button>
      </header>

      <div className="gallery-pick">
        <button type="button" className="secondary" disabled={busy} onClick={() => cameraRef.current?.click()}>
          <Camera size={17}/> Take a photo or video
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => pickerRef.current?.click()}>
          <ImagePlus size={17}/> Choose from device
        </button>
        <input
          ref={cameraRef}
          type="file"
          accept={ACCEPTED}
          capture="environment"
          hidden
          onChange={(e) => choose(e.target.files)}
        />
        <input
          ref={pickerRef}
          type="file"
          accept={ACCEPTED}
          multiple
          hidden
          onChange={(e) => choose(e.target.files)}
        />
      </div>

      {items.length > 0 && (
        <div className="gallery-upload-list" role="list" aria-label="Selected uploads">
          {items.map((item) => (
            <div className={`gallery-upload-row is-${item.status}`} role="listitem" key={item.id}>
              <div className="gallery-upload-meta">
                <span className="gallery-upload-kind" aria-hidden="true">
                  {isVideoFile(item.file) ? <Film size={15}/> : <ImagePlus size={15}/>}
                </span>
                <div className="gallery-upload-text">
                  <strong className="gallery-upload-name">{item.file.name}</strong>
                  <small>
                    {isVideoFile(item.file) ? "Video" : "Photo"} · {megabytes(item.file.size)}
                    {item.error ? ` · ${item.error}` : ""}
                  </small>
                </div>
              </div>
              <div className="gallery-upload-side">
                <span className={`gallery-upload-status is-${item.status}`}>{statusLabel(item)}</span>
                {canRemoveGalleryUpload(item) && !busy ? (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${item.file.name}`}
                    onClick={() => removeItem(item.id)}
                  >
                    <X size={14}/>
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {(progress || batchNote || counts.total > 0) && (
        <p className="gallery-upload-summary" aria-live="polite">
          {progress || batchNote || formatGalleryUploadSummary(counts)}
        </p>
      )}

      <label><span>Your name</span>
        <input
          list="gallery-patron-names"
          autoComplete="off"
          value={name}
          maxLength={MAX_PATRON_NAME}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          placeholder="Regulars: start typing"
        />
        <datalist id="gallery-patron-names">{names.map((entry) => <option key={entry} value={entry}/>)}</datalist>
      </label>
      <label><span>Caption</span>
        <input
          value={caption}
          maxLength={MAX_GALLERY_CAPTION}
          disabled={busy}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Optional — applied to every item"
        />
      </label>

      {error ? <p className="error" role="alert">{error}</p> : null}
      <footer className="modal-footer gallery-upload-actions">
        <button type="button" className="secondary" onClick={close} disabled={busy}>
          {counts.failed > 0 && counts.success > 0 ? "Close" : "Cancel"}
        </button>
        {canRetry ? (
          <button type="button" className="secondary" onClick={() => void retryFailed()}>
            Retry failed
          </button>
        ) : null}
        <button className="primary" disabled={!canSubmit}>
          <Upload size={16}/>
          {busy
            ? (progress || "Uploading…")
            : uploadable.length > 1
              ? `Add ${uploadable.length} to gallery`
              : "Add to gallery"}
        </button>
      </footer>
    </form>
  </div>;
}
