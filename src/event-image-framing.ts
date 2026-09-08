/**
 * PR140 — Non-destructive event image framing.
 * Normalized focal point + zoom so cards and detail heroes share one Keeper choice
 * without baking a destructive pixel crop into the uploaded file.
 */

export type EventImageFraming = {
  image_focal_x: number;
  image_focal_y: number;
  image_zoom: number;
};

export const DEFAULT_EVENT_IMAGE_FRAMING: EventImageFraming = {
  image_focal_x: 50,
  image_focal_y: 50,
  image_zoom: 1
};

export const EVENT_IMAGE_ZOOM_MIN = 1;
export const EVENT_IMAGE_ZOOM_MAX = 3;
export const EVENT_IMAGE_FOCAL_MIN = 0;
export const EVENT_IMAGE_FOCAL_MAX = 100;

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Round to hundredths so values stay stable across JSON round-trips. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function clampEventFocal(value: unknown, fallback = 50): number {
  const n = finiteNumber(value);
  if (n == null) return fallback;
  return round2(clamp(n, EVENT_IMAGE_FOCAL_MIN, EVENT_IMAGE_FOCAL_MAX));
}

export function clampEventZoom(value: unknown, fallback = 1): number {
  const n = finiteNumber(value);
  if (n == null) return fallback;
  return round2(clamp(n, EVENT_IMAGE_ZOOM_MIN, EVENT_IMAGE_ZOOM_MAX));
}

/** Normalize optional/legacy framing into safe defaults. */
export function normalizeEventImageFraming(
  input?: Partial<EventImageFraming> | Record<string, unknown> | null
): EventImageFraming {
  const record = (input ?? {}) as Record<string, unknown>;
  return {
    image_focal_x: clampEventFocal(record.image_focal_x, DEFAULT_EVENT_IMAGE_FRAMING.image_focal_x),
    image_focal_y: clampEventFocal(record.image_focal_y, DEFAULT_EVENT_IMAGE_FRAMING.image_focal_y),
    image_zoom: clampEventZoom(record.image_zoom, DEFAULT_EVENT_IMAGE_FRAMING.image_zoom)
  };
}

export function isDefaultEventImageFraming(framing: EventImageFraming): boolean {
  const normalized = normalizeEventImageFraming(framing);
  return (
    normalized.image_focal_x === DEFAULT_EVENT_IMAGE_FRAMING.image_focal_x &&
    normalized.image_focal_y === DEFAULT_EVENT_IMAGE_FRAMING.image_focal_y &&
    normalized.image_zoom === DEFAULT_EVENT_IMAGE_FRAMING.image_zoom
  );
}

/**
 * Inline styles for an `<img>` inside an overflow-hidden cover well.
 * Uses object-position for focal point and scale for zoom — original file untouched.
 */
export function eventImageFramingStyle(framing?: Partial<EventImageFraming> | null): {
  objectFit: "cover";
  objectPosition: string;
  transform: string;
  transformOrigin: string;
} {
  const normalized = normalizeEventImageFraming(framing);
  const x = `${normalized.image_focal_x}%`;
  const y = `${normalized.image_focal_y}%`;
  return {
    objectFit: "cover",
    objectPosition: `${x} ${y}`,
    transform: `scale(${normalized.image_zoom})`,
    transformOrigin: `${x} ${y}`
  };
}

/** Nudge focal by a percentage step (keyboard / button accessibility). */
export function nudgeEventFocal(
  framing: EventImageFraming,
  axis: "x" | "y",
  delta: number
): EventImageFraming {
  const next = { ...normalizeEventImageFraming(framing) };
  if (axis === "x") next.image_focal_x = clampEventFocal(next.image_focal_x + delta);
  else next.image_focal_y = clampEventFocal(next.image_focal_y + delta);
  return next;
}

/**
 * Pointer-drag mapping: dragging the photo right reveals left content → decrease focal X.
 * Sensitivity scales mildly with zoom so fine framing stays possible when zoomed in.
 */
export function framingFromPointerDrag(
  framing: EventImageFraming,
  deltaXPx: number,
  deltaYPx: number,
  containerWidthPx: number,
  containerHeightPx: number
): EventImageFraming {
  const current = normalizeEventImageFraming(framing);
  const width = Math.max(1, containerWidthPx);
  const height = Math.max(1, containerHeightPx);
  const sensitivity = 100 / Math.max(1, current.image_zoom);
  return normalizeEventImageFraming({
    ...current,
    image_focal_x: current.image_focal_x - (deltaXPx / width) * sensitivity,
    image_focal_y: current.image_focal_y - (deltaYPx / height) * sensitivity
  });
}
