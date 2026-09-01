/**
 * Volume parsing for government catalogs.
 * Preserve volume_raw; do not coerce unusual valid sizes (e.g. 748 ml → 750).
 */

export type VolumeParse = {
  volumeRaw: string | null;
  volumeMl: number | null;
  qualityFlags: string[];
};

export function parseGovernmentVolume(raw: unknown): VolumeParse {
  if (raw == null || raw === "") {
    return { volumeRaw: null, volumeMl: null, qualityFlags: [] };
  }
  const volumeRaw = String(raw).trim();
  if (!volumeRaw) return { volumeRaw: null, volumeMl: null, qualityFlags: [] };

  const flags: string[] = [];
  const lower = volumeRaw.toLowerCase().replace(/,/g, "");

  // Multipack hints stay in flags; still parse stated total when present.
  if (/\d+\s*[x×]\s*\d+/i.test(volumeRaw) || /gift\s*set/i.test(volumeRaw)) {
    flags.push("package_aggregate_hint");
  }

  let ml: number | null = null;
  const liter = lower.match(/(\d+(?:\.\d+)?)\s*l(?:iter)?s?\b/);
  const milli = lower.match(/(\d+(?:\.\d+)?)\s*m\.?l\.?\b/);
  if (liter) {
    const n = Number.parseFloat(liter[1]!);
    if (Number.isFinite(n) && n > 0) ml = Math.round(n * 1000);
  } else if (milli) {
    const n = Number.parseFloat(milli[1]!);
    if (Number.isFinite(n) && n > 0) ml = Math.round(n);
  } else {
    const bare = lower.match(/^(\d+(?:\.\d+)?)$/);
    if (bare) {
      const n = Number.parseFloat(bare[1]!);
      if (Number.isFinite(n) && n > 0) {
        // Bare integers from Iowa are already ml.
        ml = Math.round(n);
      }
    }
  }

  if (ml != null && (ml <= 0 || ml > 20_000)) {
    flags.push("volume_out_of_range");
    ml = null;
  }

  return { volumeRaw, volumeMl: ml, qualityFlags: flags };
}
