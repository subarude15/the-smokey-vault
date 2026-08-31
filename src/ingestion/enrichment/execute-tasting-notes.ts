/**
 * Execute tasting-note enrichment: authoritative official notes + optional AI house profile.
 * Never mutates inventory identity or personal notes fields.
 */
import type { BottleCandidate } from "../candidate/types.js";
import { searchWebHits, type WebSearchHit } from "../web-search.js";
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
  extractOfficial?: typeof extractOfficialTastingNotes;
  generateHouseProfile?: typeof generateHouseTastingProfile;
};

export type TastingNotesExecutionResult = {
  officialNotes: string | null;
  officialSourceUrl: string | null;
  officialSourceType: OfficialSourceType | null;
  houseProfile: string | null;
  classifiedHits: ClassifiedHit[];
  errors: string[];
};

function tastingNotesQuery(candidate: BottleCandidate): string {
  const parts = [
    candidate.brand.value,
    candidate.name.value,
    candidate.product_type.value,
    candidate.upc.value,
    "official tasting notes"
  ]
    .map((p) => String(p ?? "").trim())
    .filter(Boolean);
  return parts.join(" ");
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

  let hits: WebSearchHit[] = [];
  if (wantOfficial || wantHouseProfile) {
    try {
      hits = await search(tastingNotesQuery(candidate), 8);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Web search failed");
    }
  }

  classifiedHits = hits.map((hit) =>
    classifyHit(hit, {
      brand: candidate.brand.value,
      name: candidate.name.value
    })
  );

  if (wantOfficial) {
    const authoritative = formatAuthoritativeSnippets(classifiedHits);
    if (authoritative.trim()) {
      try {
        const extracted = await extractOfficial({
          candidate,
          authoritativeSnippets: authoritative
        });
        const sourceType = resolveOfficialSourceType(extracted, classifiedHits);
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
