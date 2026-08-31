import { useCallback, useEffect, useState } from "react";
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
  audit?: Array<{
    id: number;
    action: string;
    field: string | null;
    jobType: string | null;
    createdAt: string;
  }>;
  verifiedFields?: string[];
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

function FieldRow({
  label,
  field,
  fieldKey,
  admin,
  verified,
  busy,
  onVerify
}: {
  label: string;
  field: FieldView;
  fieldKey: string;
  admin: boolean;
  verified: boolean;
  busy: boolean;
  onVerify: (field: string) => void;
}) {
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
  const canVerify = admin && field.status !== "missing" && !verified;
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
            {verified ? <span className="chip static">Verified</span> : null}
            {field.status === "review" ? <span className="chip static miss-chip">Review</span> : null}
            {field.status === "low_confidence" ? <span className="chip static miss-chip">Low confidence</span> : null}
          </>
        )}
      </div>
      {canVerify ? (
        <button
          type="button"
          className="secondary enrichment-action-btn"
          disabled={busy}
          onClick={() => {
            if (confirm(`Mark ${label} as verified? This pins the current value as keeper-confirmed.`)) {
              onVerify(fieldKey);
            }
          }}
        >
          Mark verified
        </button>
      ) : null}
    </div>
  );
}

/**
 * Enrichment / review panel.
 * Patrons see read-only provenance. Admin sessions get resolve / verify / re-run controls.
 * Patron reviews and gallery uploads remain separate community flows.
 */
export function EnrichmentPanel({
  table,
  itemId,
  admin = false
}: {
  table: string;
  itemId: number;
  admin?: boolean;
}) {
  const [view, setView] = useState<BottleEnrichmentView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const applyView = useCallback((next: BottleEnrichmentView) => {
    setView(next);
    setError("");
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function load() {
      try {
        const next = await api<BottleEnrichmentView>(`/inventory/${table}/${itemId}/enrichment`);
        if (cancelled) return;
        applyView(next);
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
  }, [table, itemId, applyView]);

  async function runAction(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ view?: BottleEnrichmentView }>(path, {
        method: "POST",
        body: JSON.stringify(body)
      });
      if (result.view) applyView(result.view);
      else {
        const next = await api<BottleEnrichmentView>(`/inventory/${table}/${itemId}/enrichment`);
        applyView(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

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
  const verified = new Set(view.verifiedFields ?? []);
  const base = `/inventory/${table}/${itemId}/enrichment`;

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
          <p>
            Trusted sources disagree on identity. Kept values are shown; competing values are listed below.
            {admin ? " Choose which value to keep." : " Unlock Keeper Mode to resolve conflicts."}
          </p>
        </div>
      ) : null}

      <div className="enrichment-jobs">
        {view.enrichment.jobs.map((job) => (
          <div key={job.type} className={`enrichment-job enrichment-job-${job.statusLabel}`}>
            <span>{jobTypeDisplay(job.type)}</span>
            <strong>{jobStatusDisplay(job.statusLabel)}</strong>
            {job.statusLabel === "failed" ? (
              <small title={job.lastError ?? undefined}>
                Attempt {job.attempts}
                {job.lastError ? ` · ${job.lastError.slice(0, 80)}` : ""}
              </small>
            ) : null}
            {admin && (job.statusLabel === "failed" || job.statusLabel === "no_result" || job.statusLabel === "complete" || job.statusLabel === "not_started") ? (
              <button
                type="button"
                className="secondary enrichment-action-btn"
                disabled={busy || job.statusLabel === "waiting" || job.statusLabel === "in_progress"}
                onClick={() => {
                  const label = job.statusLabel === "failed" ? "Retry" : "Run again";
                  if (confirm(`${label} ${jobTypeDisplay(job.type)} enrichment? Existing good data is kept while it runs.`)) {
                    void runAction(`${base}/rerun`, { jobType: job.type });
                  }
                }}
              >
                {job.statusLabel === "failed" ? "Retry" : "Run again"}
              </button>
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
          <FieldRow label="Name" fieldKey="name" field={view.identity.name} admin={admin} verified={verified.has("name")} busy={busy} onVerify={(f) => void runAction(`${base}/verify-field`, { field: f })} />
          <FieldRow label="Brand" fieldKey="brand" field={view.identity.brand} admin={admin} verified={verified.has("brand")} busy={busy} onVerify={(f) => void runAction(`${base}/verify-field`, { field: f })} />
          <FieldRow label="Product type" fieldKey="product_type" field={view.identity.productType} admin={admin} verified={verified.has("product_type")} busy={busy} onVerify={(f) => void runAction(`${base}/verify-field`, { field: f })} />
          <FieldRow label="UPC" fieldKey="upc" field={view.identity.upc} admin={admin} verified={verified.has("upc")} busy={busy} onVerify={(f) => void runAction(`${base}/verify-field`, { field: f })} />
        </div>
      </div>

      <div className="enrichment-section">
        <span className="eyebrow">Product facts</span>
        <div className="enrichment-field-grid">
          <FieldRow label="Category" fieldKey="category" field={view.metadata.category} admin={admin} verified={verified.has("category")} busy={busy} onVerify={(f) => void runAction(`${base}/verify-field`, { field: f })} />
          <FieldRow label="ABV" fieldKey="abv" field={view.metadata.abv} admin={admin} verified={verified.has("abv")} busy={busy} onVerify={(f) => void runAction(`${base}/verify-field`, { field: f })} />
          <FieldRow label="Proof" fieldKey="proof" field={view.metadata.proof} admin={admin} verified={verified.has("proof")} busy={busy} onVerify={(f) => void runAction(`${base}/verify-field`, { field: f })} />
          <FieldRow label="Volume (ml)" fieldKey="volume_ml" field={view.metadata.volumeMl} admin={admin} verified={verified.has("volume_ml")} busy={busy} onVerify={(f) => void runAction(`${base}/verify-field`, { field: f })} />
          <FieldRow label="Origin" fieldKey="origin" field={view.metadata.origin} admin={admin} verified={verified.has("origin")} busy={busy} onVerify={(f) => void runAction(`${base}/verify-field`, { field: f })} />
          <FieldRow label="TTB ID" fieldKey="ttb_id" field={view.metadata.ttbId} admin={admin} verified={verified.has("ttb_id")} busy={busy} onVerify={(f) => void runAction(`${base}/verify-field`, { field: f })} />
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
                  Current: <em>{String(c.keptValue ?? "—")}</em> ({c.keptSourceLabel})
                </p>
                <p>
                  Competing: <em>{String(c.competingValue ?? "—")}</em> ({c.competingSourceLabel})
                </p>
                {admin ? (
                  <div className="enrichment-conflict-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`Keep current ${c.field} value (${String(c.keptValue ?? "—")})?`)) {
                          void runAction(`${base}/resolve-conflict`, { field: c.field, choice: "keep" });
                        }
                      }}
                    >
                      Keep current
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`Accept competing ${c.field} value (${String(c.competingValue ?? "—")})?`)) {
                          void runAction(`${base}/resolve-conflict`, { field: c.field, choice: "accept" });
                        }
                      }}
                    >
                      Use competing value
                    </button>
                  </div>
                ) : null}
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
