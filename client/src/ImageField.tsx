import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { Camera, ImagePlus, Link2, Trash2, Upload } from "lucide-react";
import { api } from "./api";

const LOCAL_MEDIA_PREFIX = "/api/media/images/";

function dataUrlToFile(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const subtype = match[1].split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
  return new File([bytes], `pasted.${subtype}`, { type: match[1] });
}

function firstImageFile(list?: FileList | null) {
  return Array.from(list ?? []).find((file) => file.type.startsWith("image/") || !file.type) ?? null;
}

function browserOrigin(explicit?: string | null): string | null {
  const raw = String(explicit ?? "").trim();
  if (raw) {
    try {
      return new URL(raw).origin;
    } catch {
      return null;
    }
  }
  try {
    if (typeof window !== "undefined" && window.location?.origin) {
      return window.location.origin;
    }
  } catch {
    // non-browser / locked-down environments
  }
  return null;
}

/** True for durable app media paths, including absolute same-origin URLs. */
export function isLocalMediaValue(value?: string | null, origin?: string | null): boolean {
  const raw = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  if (!raw) return false;
  if (raw.startsWith(LOCAL_MEDIA_PREFIX)) return true;
  if (raw.startsWith("api/media/images/")) return true;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      if (!parsed.pathname.startsWith(LOCAL_MEDIA_PREFIX)) return false;
      const appOrigin = browserOrigin(origin);
      // Foreign hosts that happen to use `/api/media/images/...` stay remote.
      return Boolean(appOrigin && parsed.origin === appOrigin);
    }
  } catch {
    // ignore
  }
  return false;
}

/** Prefer the durable relative media path for inventory persistence. */
export function toStoredMediaValue(value: string, origin?: string | null): string {
  const raw = value.trim();
  if (!raw) return "";
  if (raw.startsWith(LOCAL_MEDIA_PREFIX)) return raw;
  if (raw.startsWith("api/media/images/")) return `/${raw}`;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      if (!parsed.pathname.startsWith(LOCAL_MEDIA_PREFIX)) return raw;
      const appOrigin = browserOrigin(origin);
      if (appOrigin && parsed.origin === appOrigin) {
        return `${parsed.pathname}${parsed.search}`;
      }
    }
  } catch {
    // ignore
  }
  return raw;
}

/**
 * Complete a media upload attempt. On failure, only report the error — never
 * call onChange with a captured prior value (that races with newer edits).
 */
export async function settleMediaUpload(
  upload: () => Promise<{ url: string }>,
  hooks: {
    onSuccess: (storedUrl: string) => void;
    onFailure: (message: string) => void;
    origin?: string | null;
  }
): Promise<void> {
  try {
    const result = await upload();
    hooks.onSuccess(toStoredMediaValue(result.url, hooks.origin));
  } catch (err) {
    hooks.onFailure(err instanceof Error ? err.message : "Could not upload photo");
  }
}

export function ImageField({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const safeValue = typeof value === "string" ? value : value == null ? "" : String(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [showUrl, setShowUrl] = useState(Boolean(safeValue) && !isLocalMediaValue(safeValue));
  const wellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isLocalMediaValue(safeValue)) setShowUrl(false);
  }, [safeValue]);

  async function uploadFile(file: File) {
    setBusy(true);
    setError("");
    try {
      await settleMediaUpload(
        async () => {
          const body = new FormData();
          body.append("image", file);
          return api<{ url: string }>("/media/upload", { method: "POST", body });
        },
        {
          onSuccess: (stored) => {
            onChange(stored);
            setShowUrl(false);
            if (wellRef.current) wellRef.current.textContent = "\u200B";
          },
          onFailure: (message) => {
            // Leave parent form state untouched — the existing image is already shown.
            setError(message);
          }
        }
      );
    } finally {
      setBusy(false);
    }
  }

  async function takeClipboard(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const data = event.clipboardData;
    const fromItems = Array.from(data?.items ?? [])
      .filter((item) => item.kind === "file" && (!item.type || item.type.startsWith("image/")))
      .map((item) => item.getAsFile())
      .find(Boolean);
    const file = fromItems ?? firstImageFile(data?.files);
    if (file) {
      await uploadFile(file);
      return;
    }
    const text = data?.getData("text/plain")?.trim() ?? "";
    if (text.startsWith("blob:")) {
      try {
        const response = await fetch(text);
        const blob = await response.blob();
        if (!blob.type.startsWith("image/") && blob.type) {
          setError("Clipboard item was not an image.");
          return;
        }
        const type = blob.type || "image/jpeg";
        const subtype = type.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
        await uploadFile(new File([blob], `pasted.${subtype}`, { type }));
        return;
      } catch {
        setError("Could not read the pasted photo from the clipboard.");
        return;
      }
    }
    const fromDataUrl = text.startsWith("data:image/") ? dataUrlToFile(text) : null;
    if (fromDataUrl) {
      await uploadFile(fromDataUrl);
      return;
    }
    if (/^https?:\/\//i.test(text)) {
      onChange(toStoredMediaValue(text));
      setShowUrl(!isLocalMediaValue(text));
      return;
    }
    const html = data?.getData("text/html") ?? "";
    const embedded = html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
    if (embedded?.startsWith("data:image/")) {
      const fromHtml = dataUrlToFile(embedded);
      if (fromHtml) {
        await uploadFile(fromHtml);
        return;
      }
    }
    if (embedded?.startsWith("blob:")) {
      try {
        const response = await fetch(embedded);
        const blob = await response.blob();
        const type = blob.type || "image/jpeg";
        const subtype = type.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
        await uploadFile(new File([blob], `pasted.${subtype}`, { type }));
        return;
      } catch {
        setError("Could not read the pasted photo from the clipboard.");
        return;
      }
    }
    if (embedded && /^https?:\/\//i.test(embedded)) {
      onChange(toStoredMediaValue(embedded));
      setShowUrl(!isLocalMediaValue(embedded));
      return;
    }
    setError("No photo was on the clipboard. Copy a picture, then touch and hold here and tap Paste.");
  }

  function clearWell(event: FormEvent<HTMLDivElement>) {
    event.currentTarget.textContent = "\u200B";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    const file = firstImageFile(event.dataTransfer.files);
    if (file) void uploadFile(file);
  }

  return (
    <div className="image-field">
      {safeValue ? (
        <div className="image-field-preview">
          {/* Tapping the photo itself is the fastest way to retake it behind the bar. */}
          <label className="image-field-retake">
            <img src={safeValue} alt="Tap or bottle photo"/>
            <span className="image-field-retake-hint"><Camera size={15}/> Tap the photo to retake</span>
            <input type="file" accept="image/*" capture="environment" aria-label="Retake photo" onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadFile(file);
            }}/>
          </label>
          <button type="button" className="icon-button" aria-label="Remove photo" onClick={() => onChange("")}><Trash2 size={16}/></button>
        </div>
      ) : null}
      <div className="image-paste-wrap">
        <div
          ref={wellRef}
          className={`image-paste-well${dragOver ? " dragover" : ""}`}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          inputMode="none"
          aria-label="Paste a photo. Touch and hold, then tap Paste."
          tabIndex={0}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onPaste={(event) => { void takeClipboard(event); }}
          onInput={clearWell}
          onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
          onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >{"\u200B"}</div>
        <span className="image-paste-hint" aria-hidden="true">
          <ImagePlus size={22}/>
          <strong>{busy ? "Saving photo…" : "Touch and hold, then tap Paste"}</strong>
          Copy a photo on this iPad or phone, press and hold this box, and choose Paste. You can also choose a photo below.
        </span>
      </div>
      <div className="image-field-actions">
        <label className="secondary file-button">
          <Upload size={16}/> Choose photo
          <input type="file" accept="image/*" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void uploadFile(file);
          }}/>
        </label>
        <label className="secondary file-button">
          <Camera size={16}/> Take photo
          <input type="file" accept="image/*" capture="environment" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void uploadFile(file);
          }}/>
        </label>
      </div>
      <button type="button" className="image-url-toggle" onClick={() => setShowUrl((open) => !open)}>
        <Link2 size={14}/> {showUrl ? "Hide image URL" : "Or paste an image URL"}
      </button>
      {showUrl ? (
        <input
          type="url"
          value={safeValue}
          placeholder="https://…"
          onChange={(event) => onChange(toStoredMediaValue(event.target.value))}
        />
      ) : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
