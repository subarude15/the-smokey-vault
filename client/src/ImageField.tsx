import { useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { Camera, ImagePlus, Link2, Trash2, Upload } from "lucide-react";
import { api } from "./api";

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

export function ImageField({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [showUrl, setShowUrl] = useState(Boolean(value) && !value.startsWith("/api/media/images/"));
  const wellRef = useRef<HTMLDivElement>(null);

  async function uploadFile(file: File) {
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("image", file);
      const result = await api<{ url: string }>("/media/upload", { method: "POST", body });
      onChange(result.url);
      if (wellRef.current) wellRef.current.textContent = "\u200B";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload photo");
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
    const fromDataUrl = text.startsWith("data:image/") ? dataUrlToFile(text) : null;
    if (fromDataUrl) {
      await uploadFile(fromDataUrl);
      return;
    }
    if (/^https?:\/\//i.test(text)) {
      onChange(text);
      setShowUrl(true);
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
    if (embedded && /^https?:\/\//i.test(embedded)) {
      onChange(embedded);
      setShowUrl(true);
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
      {value ? (
        <div className="image-field-preview">
          {/* Tapping the photo itself is the fastest way to retake it behind the bar. */}
          <label className="image-field-retake">
            <img src={value} alt="Bottle photo"/>
            <span className="image-field-retake-hint"><Camera size={15}/> Tap the photo to retake</span>
            <input type="file" accept="image/*" capture="environment" aria-label="Retake bottle photo" onChange={(event) => {
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
          value={value}
          placeholder="https://…"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
