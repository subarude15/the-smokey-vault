import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Camera,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  Film,
  FolderOpen,
  ImagePlus,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { api } from "./api";
import {
  GENERAL_GALLERY_ALBUM_NAME,
  MAX_GALLERY_ALBUM_NAME,
  MAX_GALLERY_BYTES,
  MAX_GALLERY_CAPTION,
  MAX_PATRON_NAME,
  type GalleryAlbum,
  type GalleryMedia,
  type Patron
} from "./catalog";
import {
  albumById,
  albumMemoryLabel,
  defaultAlbumId,
  sortAlbumsForDisplay
} from "./gallery-albums";
import { GallerySocial } from "./GallerySocial";
import {
  canRemoveGalleryUpload,
  formatGalleryBatchPartialMessage,
  formatGalleryBatchSuccessMessage,
  formatGalleryUploadProgress,
  formatGalleryUploadSummary,
  galleryUploadsReadyToSend,
  gallerySizeLabel,
  isGalleryBatchCompleteSuccess,
  isVideoFile,
  mergeGallerySelections,
  type GalleryUploadLimits,
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
  const [albums, setAlbums] = useState<GalleryAlbum[]>([]);
  const [selectedAlbumId, setSelectedAlbumId] = useState<number | null>(null);
  const [media, setMedia] = useState<GalleryMedia[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [lightboxId, setLightboxId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameAlbum, setRenameAlbum] = useState<GalleryAlbum | null>(null);
  const [moveItem, setMoveItem] = useState<GalleryMedia | null>(null);
  // Effective per-type upload ceilings from the server (photos stay at 150 MB;
  // Keepers get a larger video limit). The server remains authoritative; this
  // only drives client-side selection UX.
  const [uploadLimits, setUploadLimits] = useState<GalleryUploadLimits>({
    imageBytes: MAX_GALLERY_BYTES,
    videoBytes: MAX_GALLERY_BYTES,
  });

  const selectedAlbum = albumById(albums, selectedAlbumId);

  const loadAlbums = useCallback(async () => {
    const data = await api<{ albums: GalleryAlbum[] }>("/gallery/albums");
    const next = sortAlbumsForDisplay(data.albums ?? []);
    setAlbums(next);
    return next;
  }, []);

  const loadMedia = useCallback(async (albumId: number) => {
    const data = await api<{ media: GalleryMedia[]; album?: GalleryAlbum }>(`/gallery?album_id=${albumId}`);
    setMedia(data.media ?? []);
    if (data.album) {
      setAlbums((current) => {
        const without = current.filter((album) => album.id !== data.album!.id);
        return sortAlbumsForDisplay([...without, data.album!]);
      });
    }
  }, []);

  /** Refresh albums (and the open album's media) without racing the selection effect. */
  const refresh = useCallback(async () => {
    try {
      const next = await loadAlbums();
      setError("");
      if (selectedAlbumId == null) return;
      if (!next.some((album) => album.id === selectedAlbumId)) {
        setSelectedAlbumId(null);
        setMedia([]);
        return;
      }
      await loadMedia(selectedAlbumId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the gallery.");
    }
  }, [loadAlbums, loadMedia, selectedAlbumId]);

  // Album list on mount / when loadAlbums identity is stable.
  useEffect(() => {
    loadAlbums()
      .then(() => setError(""))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the gallery."));
  }, [loadAlbums]);

  // Ask the server for this caller's effective per-type upload ceilings.
  useEffect(() => {
    api<{ image_max_bytes: number; video_max_bytes: number }>("/gallery/config")
      .then((data) => {
        const imageBytes = typeof data.image_max_bytes === "number" && data.image_max_bytes > 0
          ? data.image_max_bytes : MAX_GALLERY_BYTES;
        const videoBytes = typeof data.video_max_bytes === "number" && data.video_max_bytes > 0
          ? data.video_max_bytes : MAX_GALLERY_BYTES;
        setUploadLimits({ imageBytes, videoBytes });
      })
      .catch(() => setUploadLimits({ imageBytes: MAX_GALLERY_BYTES, videoBytes: MAX_GALLERY_BYTES }));
  }, [admin]);

  // Single path for opening/clearing an album — one GET /gallery?album_id= per selection.
  useEffect(() => {
    if (selectedAlbumId == null) {
      setMedia([]);
      setLightboxId(null);
      return;
    }
    let cancelled = false;
    loadMedia(selectedAlbumId).catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : "Could not load that album.");
      }
    });
    return () => { cancelled = true; };
  }, [selectedAlbumId, loadMedia]);

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
      void refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not delete that item");
    }
  }

  async function deleteAlbum(album: GalleryAlbum) {
    if (album.is_default) {
      setNotice("The General album cannot be deleted");
      return;
    }
    const confirmText = album.media_count > 0
      ? `Delete “${album.name}”? Its ${albumMemoryLabel(album.media_count)} will move to ${GENERAL_GALLERY_ALBUM_NAME}.`
      : `Delete “${album.name}”?`;
    if (!confirm(confirmText)) return;
    try {
      await api(`/gallery/albums/${album.id}`, { method: "DELETE" });
      if (selectedAlbumId === album.id) setSelectedAlbumId(null);
      setNotice(`Deleted “${album.name}”`);
      void refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not delete that album");
    }
  }

  const showingAlbum = selectedAlbum != null;

  return <>
    <div className="page-title">
      <span className="eyebrow">THE BAR GALLERY</span>
      <h1>{showingAlbum ? selectedAlbum.name : "Nights at The Smokey Barrel."}</h1>
      <p>{showingAlbum
        ? (admin
          ? "Memories in this album. Move or delete anything that should not stay here."
          : `Shots and clips from this night. ${keeperName} keeps the good ones.`)
        : (admin
          ? "Albums for parties and special nights. Create one, then drop photos and clips inside."
          : `Pick an album and add your shot from tonight. ${keeperName} keeps the good ones.`)}</p>
    </div>

    {error && (
      <div className="ai-error load-error">
        <CircleAlert/>
        <div><strong>Could not load the gallery</strong><span>{error}</span></div>
        <button className="secondary" onClick={() => void refresh()}>Retry</button>
      </div>
    )}

    {!showingAlbum ? (
      <>
        <div className="gallery-toolbar">
          <div className="gallery-toolbar-actions">
            <button type="button" className="primary" onClick={() => setUploadOpen(true)}>
              <Camera size={17}/> Add photos or clips
            </button>
            {admin ? (
              <button type="button" className="secondary" onClick={() => setCreateOpen(true)}>
                <Plus size={17}/> New album
              </button>
            ) : null}
          </div>
          <span className="gallery-count">{albums.length} {albums.length === 1 ? "album" : "albums"}</span>
        </div>

        {!albums.length ? (
          <div className="empty-state">
            <FolderOpen size={38}/>
            <h3>No albums yet</h3>
            <p>{admin ? "Create the first album for a party night." : "Check back soon."}</p>
          </div>
        ) : (
          <div className="gallery-album-grid">
            {albums.map((album) => (
              <article className="gallery-album-card" key={album.id}>
                <button
                  type="button"
                  className="gallery-album-open"
                  onClick={() => setSelectedAlbumId(album.id)}
                  aria-label={`Open ${album.name}`}
                >
                  {album.cover_url
                    ? <img src={album.cover_url} alt="" loading="lazy"/>
                    : <span className="gallery-album-fallback"><FolderOpen size={28}/></span>}
                  <div>
                    <strong>{album.name}</strong>
                    <small>{albumMemoryLabel(album.media_count)}</small>
                  </div>
                </button>
                {admin && !album.is_default ? (
                  <div className="gallery-album-actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Rename ${album.name}`}
                      onClick={() => setRenameAlbum(album)}
                    >
                      <Pencil size={16}/>
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label={`Delete ${album.name}`}
                      onClick={() => void deleteAlbum(album)}
                    >
                      <Trash2 size={16}/>
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </>
    ) : (
      <>
        <div className="gallery-toolbar">
          <div className="gallery-toolbar-actions">
            <button type="button" className="secondary" onClick={() => setSelectedAlbumId(null)}>
              <ArrowLeft size={17}/> Albums
            </button>
            <button type="button" className="primary" onClick={() => setUploadOpen(true)}>
              <Camera size={17}/> Add photos or clips
            </button>
            {admin && !selectedAlbum.is_default ? (
              <button type="button" className="secondary" onClick={() => setRenameAlbum(selectedAlbum)}>
                <Pencil size={17}/> Rename
              </button>
            ) : null}
          </div>
          <span className="gallery-count">{albumMemoryLabel(media.length)}</span>
        </div>

        {!media.length ? (
          <div className="empty-state">
            <Camera size={38}/>
            <h3>No photos in this album yet</h3>
            <p>Be the first to put a night on the wall.</p>
          </div>
        ) : (
          <div className="gallery-grid">{media.map((item) => (
            <figure className="gallery-tile" key={item.id}>
              <button type="button" className="gallery-open" onClick={() => setLightboxId(item.id)} aria-label={item.caption || `Open ${item.media_type}`}>
                {item.media_type === "video" ? (
                  <>
                    {item.poster_url
                      ? <img src={item.poster_url} alt={item.caption || "Bar clip"} loading="lazy"/>
                      : <span className="gallery-video-fallback" aria-hidden><Film size={28}/></span>}
                    <span className="gallery-play"><Film size={18}/></span>
                  </>
                ) : (
                  <img src={item.url} alt={item.caption || "Bar photo"} loading="lazy"/>
                )}
              </button>
              <figcaption>
                {item.caption ? <strong>{item.caption}</strong> : null}
                <small>Captured by {item.uploaded_by}</small>
                <small className="gallery-stamp">{stamp(item.created_at)}</small>
              </figcaption>
              {admin ? (
                <div className="gallery-tile-actions">
                  <button
                    type="button"
                    className="icon-button gallery-move"
                    aria-label={`Move ${item.caption || "photo"}`}
                    onClick={() => setMoveItem(item)}
                  >
                    <FolderOpen size={16}/>
                  </button>
                  <button
                    type="button"
                    className="icon-button danger gallery-delete"
                    aria-label="Delete"
                    onClick={() => void removeItem(item)}
                  >
                    <Trash2 size={16}/>
                  </button>
                </div>
              ) : null}
            </figure>
          ))}</div>
        )}
      </>
    )}

    {uploadOpen && (
      <UploadModal
        albums={albums}
        initialAlbumId={selectedAlbumId ?? defaultAlbumId(albums)}
        limits={uploadLimits}
        close={() => setUploadOpen(false)}
        refresh={() => void refresh()}
        done={(message) => { setUploadOpen(false); setNotice(message); void refresh(); }}
        notify={setNotice}
      />
    )}

    {createOpen && admin ? (
      <AlbumNameModal
        title="New album"
        eyebrow="PARTY ALBUM"
        initial=""
        submitLabel="Create album"
        onClose={() => setCreateOpen(false)}
        onSave={async (name) => {
          const created = await api<GalleryAlbum>("/gallery/albums", {
            method: "POST",
            body: JSON.stringify({ name })
          });
          setCreateOpen(false);
          setNotice(`Created “${created.name}”`);
          await loadAlbums();
          setSelectedAlbumId(created.id);
        }}
      />
    ) : null}

    {renameAlbum && admin && !renameAlbum.is_default ? (
      <AlbumNameModal
        title="Rename album"
        eyebrow="PARTY ALBUM"
        initial={renameAlbum.name}
        submitLabel="Save name"
        onClose={() => setRenameAlbum(null)}
        onSave={async (name) => {
          const updated = await api<GalleryAlbum>(`/gallery/albums/${renameAlbum.id}`, {
            method: "PUT",
            body: JSON.stringify({ name })
          });
          setRenameAlbum(null);
          setNotice(`Renamed to “${updated.name}”`);
          void refresh();
        }}
      />
    ) : null}

    {moveItem && admin ? (
      <MoveMediaModal
        item={moveItem}
        albums={albums}
        onClose={() => setMoveItem(null)}
        onMoved={(albumName) => {
          setMoveItem(null);
          setLightboxId(null);
          setNotice(`Moved to “${albumName}”`);
          void refresh();
        }}
        onError={(message) => setNotice(message)}
      />
    ) : null}

    {active && (
      <div className="modal-backdrop gallery-lightbox" role="dialog" aria-modal="true" aria-label="Gallery viewer">
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
              {admin ? (
                <>
                  <button type="button" className="secondary" onClick={() => setMoveItem(active)}>
                    <FolderOpen size={18}/> Move
                  </button>
                  <button type="button" className="secondary danger" onClick={() => void removeItem(active)}>
                    <Trash2 size={18}/> Delete
                  </button>
                </>
              ) : null}
            </div>
            <GallerySocial mediaId={active.id} admin={admin}/>
          </figcaption>
        </figure>
      </div>
    )}

    {notice && <div className="toast" onAnimationEnd={() => setNotice("")}>{notice}</div>}
  </>;
}

function AlbumNameModal({
  title,
  eyebrow,
  initial,
  submitLabel,
  onClose,
  onSave
}: {
  title: string;
  eyebrow: string;
  initial: string;
  submitLabel: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the album a name");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that album");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <form className="modal gallery-upload" onSubmit={(event) => void submit(event)}>
        <header className="modal-header">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close" disabled={busy}><X/></button>
        </header>
        <label>
          <span>Album name</span>
          <input
            value={name}
            maxLength={MAX_GALLERY_ALBUM_NAME}
            disabled={busy}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder="Christmas, St. Patrick’s Day…"
          />
        </label>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <footer className="modal-footer">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" disabled={busy || !name.trim()}>{submitLabel}</button>
        </footer>
      </form>
    </div>
  );
}

function MoveMediaModal({
  item,
  albums,
  onClose,
  onMoved,
  onError
}: {
  item: GalleryMedia;
  albums: GalleryAlbum[];
  onClose: () => void;
  onMoved: (albumName: string) => void;
  onError: (message: string) => void;
}) {
  const [albumId, setAlbumId] = useState(String(item.album_id));
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const nextId = Number(albumId);
    if (!Number.isFinite(nextId) || nextId <= 0) return;
    if (nextId === item.album_id) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await api(`/gallery/${item.id}/album`, {
        method: "PUT",
        body: JSON.stringify({ album_id: nextId })
      });
      const album = albumById(albums, nextId);
      onMoved(album?.name ?? "album");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not move that item");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Move gallery item">
      <form className="modal gallery-upload" onSubmit={(event) => void submit(event)}>
        <header className="modal-header">
          <div>
            <span className="eyebrow">MOVE MEMORY</span>
            <h2>Choose an album</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close" disabled={busy}><X/></button>
        </header>
        <label>
          <span>Album</span>
          <select value={albumId} disabled={busy} onChange={(e) => setAlbumId(e.target.value)}>
            {albums.map((album) => (
              <option key={album.id} value={album.id}>{album.name}</option>
            ))}
          </select>
        </label>
        <footer className="modal-footer">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" disabled={busy}>Move</button>
        </footer>
      </form>
    </div>
  );
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
  albums,
  initialAlbumId,
  limits,
  close,
  done,
  refresh,
  notify
}: {
  albums: GalleryAlbum[];
  initialAlbumId: number | null;
  limits: GalleryUploadLimits;
  close: () => void;
  done: (message: string) => void;
  refresh: () => void;
  notify: (message: string) => void;
}) {
  const [names, setNames] = useState<string[]>([]);
  const [items, setItems] = useState<PendingGalleryUpload[]>([]);
  const [name, setName] = useState("");
  const [caption, setCaption] = useState("");
  const [albumId, setAlbumId] = useState(String(initialAlbumId ?? defaultAlbumId(albums) ?? ""));
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
  const canSubmit = !busy && uploadable.length > 0 && Boolean(albumId);
  const canRetry = !busy && counts.failed > 0 && counts.pending === 0 && counts.uploading === 0;

  function choose(list: FileList | null) {
    if (!list?.length) return;
    const picked = Array.from(list);
    setError("");
    setBatchNote("");
    setItems((prev) => mergeGallerySelections(prev, picked, limits));
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
        body.append("uploaded_by", uploadedBy);
        body.append("caption", sharedCaption);
        body.append("album_id", albumId);
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

    if (isGalleryBatchCompleteSuccess(finalCounts)) {
      done(formatGalleryBatchSuccessMessage(finalCounts.success));
      return;
    }

    if (successDelta > 0) refresh();

    if (finalCounts.failed > 0) {
      const note = formatGalleryBatchPartialMessage(finalCounts.success, finalCounts.failed);
      setBatchNote(note);
      notify(note);
      return;
    }

    if (finalCounts.rejected > 0) {
      const note = formatGalleryUploadSummary(finalCounts);
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

    if (isGalleryBatchCompleteSuccess(finalCounts)) {
      done(formatGalleryBatchSuccessMessage(finalCounts.success));
      return;
    }

    if (successDelta > 0) refresh();

    if (finalCounts.failed > 0) {
      const note = formatGalleryBatchPartialMessage(finalCounts.success, finalCounts.failed);
      setBatchNote(note);
      notify(note);
      return;
    }

    if (finalCounts.rejected > 0) {
      const note = formatGalleryUploadSummary(finalCounts);
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
          <p>Choose several photos or clips from your device. {limits.videoBytes > limits.imageBytes
            ? `Photos up to ${gallerySizeLabel(limits.imageBytes)}; videos up to ${gallerySizeLabel(limits.videoBytes)}.`
            : `Each item can be up to ${gallerySizeLabel(limits.imageBytes)}.`}</p>
        </div>
        <button type="button" className="icon-button" onClick={close} aria-label="Close" disabled={busy}><X/></button>
      </header>

      <label>
        <span>Album</span>
        <select value={albumId} disabled={busy || !albums.length} onChange={(e) => setAlbumId(e.target.value)}>
          {albums.map((album) => (
            <option key={album.id} value={album.id}>{album.name}</option>
          ))}
        </select>
      </label>

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
                    {isVideoFile(item.file) ? "Video" : "Photo"} · {gallerySizeLabel(item.file.size)}
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
