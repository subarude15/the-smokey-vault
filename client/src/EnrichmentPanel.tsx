import { useEffect, useState } from "react";
import { api } from "./api";

export type FieldView = {
  value: string | number | null;
  source: string | null;
  sourceLabel: string | null;
  confidence: number | null;
  confidenceBand: string;
  confidenceLabel: string;
  status: "trusted" | "missing" | "low_confidence" | "review";
};

export type JobView = {
  type: string;
  status: string;
  statusLabel: "complete" | "partial" | "in_progress" | "waiting" | "no_result" | "failed" | "not_started";
  attempts: number;
  lastError: string | null;
  diagnosticSummary?: string | null;
  lastRunLabel?: string | null;
  stillMissing?: string[];
  diagnostics?: {
    jobType?: string;
    noResultReason?: string | null;
    summary?: string | null;
    stages?: Array<{
      stage: string;
      status: string;
      query?: string;
      provider?: string;
      candidateCount?: number;
      acceptedCount?: number;
      rejectedCount?: number;
      reason?: string;
      sourceUrls?: string[];
    }>;
    requested?: string[];
    extracted?: string[];
    accepted?: string[];
    unresolved?: string[];
    rejectReasons?: Array<{ field: string; reason: string }>;
    imageCandidates?: Array<{
      urlHost: string;
      urlPath?: string;
      sourceType: string;
      sourcePageHost?: string;
      width?: number | null;
      height?: number | null;
      mimeType?: string | null;
      fetchStatus?: string;
      stageReached?: string;
      vision?: {
        ran: boolean;
        correctProduct?: boolean | null;
        bottleProminent?: boolean | null;
        containsPeople?: boolean | null;
        memeOrGraphic?: boolean | null;
        cleanProductPhoto?: boolean | null;
        error?: string | null;
      };
      score?: number | null;
      threshold?: number;
      accepted: boolean;
      rejectionReasons: string[];
      scoreComponents?: {
        official_source?: number;
        identity_match?: number;
        clean_photo?: number;
        large_image?: number;
        total?: number;
        threshold?: number;
      } | null;
    }>;
  } | null;
};

export type ConflictView = {
  field: string;
  keptValue: string | number | null;
  keptSource: string;
  keptSourceLabel: string;
  competingValue: string | number | null;
  competingSource: string;
  competingSourceLabel: string;
};

export type BottleEnrichmentView = {
  entityType: string;
  entityId: number;
  identity: {
    name: FieldView;
    brand: FieldView;
    productType: FieldView;
    upc: FieldView;
  };
  metadata: {
    category: FieldView;
    abv: FieldView;
    proof: FieldView;
    volumeMl: FieldView;
    origin: FieldView;
    ttbId: FieldView;
  };
  enrichment: {
    identified: boolean;
    needsReview: boolean;
    missing: string[];
    jobs: JobView[];
    conflicts: ConflictView[];
  };
  tastingNotes: {
    official: string | null;
    sourceUrl: string | null;
    sourceType: string | null;
    houseProfile: string | null;
    personal: string | null;
  };
  image: {
    displayUrl: string | null;
    enrichedUrl: string | null;
    sourceType: string | null;
    sourceUrl: string | null;
    score: number | null;
    verified: boolean | null;
    userPreferred: boolean;
  };
};

/** Modest polling while jobs are pending/running. */
export const ENRICHMENT_POLL_MS = 7_000;

export const ENRICHMENT_MODULES = new Set(["spirits", "packaged_beer", "wines"]);

export function shouldPollEnrichment(jobs: JobView[] | undefined): boolean {
  if (!jobs?.length) return false;
  return jobs.some((j) => j.statusLabel === "waiting" || j.statusLabel === "in_progress");
}

export function jobStatusDisplay(label: JobView["statusLabel"]): string {
  switch (label) {
    case "complete":
      return "Complete";
    case "partial":
      return "Partial";
    case "in_progress":
      return "In progress";
    case "waiting":
      return "Waiting";
    case "no_result":
      return "No result";
    case "failed":
      return "Failed";
    default:
      return "Not started";
  }
}

export function jobTypeDisplay(type: string): string {
  switch (type) {
    case "metadata":
      return "Metadata";
    case "tasting_notes":
      return "Tasting notes";
    case "image":
      return "Image";
    default:
      return type;
  }
}

function formatRejectionLabel(reason: string): string {
  return String(reason)
    .replace(/^score_below_threshold:.*/, "score below threshold")
    .replace(/_/g, " ");
}

function visionSummaryLine(vision: NonNullable<NonNullable<JobView["diagnostics"]>["imageCandidates"]>[number]["vision"]): string | null {
  if (!vision?.ran) return null;
  if (vision.error) return `Vision failed: ${formatRejectionLabel(vision.error)}`;
  return null;
}

function visionDetailLines(vision: NonNullable<NonNullable<JobView["diagnostics"]>["imageCandidates"]>[number]["vision"]): string[] {
  if (!vision?.ran) return [];
  if (vision.error) return [`Vision failed to parse/run: ${formatRejectionLabel(vision.error)}`];
  const lines: string[] = [];
  if (vision.correctProduct != null) {
    lines.push(`correct product: ${vision.correctProduct ? "yes" : "no"}`);
  }
  if (vision.bottleProminent != null) {
    lines.push(`bottle prominent: ${vision.bottleProminent ? "yes" : "no"}`);
  }
  if (vision.cleanProductPhoto != null) {
    lines.push(`clean product photo: ${vision.cleanProductPhoto ? "yes" : "no"}`);
  }
  if (vision.containsPeople) lines.push("contains people: yes");
  if (vision.memeOrGraphic) lines.push("meme/graphic: yes");
  return lines;
}

/** Coerce API / storage values that must never be rendered as raw objects (white-screen). */
export function textChild(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function FieldRow({ label, field }: { label: string; field: FieldView | null | undefined }) {
  if (!field) {
    return (
      <div className="enrichment-field enrichment-field-missing">
        <span className="enrichment-field-label">{label}</span>
        <strong className="enrichment-field-value">—</strong>
        <div className="enrichment-field-meta">
          <span className="chip static miss-chip">Missing</span>
        </div>
      </div>
    );
  }
  const alcoholMissing =
    (label === "ABV" || label === "Proof")
    && (field.value == null
      || field.value === ""
      || (typeof field.value === "number" && field.value === 0));
  const value =
    alcoholMissing || field.value == null || field.value === ""
      ? "—"
      : typeof field.value === "number"
        ? String(field.value)
        : textChild(field.value);
  const title =
    field.confidence != null
      ? `${field.sourceLabel ?? "Unknown"} · ${field.confidenceLabel ?? "Unknown"} (${field.confidence})`
      : undefined;
  return (
    <div className={`enrichment-field enrichment-field-${field.status ?? "missing"}`} title={title}>
      <span className="enrichment-field-label">{label}</span>
      <strong className="enrichment-field-value">{value}</strong>
      <div className="enrichment-field-meta">
        {alcoholMissing || field.status === "missing" || !field.status ? (
          <span className="chip static miss-chip">Missing</span>
        ) : (
          <>
            {field.sourceLabel ? <span className="chip static">{field.sourceLabel}</span> : null}
            <span className={`chip static enrichment-band-${field.confidenceBand ?? "none"}`}>
              {field.confidenceLabel ?? "Unknown"}
            </span>
            {field.status === "review" ? <span className="chip static miss-chip">Review</span> : null}
            {field.status === "low_confidence" ? <span className="chip static miss-chip">Low confidence</span> : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Read-only enrichment / review panel for keepers only.
 * Patrons see BottlePublicContent instead — useful notes without plumbing.
 * Does not offer conflict resolution, re-runs, or content edits.
 */

function imageSourceLabel(sourceType: string | null | undefined, verified: boolean | null | undefined): string {
  switch (sourceType) {
    case "user":
      return "User / shelf image";
    case "lookup":
      return "Lookup fallback";
    case "official":
      return "Official enrichment";
    case "licensed":
      return "Licensed enrichment";
    case "approved":
      return "Approved enrichment";
    default:
      return sourceType ? String(sourceType) : "Unknown source";
  }
}

export function EnrichmentPanel({ table, itemId }: { table: string; itemId: number }) {
  const [view, setView] = useState<BottleEnrichmentView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 12_000);

    async function load() {
      try {
        const next = await api<BottleEnrichmentView>(`/inventory/${table}/${itemId}/enrichment`, {
          signal: abort.signal
        });
        if (cancelled) return;
        setView(next);
        setError("");
        setLoading(false);
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        if (shouldPollEnrichment(next.enrichment?.jobs)) {
          timer = setInterval(() => {
            void load();
          }, ENRICHMENT_POLL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setLoading(false);
        if (abort.signal.aborted) {
          setError("Enrichment request timed out");
          return;
        }
        setError(err instanceof Error ? err.message : "Could not load enrichment");
      }
    }

    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      abort.abort();
      if (timer) clearInterval(timer);
    };
  }, [table, itemId]);

  if (!ENRICHMENT_MODULES.has(table)) return null;

  if (loading && !view) {
    return (
      <section className="enrichment-panel">
        <span className="eyebrow">Enrichment</span>
        <p className="muted">Loading enrichment…</p>
      </section>
    );
  }

  if (error && !view) {
    return (
      <section className="enrichment-panel">
        <span className="eyebrow">Enrichment</span>
        <p className="error">{error}</p>
      </section>
    );
  }

  if (!view) return null;

  const enrichment = view.enrichment ?? { identified: false, needsReview: false, missing: [], jobs: [], conflicts: [] };
  const jobs = Array.isArray(enrichment.jobs) ? enrichment.jobs : [];
  const missing = Array.isArray(enrichment.missing) ? enrichment.missing : [];
  const conflicts = Array.isArray(enrichment.conflicts) ? enrichment.conflicts : [];
  const identity = view.identity ?? ({} as BottleEnrichmentView["identity"]);
  const metadata = view.metadata ?? ({} as BottleEnrichmentView["metadata"]);
  const tastingNotes = view.tastingNotes ?? {
    official: null,
    sourceUrl: null,
    sourceType: null,
    houseProfile: null,
    personal: null
  };
  const image = view.image ?? {
    displayUrl: null,
    enrichedUrl: null,
    sourceType: null,
    sourceUrl: null,
    score: null,
    verified: null,
    userPreferred: false
  };
  const houseProfileText = textChild(tastingNotes.houseProfile).trim();
  const officialText = textChild(tastingNotes.official).trim();
  const personalText = textChild(tastingNotes.personal).trim();
  const polling = shouldPollEnrichment(jobs);

  return (
    <section className="enrichment-panel">
      <div className="enrichment-panel-head">
        <div>
          <span className="eyebrow">Enrichment review</span>
          <h2>What the vault knows</h2>
        </div>
        {polling ? <span className="guest-badge">Updating…</span> : null}
      </div>

      {enrichment.needsReview ? (
        <div className="enrichment-review-banner" role="status">
          <strong>Needs review</strong>
          <p>Trusted sources disagree on identity. Kept values are shown; competing values are listed below. Editing is not available here yet.</p>
        </div>
      ) : null}

      <div className="enrichment-jobs">
        {(() => {
          const allIdle = jobs.length > 0 && jobs.every((j) => j.statusLabel === "not_started");
          const anyActive = polling;
          if (!jobs.length) {
            return <p className="muted">No enrichment queued</p>;
          }
          if (allIdle && !anyActive) {
            return <p className="muted">{enrichment.identified ? "Enrichment pending" : "No enrichment queued"}</p>;
          }
          return null;
        })()}
        {jobs.map((job) => {
          const showWhy =
            (job.statusLabel === "no_result" || job.statusLabel === "failed" || job.statusLabel === "partial")
            && (job.diagnosticSummary || job.diagnostics);
          return (
            <div key={job.type} className={`enrichment-job enrichment-job-${job.statusLabel}`}>
              <span>{jobTypeDisplay(job.type)}</span>
              <strong>{jobStatusDisplay(job.statusLabel)}</strong>
              {job.type === "metadata" && job.lastRunLabel ? (
                <small className="enrichment-last-run">Last run: {textChild(job.lastRunLabel)}</small>
              ) : null}
              {job.type === "metadata" && job.stillMissing?.length ? (
                <small className="enrichment-still-missing">
                  Still missing: {job.stillMissing.map((f) => textChild(f)).join(", ")}
                </small>
              ) : null}
              {job.lastError && job.statusLabel === "failed" ? (
                <small title={job.lastError}>Attempt {job.attempts}</small>
              ) : null}
              {showWhy ? (
                <details className="enrichment-diagnostics">
                  <summary>Why?</summary>
                  <p>{textChild(job.diagnosticSummary || job.diagnostics?.summary || "No additional detail")}</p>
                  {job.type === "image" && job.diagnostics?.imageCandidates?.length ? (
                    <div className="enrichment-image-candidates">
                      <ol>
                        {job.diagnostics.imageCandidates.map((c, index) => {
                          const dims =
                            c.width != null && c.height != null
                              ? `${c.width}×${c.height}`
                              : "dimensions unknown";
                          const mime = c.mimeType ? ` · ${c.mimeType}` : "";
                          const sourceLabel = c.sourceType
                            ? c.sourceType.charAt(0).toUpperCase() + c.sourceType.slice(1)
                            : "";
                          const visionLines = visionDetailLines(c.vision);
                          const visionFail = visionSummaryLine(c.vision);
                          const scoreLine =
                            c.score != null
                              ? `Score: ${c.score} / ${c.threshold ?? 75}`
                              : null;
                          const openByDefault =
                            c.stageReached === "verification"
                            || c.stageReached === "scoring"
                            || c.stageReached === "accepted"
                            || Boolean(c.vision?.ran);
                          return (
                            <li key={`${c.urlHost}-${index}`}>
                              <details open={openByDefault}>
                                <summary>
                                  <code>{textChild(c.urlHost)}{textChild(c.urlPath || "")}</code>
                                  {c.accepted
                                    ? " · accepted"
                                    : c.rejectionReasons?.[0]
                                      ? ` · ${formatRejectionLabel(c.rejectionReasons[0])}`
                                      : ""}
                                </summary>
                                <p>
                                  {sourceLabel ? `${sourceLabel} · ` : ""}
                                  {dims}
                                  {mime}
                                </p>
                                {visionFail ? <p>{visionFail}</p> : null}
                                {visionLines.length ? (
                                  <div className="enrichment-vision-details">
                                    <strong>Verification</strong>
                                    <ul>
                                      {visionLines.map((line) => (
                                        <li key={line}>{line}</li>
                                      ))}
                                    </ul>
                                  </div>
                                ) : null}
                                {scoreLine ? <p>{scoreLine}</p> : null}
                                {c.accepted ? (
                                  <p>Accepted</p>
                                ) : c.rejectionReasons?.length ? (
                                  <p>
                                    Rejected:{" "}
                                    {c.rejectionReasons.map(formatRejectionLabel).join(", ")}
                                  </p>
                                ) : null}
                              </details>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  ) : null}
                  {job.diagnostics?.stages?.length ? (
                    <ul>
                      {job.diagnostics.stages
                        .filter((s) => s.stage !== "source_reject")
                        .slice(0, 8)
                        .map((stage, index) => (
                          <li key={`${stage.stage}-${index}`}>
                            <strong>{stage.stage}</strong>
                            {stage.query ? `: ${textChild(stage.query).slice(0, 80)}` : null}
                            {stage.candidateCount != null ? ` · ${stage.candidateCount} results` : null}
                            {stage.acceptedCount != null ? ` · ${stage.acceptedCount} accepted` : null}
                            {stage.reason ? ` · ${textChild(stage.reason)}` : null}
                          </li>
                        ))}
                    </ul>
                  ) : null}
                  {job.diagnostics?.noResultReason ? (
                    <p className="enrichment-diagnostics-reason">
                      Reason: {textChild(job.diagnostics.noResultReason).replace(/_/g, " ")}
                    </p>
                  ) : null}
                </details>
              ) : null}
            </div>
          );
        })}
      </div>

      {missing.length ? (
        <p className="enrichment-missing">
          <span className="eyebrow">Still missing</span>
          {missing.join(", ")}
        </p>
      ) : null}

      <div className="enrichment-section">
        <span className="eyebrow">Identity</span>
        <div className="enrichment-field-grid">
          <FieldRow label="Name" field={identity.name} />
          <FieldRow label="Brand" field={identity.brand} />
          <FieldRow label="Product type" field={identity.productType} />
          <FieldRow label="UPC" field={identity.upc} />
        </div>
      </div>

      <div className="enrichment-section">
        <span className="eyebrow">Product facts</span>
        <div className="enrichment-field-grid">
          <FieldRow label="Category" field={metadata.category} />
          <FieldRow label="ABV" field={metadata.abv} />
          <FieldRow label="Proof" field={metadata.proof} />
          <FieldRow label="Volume (ml)" field={metadata.volumeMl} />
          <FieldRow label="Origin" field={metadata.origin} />
          <FieldRow label="TTB ID" field={metadata.ttbId} />
        </div>
      </div>

      {conflicts.length ? (
        <div className="enrichment-section">
          <span className="eyebrow">Conflicts</span>
          <div className="enrichment-conflicts">
            {conflicts.map((c) => (
              <div key={`${c.field}-${c.competingSource}`} className="enrichment-conflict">
                <strong>{c.field}</strong>
                <p>
                  Kept <em>{textChild(c.keptValue) || "—"}</em> ({c.keptSourceLabel ?? c.keptSource}) vs{" "}
                  <em>{textChild(c.competingValue) || "—"}</em> ({c.competingSourceLabel ?? c.competingSource})
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="enrichment-section enrichment-notes">
        <span className="eyebrow">Tasting notes</span>
        <div className="enrichment-note-card">
          <h3>Official notes</h3>
          {officialText ? (
            <>
              <p>{officialText}</p>
              <div className="enrichment-field-meta">
                {tastingNotes.sourceType ? (
                  <span className="chip static">{textChild(tastingNotes.sourceType)}</span>
                ) : null}
                {tastingNotes.sourceUrl ? (
                  <a className="enrichment-link" href={String(tastingNotes.sourceUrl)} target="_blank" rel="noreferrer">
                    Source
                  </a>
                ) : null}
              </div>
            </>
          ) : (
            <p className="muted">No official producer notes yet.</p>
          )}
        </div>
        <div className="enrichment-note-card enrichment-note-house">
          <h3>AI house profile</h3>
          <p className="enrichment-ai-label">Generated house profile — not producer copy</p>
          {houseProfileText ? (
            <p className="enrichment-house-body">{houseProfileText}</p>
          ) : (
            <p className="muted">No house profile yet.</p>
          )}
        </div>
        {personalText ? (
          <div className="enrichment-note-card">
            <h3>Personal notes</h3>
            <p>{personalText}</p>
          </div>
        ) : null}
      </div>

      <div className="enrichment-section">
        <span className="eyebrow">Product image</span>
        <div className="enrichment-image-row">
          <div className="enrichment-image-frame">
            {image.displayUrl ? (
              <img src={String(image.displayUrl)} alt="" />
            ) : (
              <span className="muted">No image</span>
            )}
          </div>
          <div className="enrichment-image-meta">
            {image.userPreferred ? (
              <span className="chip static">User / shelf image preferred</span>
            ) : null}
            {image.sourceType || image.displayUrl ? (
              <span className="chip static">
                {imageSourceLabel(image.sourceType, image.verified)}
              </span>
            ) : null}
            {image.verified != null ? (
              <span className="chip static">{image.verified ? "Verified" : "Not verified"}</span>
            ) : image.displayUrl ? (
              <span className="chip static">Not verified</span>
            ) : null}
            {image.score != null ? (
              <span className="chip static" title="Deterministic acceptance score">
                Score {Math.round(Number(image.score))}
              </span>
            ) : null}
            {image.sourceUrl ? (
              <a className="enrichment-link" href={String(image.sourceUrl)} target="_blank" rel="noreferrer">
                Image source
              </a>
            ) : null}
            {!image.displayUrl && !image.enrichedUrl ? (
              <p className="muted">No enriched image selected.</p>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
