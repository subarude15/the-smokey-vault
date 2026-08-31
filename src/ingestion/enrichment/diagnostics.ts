/**
 * Lightweight enrichment diagnostics for keeper/admin observability.
 * Never stores secrets, full prompts, or large page bodies.
 */
export type EnrichmentJobKind = "metadata" | "tasting_notes" | "image";

export type DiagnosticStageStatus = "ok" | "skipped" | "no_result" | "error";

export type NoResultReason =
  | "no_search_results"
  | "no_authoritative_sources"
  | "source_fetch_failed"
  | "extractor_returned_null"
  | "extracted_values_invalid"
  | "all_values_weaker_than_existing"
  | "no_image_candidates"
  | "all_image_candidates_rejected"
  | "verification_rejected"
  | "score_below_threshold"
  | "provider_error";

/** Bounded per-stage diagnostic row. */
export type EnrichmentDiagnosticStage = {
  stage: string;
  status: DiagnosticStageStatus;
  query?: string;
  provider?: string;
  candidateCount?: number;
  acceptedCount?: number;
  rejectedCount?: number;
  reason?: string;
  /** Bounded URL list (max ~12). */
  sourceUrls?: string[];
};

export type FieldRejectReason = {
  field: string;
  reason:
    | "rejected_weaker_source"
    | "invalid_numeric"
    | "classification_not_canonical"
    | "same_value_already_present"
    | "user_verified_value_protected"
    | string;
};

/** Persisted inside enrichment_jobs.result_json (alongside progress fields). */
export type JobDiagnosticsPayload = {
  jobType: EnrichmentJobKind;
  noResultReason?: NoResultReason | string | null;
  summary?: string | null;
  stages: EnrichmentDiagnosticStage[];
  requested?: string[];
  extracted?: string[];
  accepted?: string[];
  unresolved?: string[];
  rejectReasons?: FieldRejectReason[];
};

const MAX_URLS = 12;
const MAX_STAGES = 16;
const MAX_REJECTS = 24;

export function boundUrls(urls: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const url = String(raw ?? "").trim();
    if (!url || seen.has(url)) continue;
    // Never persist query strings that might carry tokens.
    let safe = url;
    try {
      const parsed = new URL(url);
      parsed.search = "";
      parsed.hash = "";
      safe = parsed.toString();
    } catch {
      safe = url.slice(0, 240);
    }
    seen.add(safe);
    out.push(safe);
    if (out.length >= MAX_URLS) break;
  }
  return out;
}

export function sanitizeDiagnosticStage(stage: EnrichmentDiagnosticStage): EnrichmentDiagnosticStage {
  return {
    stage: String(stage.stage ?? "").slice(0, 64),
    status: stage.status,
    query: stage.query != null ? String(stage.query).slice(0, 320) : undefined,
    provider: stage.provider != null ? String(stage.provider).slice(0, 64) : undefined,
    candidateCount: stage.candidateCount,
    acceptedCount: stage.acceptedCount,
    rejectedCount: stage.rejectedCount,
    reason: stage.reason != null ? String(stage.reason).slice(0, 160) : undefined,
    sourceUrls: stage.sourceUrls ? boundUrls(stage.sourceUrls) : undefined
  };
}

export function sanitizeJobDiagnostics(payload: JobDiagnosticsPayload): JobDiagnosticsPayload {
  return {
    jobType: payload.jobType,
    noResultReason: payload.noResultReason ?? null,
    summary: payload.summary != null ? String(payload.summary).slice(0, 280) : null,
    stages: (payload.stages ?? []).slice(0, MAX_STAGES).map(sanitizeDiagnosticStage),
    requested: payload.requested?.slice(0, 24),
    extracted: payload.extracted?.slice(0, 24),
    accepted: payload.accepted?.slice(0, 24),
    unresolved: payload.unresolved?.slice(0, 24),
    rejectReasons: payload.rejectReasons?.slice(0, MAX_REJECTS).map((r) => ({
      field: String(r.field).slice(0, 40),
      reason: String(r.reason).slice(0, 80)
    }))
  };
}

/** Friendly one-liner for keeper UI. */
export function friendlyDiagnosticSummary(payload: JobDiagnosticsPayload | null | undefined): string | null {
  if (!payload) return null;
  if (payload.summary?.trim()) return payload.summary.trim();
  const reason = payload.noResultReason;
  switch (reason) {
    case "no_search_results":
      return "Search returned no results";
    case "no_authoritative_sources":
      return "No authoritative source produced usable metadata";
    case "source_fetch_failed":
      return "Could not fetch authoritative source pages";
    case "extractor_returned_null":
      return "Extractor returned no supported values";
    case "extracted_values_invalid":
      return "Extracted values failed canonical validation";
    case "all_values_weaker_than_existing":
      return "Extracted values were weaker than existing data";
    case "no_image_candidates":
      return "No image candidates found";
    case "all_image_candidates_rejected":
      return "All image candidates were rejected";
    case "verification_rejected":
      return "Image verification rejected candidates";
    case "score_below_threshold":
      return "Verified candidates scored below acceptance threshold";
    case "provider_error":
      return "Provider or network error";
    default:
      return reason ? String(reason).replace(/_/g, " ") : null;
  }
}

/** Map internal source class → diagnostic reason label. */
export function sourceClassDiagnosticReason(
  sourceClass: string,
  accepted: boolean
): string {
  if (accepted) {
    switch (sourceClass) {
      case "official":
        return "official_brand";
      case "regulatory":
        return "regulatory";
      case "importer":
        return "importer";
      default:
        return "approved_web";
    }
  }
  switch (sourceClass) {
    case "retailer":
      return "retailer_rejected";
    case "ugc":
      return "blog_rejected";
    default:
      return "unknown_rejected";
  }
}
