/**
 * Bounded <img> extraction from already-authoritative product pages.
 * Only used when og:image / JSON-LD yield no usable candidates.
 * Provenance stays tied to the official page URL — CDN hosts are not globally trusted.
 */
export type OfficialPageImgCandidate = {
  url: string;
  /** Official product page that referenced the asset. */
  sourceUrl: string;
  alt: string;
  width: number | null;
  height: number | null;
  scoreHint: number;
  reason: string;
};

export type OfficialPageImgScanResult = {
  scanned: number;
  prefiltered: OfficialPageImgCandidate[];
  rejectedReasons: Record<string, number>;
};

const MAX_SCAN = 40;
const MAX_CANDIDATES = 16;

const LOGO_ICON_RE =
  /logo|icon|favicon|sprite|avatar|badge|social|facebook|twitter|instagram|pinterest|youtube|tiktok|menu|nav|footer|header|cart|search|arrow|chevron|play-button|close-btn|tracking|pixel|1x1|spacer/i;

const PRODUCTISH_RE =
  /bottle|product|packshot|pack-shot|hero|whisky|whiskey|bourbon|scotch|wine|beer|can|label|range|expression/i;

function absolutize(raw: string, pageUrl: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value || value.startsWith("data:")) return null;
  try {
    const abs = new URL(value, pageUrl).toString();
    return /^https?:\/\//i.test(abs) ? abs : null;
  } catch {
    return null;
  }
}

/** Parse srcset into candidate URLs (prefer larger width descriptors). */
export function parseSrcsetUrls(srcset: string, pageUrl: string): string[] {
  const entries: Array<{ url: string; width: number }> = [];
  for (const part of String(srcset ?? "").split(",")) {
    const bits = part.trim().split(/\s+/);
    if (!bits[0]) continue;
    const abs = absolutize(bits[0], pageUrl);
    if (!abs) continue;
    const desc = bits[1] ?? "";
    const widthMatch = desc.match(/^(\d+)w$/i);
    const width = widthMatch ? Number(widthMatch[1]) : 0;
    entries.push({ url: abs, width });
  }
  entries.sort((a, b) => b.width - a.width);
  const out: string[] = [];
  for (const e of entries) {
    if (!out.includes(e.url)) out.push(e.url);
  }
  return out;
}

function attr(tag: string, name: string): string {
  const re = new RegExp(`${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i");
  return tag.match(re)?.[2]?.trim() ?? "";
}

function parseDimension(raw: string): number | null {
  const n = Number(String(raw ?? "").replace(/px$/i, "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function tokenize(value: string): string[] {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Deterministic prefilter for decoration / chrome assets on official pages.
 */
export function isLikelyPageDecoration(options: {
  url: string;
  alt?: string;
  width?: number | null;
  height?: number | null;
}): { reject: boolean; reason: string | null } {
  const url = options.url.toLowerCase();
  const alt = String(options.alt ?? "");
  const width = options.width ?? null;
  const height = options.height ?? null;

  if (/\.svg(\?|$)/i.test(url)) {
    return { reject: true, reason: "svg_ui_asset" };
  }
  if (LOGO_ICON_RE.test(url) || LOGO_ICON_RE.test(alt)) {
    return { reject: true, reason: "logo_or_icon" };
  }
  if (width != null && height != null) {
    if (width <= 2 || height <= 2) {
      return { reject: true, reason: "tracking_pixel" };
    }
    if (width < 120 || height < 120) {
      return { reject: true, reason: "tiny_thumbnail" };
    }
  }
  // Path hints for tiny UI sprites.
  if (/\/(icons?|sprites?|ui|chrome)\//i.test(url)) {
    return { reject: true, reason: "ui_path" };
  }
  return { reject: false, reason: null };
}

function productScore(options: {
  url: string;
  alt: string;
  brand: string;
  name: string;
  width: number | null;
  height: number | null;
}): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];
  const hay = `${options.url} ${options.alt}`.toLowerCase();
  const brandTokens = tokenize(options.brand.replace(/^the\s+/i, ""));
  const nameTokens = tokenize(options.name).filter((t) => !brandTokens.includes(t));

  if (PRODUCTISH_RE.test(hay)) {
    score += 3;
    reasons.push("productish");
  }
  for (const tok of brandTokens) {
    if (tok.length >= 4 && hay.includes(tok)) {
      score += 2;
      reasons.push("brand_token");
      break;
    }
  }
  for (const tok of nameTokens.slice(0, 6)) {
    if (tok.length >= 4 && hay.includes(tok)) {
      score += 2;
      reasons.push("product_token");
      break;
    }
  }
  if (options.width != null && options.height != null) {
    const min = Math.min(options.width, options.height);
    if (min >= 400) {
      score += 2;
      reasons.push("large");
    } else if (min >= 200) {
      score += 1;
      reasons.push("medium");
    }
  }
  return { score, reason: reasons.join(",") || "weak_signal" };
}

/**
 * Scan an authoritative HTML page for product-like <img> candidates.
 * Does not execute scripts. Caps scan and candidate counts.
 */
export function extractOfficialPageImgCandidates(
  html: string,
  pageUrl: string,
  options: { brand?: string | null; name?: string | null } = {}
): OfficialPageImgScanResult {
  const brand = String(options.brand ?? "");
  const name = String(options.name ?? "");
  const rejectedReasons: Record<string, number> = {};
  const bump = (reason: string) => {
    rejectedReasons[reason] = (rejectedReasons[reason] ?? 0) + 1;
  };

  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]).slice(0, MAX_SCAN);
  const seen = new Set<string>();
  const scored: OfficialPageImgCandidate[] = [];

  for (const tag of imgTags) {
    const alt = attr(tag, "alt");
    const width = parseDimension(attr(tag, "width"));
    const height = parseDimension(attr(tag, "height"));
    const rawUrls = [
      attr(tag, "src"),
      attr(tag, "data-src"),
      attr(tag, "data-lazy-src"),
      attr(tag, "data-original"),
      ...parseSrcsetUrls(attr(tag, "srcset"), pageUrl),
      ...parseSrcsetUrls(attr(tag, "data-srcset"), pageUrl)
    ];

    for (const raw of rawUrls) {
      const url = absolutize(raw, pageUrl);
      if (!url || seen.has(url)) continue;
      seen.add(url);

      const decoration = isLikelyPageDecoration({ url, alt, width, height });
      if (decoration.reject) {
        bump(decoration.reason || "decoration");
        continue;
      }

      const hint = productScore({ url, alt, brand, name, width, height });
      // Require at least a weak product/brand signal OR decent size without chrome.
      if (hint.score < 2) {
        bump("weak_product_signal");
        continue;
      }

      scored.push({
        url,
        sourceUrl: pageUrl,
        alt,
        width,
        height,
        scoreHint: hint.score,
        reason: hint.reason
      });
    }
  }

  scored.sort((a, b) => b.scoreHint - a.scoreHint);
  return {
    scanned: Math.min(imgTags.length, MAX_SCAN),
    prefiltered: scored.slice(0, MAX_CANDIDATES),
    rejectedReasons
  };
}
