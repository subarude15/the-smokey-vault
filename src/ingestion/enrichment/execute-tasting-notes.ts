/**
 * Execute tasting-note enrichment: authoritative official notes + optional AI house profile.
 * Never mutates inventory identity or personal notes fields.
 */
import { parseSafeHttpUrl } from "../../network_safety.js";
import type { BottleCandidate } from "../candidate/types.js";
import { searchWebHits, type WebSearchHit } from "../web-search.js";
import { fetchBoundedPageHtml } from "./page-extract.js";
import { extractSearchTokens, identityFromCandidate } from "./search-query.js";
import {
  classifyHit,
  formatAuthoritativeSnippets,
  isAuthoritativeSource,
  type ClassifiedHit
} from "./tasting-notes-sources.js";
import {
  extractOfficialTastingNotes,
  formatHouseProfile,
  generateHouseTastingProfile,
  type HouseProfileResult,
  type OfficialNotesExtractResult
} from "./tasting-notes-extract.js";
import type { OfficialSourceType } from "../jobs/product-content.js";

export type TastingNotesEnrichmentDeps = {
  searchWebHits?: (query: string, limit?: number) => Promise<WebSearchHit[]>;
  fetchPageHtml?: (url: string) => Promise<string | null>;
  extractOfficial?: typeof extractOfficialTastingNotes;
  generateHouseProfile?: typeof generateHouseTastingProfile;
};

const MAX_AUTHORITATIVE_PAGES_TO_FETCH = 2;
const MAX_PAGE_EXCERPT_CHARS = 2_400;

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;|&#0*38;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#0*39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, "\"")
    .replace(/&mdash;|&ndash;/gi, " - ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/**
 * Extract a bounded plain-text tasting-notes excerpt from an authoritative product page.
 * Prioritizes text around tasting-notes headings/labels (nose, aroma, palate, taste, finish)
 * while stripping scripts, styles, nav, headers, and footers.
 */
export function extractTastingNotesExcerptFromHtml(
  html: string,
  maxChars = MAX_PAGE_EXCERPT_CHARS
): string {
  if (!html || !html.trim()) return "";
  const cleaned = html
    .replace(/<(script|style|svg|noscript|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(?:p|div|li|section|article|tr|dd|dt|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeHtmlEntities(cleaned)
    .replace(/[ \t\r]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;

  const anchor = text.search(
    /\b(?:tasting\s+notes?|nose|aroma|palate|taste|flavour|flavor|finish|character|appearance)\b/i
  );
  if (anchor >= 0) {
    const start = Math.max(0, anchor - 200);
    return text.slice(start, start + maxChars).trim();
  }
  return text.slice(0, maxChars).trim();
}

export type TastingNotesExecutionResult = {
  officialNotes: string | null;
  officialSourceUrl: string | null;
  officialSourceType: OfficialSourceType | null;
  houseProfile: string | null;
  classifiedHits: ClassifiedHit[];
  errors: string[];
};

/**
 * Clean 2-tier tasting-notes queries without UPC barcodes or generic "spirit" noise
 * (official distillery/brewery/winery pages rarely include retail UPCs).
 */
export function buildTastingNotesQueries(candidate: BottleCandidate): string[] {
  const tokens = extractSearchTokens(identityFromCandidate(candidate));
  const core = [tokens.brandCore, ...tokens.productTokens]
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  const fallbackCore = [candidate.brand.value, candidate.name.value]
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  const subject = core || fallbackCore;
  if (!subject) return [];
  return [
    `${subject} official tasting notes`,
    `${subject} tasting notes`
  ];
}

function resolveOfficialSourceType(
  extracted: OfficialNotesExtractResult,
  hits: ClassifiedHit[]
): OfficialSourceType | null {
  if (!extracted.official_notes || !extracted.source_url || extracted.confidence === "none") {
    return null;
  }
  const match = hits.find((h) => h.url === extracted.source_url);
  if (match && isAuthoritativeSource(match.sourceClass)) {
    return match.sourceClass === "importer" ? "importer" : "official";
  }
  // URL must match an authoritative hit we already classified.
  const byHost = hits.find((h) => {
    try {
      return new URL(h.url).hostname === new URL(extracted.source_url!).hostname
        && isAuthoritativeSource(h.sourceClass);
    } catch {
      return false;
    }
  });
  if (byHost) return byHost.sourceClass === "importer" ? "importer" : "official";
  return null;
}

/**
 * Run tasting-note enrichment for an identified candidate.
 * Official notes stay null when no authoritative source is found (success, not failure).
 */
export async function executeTastingNotesEnrichment(
  candidate: BottleCandidate,
  deps: TastingNotesEnrichmentDeps = {},
  options: { wantOfficial?: boolean; wantHouseProfile?: boolean } = {}
): Promise<TastingNotesExecutionResult> {
  const wantOfficial = options.wantOfficial !== false;
  const wantHouseProfile = options.wantHouseProfile !== false;
  const search = deps.searchWebHits ?? searchWebHits;
  const extractOfficial = deps.extractOfficial ?? extractOfficialTastingNotes;
  const generateHouse = deps.generateHouseProfile ?? generateHouseTastingProfile;
  const errors: string[] = [];
  let classifiedHits: ClassifiedHit[] = [];
  let officialNotes: string | null = null;
  let officialSourceUrl: string | null = null;
  let officialSourceType: OfficialSourceType | null = null;
  let houseProfile: string | null = null;

  const hits: WebSearchHit[] = [];
  const seenUrls = new Set<string>();
  const queries = wantOfficial || wantHouseProfile ? buildTastingNotesQueries(candidate) : [];
  for (let i = 0; i < queries.length; i += 1) {
    try {
      const batch = await search(queries[i], 8);
      for (const hit of batch) {
        const key = hit.url || `${hit.title}|${hit.content}`;
        if (seenUrls.has(key)) continue;
        seenUrls.add(key);
        hits.push(hit);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Web search failed");
      break;
    }
    const currentClassified = hits.map((hit) =>
      classifyHit(hit, {
        brand: candidate.brand.value,
        name: candidate.name.value
      })
    );
    // Stop after Tier 1 if we already found an authoritative source (or don't need official notes).
    if (!wantOfficial || currentClassified.some((h) => isAuthoritativeSource(h.sourceClass))) {
      break;
    }
  }

  classifiedHits = hits.map((hit) =>
    classifyHit(hit, {
      brand: candidate.brand.value,
      name: candidate.name.value
    })
  );

  if (wantOfficial) {
    const fetchPage =
      deps.fetchPageHtml !== undefined
        ? deps.fetchPageHtml
        : deps.searchWebHits
          ? null
          : fetchBoundedPageHtml;
    let enrichedHits = classifiedHits;
    if (fetchPage) {
      const authIndexes: number[] = [];
      for (let i = 0; i < classifiedHits.length && authIndexes.length < MAX_AUTHORITATIVE_PAGES_TO_FETCH; i += 1) {
        if (isAuthoritativeSource(classifiedHits[i].sourceClass) && classifiedHits[i].url) {
          authIndexes.push(i);
        }
      }
      if (authIndexes.length > 0) {
        enrichedHits = [...classifiedHits];
        await Promise.all(
          authIndexes.map(async (idx) => {
            const hit = classifiedHits[idx];
            try {
              const safeUrl = parseSafeHttpUrl(hit.url).toString();
              const html = await fetchPage(safeUrl);
              const excerpt = html ? extractTastingNotesExcerptFromHtml(html) : "";
              if (excerpt) {
                enrichedHits[idx] = {
                  ...hit,
                  content: `${hit.content.trim()}\nPage excerpt:\n${excerpt}`.trim()
                };
              }
            } catch {
              // Keep search snippet fallback if URL is unsafe or page fetch fails.
            }
          })
        );
      }
    }
    const authoritative = formatAuthoritativeSnippets(enrichedHits);
    if (authoritative.trim()) {
      try {
        const extracted = await extractOfficial({
          candidate,
          authoritativeSnippets: authoritative
        });
        const sourceType = resolveOfficialSourceType(extracted, enrichedHits);
        if (extracted.official_notes && extracted.source_url && sourceType) {
          officialNotes = extracted.official_notes;
          officialSourceUrl = extracted.source_url;
          officialSourceType = sourceType;
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Official notes extract failed");
      }
    }
  }

  if (wantHouseProfile) {
    try {
      const context = classifiedHits
        .slice(0, 5)
        .map((h) => `${h.title} — ${h.content}`)
        .join("\n");
      const profile: HouseProfileResult = await generateHouse({
        candidate,
        contextSnippets: context
      });
      houseProfile = formatHouseProfile(profile);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "House profile generation failed");
    }
  }

  return {
    officialNotes,
    officialSourceUrl,
    officialSourceType,
    houseProfile,
    classifiedHits,
    errors
  };
}
