export const FRAME_ASPECT = {
  crew: 4 / 3,
  bottle: 3 / 4,
  square: 1
} as const;

export type FrameKind = keyof typeof FRAME_ASPECT;

export type CropRect = { sx: number; sy: number; sw: number; sh: number };

export function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/**
 * The slice of the source photo that fills a card of `aspect` (width / height).
 * zoom 1 is a cover crop; higher zoom tightens the window. x/y 0.5 is centered.
 */
export function cropRect(
  imageW: number,
  imageH: number,
  aspect: number,
  zoom: number,
  x: number,
  y: number
): CropRect {
  const width = Math.max(1, imageW);
  const height = Math.max(1, imageH);
  const ratio = width / height;
  const frame = aspect > 0 ? aspect : 1;
  const z = Math.max(1, zoom);

  let cropW: number;
  let cropH: number;
  if (ratio > frame) {
    cropH = height / z;
    cropW = cropH * frame;
  } else {
    cropW = width / z;
    cropH = cropW / frame;
  }
  cropW = Math.min(cropW, width);
  cropH = Math.min(cropH, height);

  return {
    sx: clamp01(x) * (width - cropW),
    sy: clamp01(y) * (height - cropH),
    sw: cropW,
    sh: cropH
  };
}

export function cropIsDefault(zoom: number, x: number, y: number) {
  return zoom <= 1 && Math.abs(x - 0.5) < 0.001 && Math.abs(y - 0.5) < 0.001;
}
