/**
 * Authoritative-page-only image fallback: extract product-looking image URLs
 * from already-fetched brand/producer HTML when OG / JSON-LD yield nothing.
 *
 * Mechanisms (static HTML only — no JS execution / headless browser):
 * - <img> src / srcset / data-* lazy attrs
 * - <picture> / <source> srcset / data-srcset
 * - <link rel="preload|prefetch" as="image">
 * - CSS background-image: url(...) from inline styles / <style> / bounded linked CSS
 *
 * Provenance stays page-scoped: candidates are official only because the
 * authoritative page referenced them. CDN domains are not globally trusted.
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

export type OfficialPageImageDiagnostic =
  | "official_page_img_candidates"
  | "official_page_no_product_imgs"
  | "official_page_logos_or_small_assets_only"
  | "official_page_client_rendered";

export type OfficialPageImgScanResult = {
  scanned: number;
  prefiltered: OfficialPageImgCandidate[];
  rejectedReasons: Record<string, number>;
  /** Distinct diagnostic when zero candidates after scan. */
  diagnostic: OfficialPageImageDiagnostic;
  /** True when the page looks like a JS shell with no static image assets. */
  clientRenderedShell: boolean;
};

const MAX_SCAN = 80;
const MAX_CANDIDATES = 16;
const MAX_LINKED_CSS = 3;
const MAX_CSS_BYTES = 200_000;
const CSS_FETCH_TIMEOUT_MS = 4_000;

const LOGO_ICON_RE =
  /logo|icon|favicon|sprite|avatar|badge|social|facebook|twitter|instagram|pinterest|youtube|tiktok|menu|nav|footer|header|cart|search|arrow|chevron|play-button|close-btn|tracking|pixel|1x1|spacer/i;

const PRODUCTISH_RE =
  /bottle|product|packshot|pack-shot|hero|whisky|whiskey|bourbon|scotch|wine|beer|can|label|range|expression/i;

const LAZY_ATTRS = [
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-image",
  "data-background-image",
  "data-lazy",
  "data-url"
] as const;

function absolutize(raw: string, pageUrl: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return null;
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

/** True when a URL is clearly not a raster product image (stylesheet, font, etc.). */
function isNonImageCssAssetUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return /\.(css|js|mjs|cjs|map|json|html?|xml|woff2?|ttf|otf|eot|svg)(\?|$)/i.test(path);
  } catch {
    return /\.(css|js|mjs|svg|woff2?|ttf)(\?|$)/i.test(url);
  }
}

/** Extract url(...) references from a CSS fragment. Never returns the stylesheet URL itself. */
export function extractCssBackgroundUrls(cssText: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cssText)) !== null) {
    const abs = absolutize(m[1], baseUrl);
    if (!abs) continue;
    if (isNonImageCssAssetUrl(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/**
 * Heuristic: page is a client-rendered shell when static HTML has essentially
 * no product image asset references and shows SPA/framework markers.
 */
export function looksLikeClientRenderedShell(
  html: string,
  staticImageRefCount: number
): boolean {
  if (staticImageRefCount > 0) return false;
  const sample = html.slice(0, 80_000);
  const markers = [
    /id=["']__next["']/i,
    /id=["']root["']/i,
    /id=["']app["']/i,
    /data-reactroot/i,
    /ng-version=/i,
    /window\.__INITIAL_STATE__/i,
    /__NUXT__/i,
    /<script[^>]+src=["'][^"']*\/_next\/static/i,
    /<script[^>]+src=["'][^"']*chunk/i
  ];
  const hit = markers.some((re) => re.test(sample));
  const mediaTags =
    (sample.match(/<img\b/gi) || []).length +
    (sample.match(/<picture\b/gi) || []).length +
    (sample.match(/<source\b[^>]+srcset/gi) || []).length;
  return hit || mediaTags === 0;
}

type RawRef = {
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
};

function collectLazyAndSrcset(tag: string, pageUrl: string): string[] {
  const rawUrls: string[] = [];
  const src = attr(tag, "src");
  if (src) rawUrls.push(src);
  for (const a of LAZY_ATTRS) {
    const v = attr(tag, a);
    if (v) rawUrls.push(v);
  }
  rawUrls.push(...parseSrcsetUrls(attr(tag, "srcset"), pageUrl));
  rawUrls.push(...parseSrcsetUrls(attr(tag, "data-srcset"), pageUrl));
  return rawUrls;
}

function scoreAndCollect(
  refs: RawRef[],
  pageUrl: string,
  brand: string,
  name: string,
  rejectedReasons: Record<string, number>
): OfficialPageImgCandidate[] {
  const bump = (reason: string) => {
    rejectedReasons[reason] = (rejectedReasons[reason] ?? 0) + 1;
  };
  const seen = new Set<string>();
  const scored: OfficialPageImgCandidate[] = [];

  for (const ref of refs) {
    if (!ref.url || seen.has(ref.url)) continue;
    seen.add(ref.url);

    // Stylesheet / script / font URLs are not image candidates.
    if (isNonImageCssAssetUrl(ref.url)) {
      bump("non_image_asset");
      continue;
    }

    const decoration = isLikelyPageDecoration({
      url: ref.url,
      alt: ref.alt,
      width: ref.width,
      height: ref.height
    });
    if (decoration.reject) {
      bump(decoration.reason || "decoration");
      continue;
    }

    const hint = productScore({
      url: ref.url,
      alt: ref.alt,
      brand,
      name,
      width: ref.width,
      height: ref.height
    });
    if (hint.score < 2) {
      bump("weak_product_signal");
      continue;
    }

    scored.push({
      url: ref.url,
      sourceUrl: pageUrl,
      alt: ref.alt,
      width: ref.width,
      height: ref.height,
      scoreHint: hint.score,
      reason: hint.reason
    });
  }

  scored.sort((a, b) => b.scoreHint - a.scoreHint);
  return scored;
}

function gatherStaticImageRefs(html: string, pageUrl: string): { refs: RawRef[]; scanned: number } {
  const refs: RawRef[] = [];
  let scanned = 0;

  // <img>
  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]).slice(0, MAX_SCAN);
  for (const tag of imgTags) {
    scanned += 1;
    const alt = attr(tag, "alt");
    const width = parseDimension(attr(tag, "width"));
    const height = parseDimension(attr(tag, "height"));
    for (const raw of collectLazyAndSrcset(tag, pageUrl)) {
      const url = absolutize(raw, pageUrl);
      if (url) refs.push({ url, alt, width, height });
    }
  }

  // <picture> / <source>
  const sourceTags = [
    ...html.matchAll(/<source\b[^>]*>/gi)
  ]
    .map((m) => m[0])
    .slice(0, MAX_SCAN);
  for (const tag of sourceTags) {
    scanned += 1;
    const width = parseDimension(attr(tag, "width"));
    const height = parseDimension(attr(tag, "height"));
    const raws = [
      attr(tag, "src"),
      ...LAZY_ATTRS.map((a) => attr(tag, a)),
      ...parseSrcsetUrls(attr(tag, "srcset"), pageUrl),
      ...parseSrcsetUrls(attr(tag, "data-srcset"), pageUrl)
    ];
    for (const raw of raws) {
      const url = absolutize(raw, pageUrl);
      if (url) refs.push({ url, alt: "", width, height });
    }
  }

  // preload / prefetch as=image
  const linkTags = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  for (const tag of linkTags) {
    const rel = attr(tag, "rel").toLowerCase();
    if (!/\bpreload\b|\bprefetch\b/.test(rel)) continue;
    const as = attr(tag, "as").toLowerCase();
    const imagesrcset = attr(tag, "imagesrcset");
    if (as !== "image" && !imagesrcset) continue;
    scanned += 1;
    const href = attr(tag, "href");
    if (href) {
      if (href.includes(",") && /\d+w/i.test(href)) {
        for (const u of parseSrcsetUrls(href, pageUrl)) {
          refs.push({ url: u, alt: "preload", width: null, height: null });
        }
      } else {
        const url = absolutize(href, pageUrl);
        if (url) refs.push({ url, alt: "preload", width: null, height: null });
      }
    }
    if (imagesrcset) {
      for (const u of parseSrcsetUrls(imagesrcset, pageUrl)) {
        refs.push({ url: u, alt: "preload", width: null, height: null });
      }
    }
  }

  // Inline style background-image
  const styleAttrRe = /style\s*=\s*(["'])([\s\S]*?)\1/gi;
  let sm: RegExpExecArray | null;
  while ((sm = styleAttrRe.exec(html)) !== null) {
    const style = sm[2];
    if (!/url\(/i.test(style)) continue;
    scanned += 1;
    for (const u of extractCssBackgroundUrls(style, pageUrl)) {
      refs.push({ url: u, alt: "css-background", width: null, height: null });
    }
  }

  // <style> blocks
  const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  for (const block of styleBlocks) {
    const css = block[1] || "";
    if (!css.includes("url(")) continue;
    for (const u of extractCssBackgroundUrls(css, pageUrl)) {
      scanned += 1;
      refs.push({ url: u, alt: "css-background", width: null, height: null });
    }
  }

  return { refs, scanned };
}

function resolveDiagnostic(
  prefiltered: OfficialPageImgCandidate[],
  scanned: number,
  clientRenderedShell: boolean
): OfficialPageImageDiagnostic {
  if (prefiltered.length > 0) return "official_page_img_candidates";
  if (clientRenderedShell) return "official_page_client_rendered";
  if (scanned > 0) return "official_page_logos_or_small_assets_only";
  return "official_page_no_product_imgs";
}

/**
 * Scan an authoritative HTML page for product-like image candidates.
 * Does not execute scripts. Caps scan and candidate counts.
 * Sync: skips linked external CSS fetch.
 */
export function extractOfficialPageImgCandidates(
  html: string,
  pageUrl: string,
  options: { brand?: string | null; name?: string | null } = {}
): OfficialPageImgScanResult {
  const brand = String(options.brand ?? "");
  const name = String(options.name ?? "");
  const rejectedReasons: Record<string, number> = {};

  const { refs, scanned } = gatherStaticImageRefs(html, pageUrl);
  const scored = scoreAndCollect(refs, pageUrl, brand, name, rejectedReasons);
  const prefiltered = scored.slice(0, MAX_CANDIDATES);
  const clientRenderedShell = looksLikeClientRenderedShell(html, prefiltered.length);

  return {
    scanned,
    prefiltered,
    rejectedReasons,
    diagnostic: resolveDiagnostic(prefiltered, scanned, clientRenderedShell),
    clientRenderedShell
  };
}

async function fetchBoundedCss(href: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CSS_FETCH_TIMEOUT_MS);
    const res = await fetch(href, {
      signal: controller.signal,
      headers: { Accept: "text/css,*/*;q=0.1", "User-Agent": "TheSmokeyVaultBot/1.0" },
      redirect: "follow"
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (
      ct
      && !ct.includes("css")
      && !ct.includes("text/plain")
      && !ct.includes("octet-stream")
      && !/\.css(\?|$)/i.test(href)
    ) {
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_CSS_BYTES) {
      return buf.subarray(0, MAX_CSS_BYTES).toString("utf8");
    }
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Async variant that also fetches a few linked stylesheets for background-image URLs.
 */
export async function extractOfficialPageImgCandidatesAsync(
  html: string,
  pageUrl: string,
  options: {
    brand?: string | null;
    name?: string | null;
    fetchLinkedCss?: boolean;
  } = {}
): Promise<OfficialPageImgScanResult> {
  const brand = String(options.brand ?? "");
  const name = String(options.name ?? "");
  const rejectedReasons: Record<string, number> = {};
  const fetchLinkedCss = options.fetchLinkedCss !== false;

  const { refs, scanned: baseScanned } = gatherStaticImageRefs(html, pageUrl);
  let scanned = baseScanned;

  if (fetchLinkedCss) {
    let pageOrigin = "";
    try {
      pageOrigin = new URL(pageUrl).origin;
    } catch {
      pageOrigin = "";
    }
    const cssHrefs: string[] = [];
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0];
      const rel = attr(tag, "rel").toLowerCase();
      if (!/\bstylesheet\b/.test(rel)) continue;
      const href = attr(tag, "href");
      if (!href) continue;
      const abs = absolutize(href, pageUrl);
      if (!abs) continue;
      try {
        const u = new URL(abs);
        if (pageOrigin && u.origin === pageOrigin) cssHrefs.push(abs);
        else if (/product|theme|main|app|hero/i.test(u.pathname)) cssHrefs.push(abs);
      } catch {
        /* skip */
      }
      if (cssHrefs.length >= MAX_LINKED_CSS) break;
    }
    for (const href of cssHrefs.slice(0, MAX_LINKED_CSS)) {
      const css = await fetchBoundedCss(href);
      if (!css) continue;
      for (const u of extractCssBackgroundUrls(css, href)) {
        scanned += 1;
        refs.push({ url: u, alt: "css-background", width: null, height: null });
      }
    }
  }

  const scored = scoreAndCollect(refs, pageUrl, brand, name, rejectedReasons);
  const prefiltered = scored.slice(0, MAX_CANDIDATES);
  const clientRenderedShell = looksLikeClientRenderedShell(html, prefiltered.length);

  return {
    scanned,
    prefiltered,
    rejectedReasons,
    diagnostic: resolveDiagnostic(prefiltered, scanned, clientRenderedShell),
    clientRenderedShell
  };
}
