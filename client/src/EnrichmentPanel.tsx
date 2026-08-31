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
  statusLabel: "complete" | "in_progress" | "waiting" | "no_result" | "failed" | "not_started";
  attempts: number;
  lastError: string | null;
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

function FieldRow({ label, field }: { label: string; field: FieldView }) {
  const value =
    field.value == null || field.value === ""
      ? "—"
      : typeof field.value === "number"
        ? String(field.value)
        : String(field.value);
  const title =
    field.confidence != null
      ? `${field.sourceLabel ?? "Unknown"} · ${field.confidenceLabel} (${field.confidence})`
      : undefined;
  return (
    <div className={`enrichment-field enrichment-field-${field.status}`} title={title}>
      <span className="enrichment-field-label">{label}</span>
      <strong className="enrichment-field-value">{value}</strong>
      <div className="enrichment-field-meta">
        {field.status === "missing" ? (
          <span className="chip static miss-chip">Missing</span>
        ) : (
          <>
            {field.sourceLabel ? <span className="chip static">{field.sourceLabel}</span> : null}
            <span className={`chip static enrichment-band-${field.confidenceBand}`}>{field.confidenceLabel}</span>
            {field.status === "review" ? <span className="chip static miss-chip">Review</span> : null}
            {field.status === "low_confidence" ? <span className="chip static miss-chip">Low confidence</span> : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Read-only enrichment / review panel for patrons and keepers.
 * Does not offer conflict resolution, re-runs, or content edits.
 * Patron reviews and gallery uploads remain separate community flows.
 */
export function EnrichmentPanel({ table, itemId }: { table: string; itemId: number }) {
  const [view, setView] = useState<BottleEnrichmentView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function load() {
      try {
        const next = await api<BottleEnrichmentView>(`/inventory/${table}/${itemId}/enrichment`);
        if (cancelled) return;
        setView(next);
        setError("");
        setLoading(false);
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        if (shouldPollEnrichment(next.enrichment.jobs)) {
          timer = setInterval(() => {
            void load();
          }, ENRICHMENT_POLL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : "Could not load enrichment");
      }
    }

    void load();
    return () => {
      cancelled = true;
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

  const polling = shouldPollEnrichment(view.enrichment.jobs);

  return (
    <section className="enrichment-panel">
      <div className="enrichment-panel-head">
        <div>
          <span className="eyebrow">Enrichment review</span>
          <h2>What the vault knows</h2>
        </div>
        {polling ? <span className="guest-badge">Updating…</span> : null}
      </div>

      {view.enrichment.needsReview ? (
        <div className="enrichment-review-banner" role="status">
          <strong>Needs review</strong>
          <p>Trusted sources disagree on identity. Kept values are shown; competing values are listed below. Editing is not available here yet.</p>
        </div>
      ) : null}

      <div className="enrichment-jobs">
        {view.enrichment.jobs.map((job) => (
          <div key={job.type} className={`enrichment-job enrichment-job-${job.statusLabel}`}>
            <span>{jobTypeDisplay(job.type)}</span>
            <strong>{jobStatusDisplay(job.statusLabel)}</strong>
            {job.lastError && job.statusLabel === "failed" ? (
              <small title={job.lastError}>Attempt {job.attempts}</small>
            ) : null}
          </div>
        ))}
      </div>

      {view.enrichment.missing.length ? (
        <p className="enrichment-missing">
          <span className="eyebrow">Still missing</span>
          {view.enrichment.missing.join(", ")}
        </p>
      ) : null}

      <div className="enrichment-section">
        <span className="eyebrow">Identity</span>
        <div className="enrichment-field-grid">
          <FieldRow label="Name" field={view.identity.name} />
          <FieldRow label="Brand" field={view.identity.brand} />
          <FieldRow label="Product type" field={view.identity.productType} />
          <FieldRow label="UPC" field={view.identity.upc} />
        </div>
      </div>

      <div className="enrichment-section">
        <span className="eyebrow">Product facts</span>
        <div className="enrichment-field-grid">
          <FieldRow label="Category" field={view.metadata.category} />
          <FieldRow label="ABV" field={view.metadata.abv} />
          <FieldRow label="Proof" field={view.metadata.proof} />
          <FieldRow label="Volume (ml)" field={view.metadata.volumeMl} />
          <FieldRow label="Origin" field={view.metadata.origin} />
          <FieldRow label="TTB ID" field={view.metadata.ttbId} />
        </div>
      </div>

      {view.enrichment.conflicts.length ? (
        <div className="enrichment-section">
          <span className="eyebrow">Conflicts</span>
          <div className="enrichment-conflicts">
            {view.enrichment.conflicts.map((c) => (
              <div key={`${c.field}-${c.competingSource}`} className="enrichment-conflict">
                <strong>{c.field}</strong>
                <p>
                  Kept <em>{String(c.keptValue ?? "—")}</em> ({c.keptSourceLabel}) vs{" "}
                  <em>{String(c.competingValue ?? "—")}</em> ({c.competingSourceLabel})
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
          {view.tastingNotes.official ? (
            <>
              <p>{view.tastingNotes.official}</p>
              <div className="enrichment-field-meta">
                {view.tastingNotes.sourceType ? (
                  <span className="chip static">{view.tastingNotes.sourceType}</span>
                ) : null}
                {view.tastingNotes.sourceUrl ? (
                  <a className="enrichment-link" href={view.tastingNotes.sourceUrl} target="_blank" rel="noreferrer">
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
          {view.tastingNotes.houseProfile ? (
            <p className="enrichment-house-body">{view.tastingNotes.houseProfile}</p>
          ) : (
            <p className="muted">No house profile yet.</p>
          )}
        </div>
        {view.tastingNotes.personal ? (
          <div className="enrichment-note-card">
            <h3>Personal notes</h3>
            <p>{view.tastingNotes.personal}</p>
          </div>
        ) : null}
      </div>

      <div className="enrichment-section">
        <span className="eyebrow">Product image</span>
        <div className="enrichment-image-row">
          <div className="enrichment-image-frame">
            {view.image.displayUrl ? (
              <img src={view.image.displayUrl} alt="" />
            ) : (
              <span className="muted">No image</span>
            )}
          </div>
          <div className="enrichment-image-meta">
            {view.image.userPreferred ? (
              <span className="chip static">User / shelf image preferred</span>
            ) : null}
            {view.image.sourceType ? (
              <span className="chip static">{view.image.sourceType}</span>
            ) : null}
            {view.image.verified != null ? (
              <span className="chip static">{view.image.verified ? "Verified" : "Unverified"}</span>
            ) : null}
            {view.image.score != null ? (
              <span className="chip static" title="Deterministic acceptance score">
                Score {Math.round(view.image.score)}
              </span>
            ) : null}
            {view.image.sourceUrl ? (
              <a className="enrichment-link" href={view.image.sourceUrl} target="_blank" rel="noreferrer">
                Image source
              </a>
            ) : null}
            {!view.image.displayUrl && !view.image.enrichedUrl ? (
              <p className="muted">No enriched image selected.</p>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
