import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { Move } from "lucide-react";
import { clamp01, cropIsDefault, cropRect, FRAME_ASPECT, type FrameKind } from "./catalog";

export type PhotoFrameHandle = {
  cropToFile: (filename?: string) => Promise<File>;
  isDirty: () => boolean;
};

type Props = {
  src: string;
  kind: FrameKind;
  alt?: string;
  hint?: string;
  busy?: boolean;
  onCommit?: (file: File) => void;
};

const MAX_ZOOM = 3;
const OUTPUT_EDGE = 1400;

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    if (!src.startsWith("blob:")) image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read that photo"));
    image.src = src;
  });
}

export async function fileFromCrop(
  src: string,
  kind: FrameKind,
  zoom: number,
  x: number,
  y: number,
  filename = "frame.jpg"
) {
  const image = await loadImage(src);
  const aspect = FRAME_ASPECT[kind];
  const { sx, sy, sw, sh } = cropRect(image.naturalWidth, image.naturalHeight, aspect, zoom, x, y);
  const outW = aspect >= 1 ? OUTPUT_EDGE : Math.round(OUTPUT_EDGE * aspect);
  const outH = aspect >= 1 ? Math.round(OUTPUT_EDGE / aspect) : OUTPUT_EDGE;
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not crop that photo");
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, outW, outH);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((next) => next ? resolve(next) : reject(new Error("Could not crop that photo")), "image/jpeg", 0.88);
  });
  return new File([blob], filename.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
}

export const PhotoFrame = forwardRef<PhotoFrameHandle, Props>(function PhotoFrame(
  { src, kind, alt = "", hint, busy, onCommit },
  ref
) {
  const [zoom, setZoom] = useState(1);
  const [x, setX] = useState(0.5);
  const [y, setY] = useState(0.5);
  const [natural, setNatural] = useState({ w: 1, h: 1 });
  const [cropError, setCropError] = useState("");
  const drag = useRef<{ pointer: number; lastX: number; lastY: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sliderId = useId();
  const aspect = FRAME_ASPECT[kind];
  const crop = cropRect(natural.w, natural.h, aspect, zoom, x, y);
  const dirty = !cropIsDefault(zoom, x, y);

  useEffect(() => {
    setZoom(1);
    setX(0.5);
    setY(0.5);
  }, [src]);

  const cropToFile = useCallback((filename?: string) => fileFromCrop(src, kind, zoom, x, y, filename), [src, kind, zoom, x, y]);

  useImperativeHandle(ref, () => ({
    cropToFile,
    isDirty: () => dirty
  }), [cropToFile, dirty]);

  function panBy(dx: number, dy: number) {
    const box = stageRef.current?.getBoundingClientRect();
    if (!box) return;
    const maxX = natural.w - crop.sw;
    const maxY = natural.h - crop.sh;
    if (maxX > 0.5) setX((current) => clamp01(current - (dx / box.width) * (crop.sw / maxX)));
    if (maxY > 0.5) setY((current) => clamp01(current - (dy / box.height) * (crop.sh / maxY)));
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, lastX: event.clientX, lastY: event.clientY };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    panBy(event.clientX - active.lastX, event.clientY - active.lastY);
    active.lastX = event.clientX;
    active.lastY = event.clientY;
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointer === event.pointerId) drag.current = null;
  }

  async function commit() {
    if (!onCommit) return;
    setCropError("");
    try {
      onCommit(await cropToFile());
    } catch (error) {
      setCropError(error instanceof Error ? error.message : "Could not crop that photo");
    }
  }

  return (
    <div className={`photo-frame photo-frame-${kind}`}>
      <div
        ref={stageRef}
        className="photo-frame-stage"
        style={{ aspectRatio: String(aspect) }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(event) => setNatural({ w: event.currentTarget.naturalWidth || 1, h: event.currentTarget.naturalHeight || 1 })}
          style={{
            width: `${(natural.w / crop.sw) * 100}%`,
            height: `${(natural.h / crop.sh) * 100}%`,
            left: `${-(crop.sx / crop.sw) * 100}%`,
            top: `${-(crop.sy / crop.sh) * 100}%`
          }}
        />
        <span className="photo-frame-hint" aria-hidden="true"><Move size={14}/> {hint ?? "Drag to reframe"}</span>
      </div>
      <label className="photo-frame-zoom" htmlFor={sliderId}>
        <span>Zoom</span>
        <input
          id={sliderId}
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
        />
      </label>
      {onCommit ? (
        <button type="button" className="secondary" disabled={busy} onClick={() => void commit()}>
          {busy ? "Saving frame…" : "Use this frame"}
        </button>
      ) : null}
      {cropError ? <p className="error">{cropError}</p> : null}
    </div>
  );
});
