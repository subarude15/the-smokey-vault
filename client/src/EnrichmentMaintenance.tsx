import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { api } from "./api";

type EnrichmentBackfillPreview = {
  scanned: number;
  eligible: number;
  metadata: number;
  tastingNotes: number;
  images: number;
  noResultMetadata?: number;
  noResultTastingNotes: number;
  noResultImages: number;
  failedEnrichment: number;
  needsReview: number;
  unidentified: number;
  alreadyComplete: number;
};

type EnrichmentBackfillQueueResult = {
  scanned: number;
  queued: {
    metadata: number;
    tasting_notes: number;
    image: number;
  };
  skipped: {
    needs_review: number;
    unidentified: number;
    complete: number;
  };
};

type LegacyBeerAuditReason =
  | "metadata_no_result"
  | "metadata_partial"
  | "metadata_failed"
  | "metadata_predates_official_pipeline"
  | "no_official_brewery_domain"
  | "historical_machine_metadata"
  | "historical_machine_image"
  | "no_official_notes"
  | "known_official_product_page_without_domain"
  | "official_source_available_but_not_reprocessed";

type LegacyBeerAuditItem = {
  entityId: number;
  name: string;
  brewery: string | null;
  candidate: boolean;
  reasons: LegacyBeerAuditReason[];
  recoveredOfficialDomain: string | null;
};

type LegacyBeerAuditPreview = {
  scanned: number;
  candidates: number;
  reasonCounts: Partial<Record<LegacyBeerAuditReason, number>>;
  items: LegacyBeerAuditItem[];
  truncated: boolean;
};

type LegacyBeerAuditQueueResult = {
  candidates: number;
  queued: number;
  alreadyQueued: number;
  skipped: number;
  domainsBackfilled: number;
  remaining: number;
  auditId: number;
};

type JobType = "metadata" | "tasting_notes" | "image";

const REASON_LABELS: Record<LegacyBeerAuditReason, string> = {
  metadata_no_result: "Old no-result metadata",
  metadata_partial: "Old partial metadata",
  metadata_failed: "Old failed metadata",
  metadata_predates_official_pipeline: "Completed before official brewery pipeline",
  no_official_brewery_domain: "Missing durable official brewery domain",
  historical_machine_metadata: "Historical machine metadata",
  historical_machine_image: "Historical machine image",
  no_official_notes: "Missing official notes",
  known_official_product_page_without_domain: "Official product page without domain",
  official_source_available_but_not_reprocessed: "Official source available, not reprocessed"
};

function totalQueued(result: EnrichmentBackfillQueueResult) {
  return result.queued.metadata + result.queued.tasting_notes + result.queued.image;
}

function previewJobTotal(preview: EnrichmentBackfillPreview, types?: JobType[]) {
  const all = !types?.length;
  let total = 0;
  if (all || types.includes("metadata")) total += preview.metadata;
  if (all || types.includes("tasting_notes")) total += preview.tastingNotes;
  if (all || types.includes("image")) total += preview.images;
  return total;
}

function summarizeLegacyReasons(counts: Partial<Record<LegacyBeerAuditReason, number>>) {
  return (Object.entries(counts) as Array<[LegacyBeerAuditReason, number]>)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
}

export function EnrichmentMaintenance({ onMessage }: { onMessage: (value: string) => void }) {
  const [preview, setPreview] = useState<EnrichmentBackfillPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastQueue, setLastQueue] = useState<EnrichmentBackfillQueueResult | null>(null);
  const [searxngUnreachable, setSearxngUnreachable] = useState(false);

  const [legacyPreview, setLegacyPreview] = useState<LegacyBeerAuditPreview | null>(null);
  const [legacyLoading, setLegacyLoading] = useState(true);
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [legacyError, setLegacyError] = useState("");
  const [legacyExpanded, setLegacyExpanded] = useState(false);
  const [lastLegacyQueue, setLastLegacyQueue] = useState<LegacyBeerAuditQueueResult | null>(null);

  const loadPreview = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const next = await api<EnrichmentBackfillPreview>("/admin/enrichment/backfill");
      setPreview(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load enrichment preview");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLegacyPreview = useCallback(async () => {
    setLegacyError("");
    setLegacyLoading(true);
    try {
      const next = await api<LegacyBeerAuditPreview>("/admin/enrichment/legacy-beer-audit");
      setLegacyPreview(next);
    } catch (err) {
      setLegacyError(err instanceof Error ? err.message : "Could not load legacy beer audit");
    } finally {
      setLegacyLoading(false);
    }
  }, []);

  const loadHealthHint = useCallback(async () => {
    try {
      const health = await api<{
        searxng?: { status?: string };
      }>("/admin/enrichment/health");
      setSearxngUnreachable(health.searxng?.status === "unreachable");
    } catch {
      // Health is advisory only — never block maintenance on a health check failure.
      setSearxngUnreachable(false);
    }
  }, []);

  useEffect(() => {
    void loadPreview();
    void loadLegacyPreview();
    void loadHealthHint();
  }, [loadPreview, loadLegacyPreview, loadHealthHint]);

  async function queue(types?: JobType[]) {
    if (!preview) return;
    const jobCount = previewJobTotal(preview, types);
    if (jobCount === 0) {
      onMessage("Nothing to queue — preview shows no missing enrichment work.");
      return;
    }
    const label = types?.length === 1
      ? types[0] === "metadata"
        ? "metadata"
        : types[0] === "tasting_notes"
          ? "tasting-note"
          : "image"
      : "enrichment";
    if (!window.confirm(`Queue missing ${label} for ${jobCount} job${jobCount === 1 ? "" : "s"}?`)) return;

    setBusy(true);
    setError("");
    try {
      const result = await api<EnrichmentBackfillQueueResult>("/admin/enrichment/backfill", {
        method: "POST",
        body: JSON.stringify(types?.length ? { types } : {})
      });
      setLastQueue(result);
      const queued = totalQueued(result);
      onMessage(`Queued ${queued} enrichment job${queued === 1 ? "" : "s"}. The background worker will process them.`);
      await loadPreview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue enrichment jobs");
    } finally {
      setBusy(false);
    }
  }

  async function queueLegacyAudit() {
    if (!legacyPreview || legacyPreview.candidates === 0) {
      onMessage("No legacy packaged beers need another look.");
      return;
    }
    const count = legacyPreview.candidates;
    if (!window.confirm(
      `Queue legacy beer audit for up to ${Math.min(50, count)} packaged beer${count === 1 ? "" : "s"}? `
      + "This only schedules the existing enrichment pipeline; Keeper-entered values stay protected."
    )) return;

    setLegacyBusy(true);
    setLegacyError("");
    try {
      const result = await api<LegacyBeerAuditQueueResult>("/admin/enrichment/legacy-beer-audit", {
        method: "POST",
        body: JSON.stringify({})
      });
      setLastLegacyQueue(result);
      onMessage(
        `Legacy beer audit queued ${result.queued} metadata job${result.queued === 1 ? "" : "s"}`
        + (result.alreadyQueued ? `, ${result.alreadyQueued} already queued` : "")
        + (result.domainsBackfilled ? `, ${result.domainsBackfilled} domain${result.domainsBackfilled === 1 ? "" : "s"} backfilled` : "")
        + (result.remaining ? `, ${result.remaining} remaining` : "")
        + "."
      );
      await loadLegacyPreview();
      await loadPreview();
    } catch (err) {
      setLegacyError(err instanceof Error ? err.message : "Could not queue legacy beer audit");
    } finally {
      setLegacyBusy(false);
    }
  }

  const jobTotal = preview ? preview.metadata + preview.tastingNotes + preview.images : 0;
  const legacyReasonSummary = legacyPreview
    ? summarizeLegacyReasons(legacyPreview.reasonCounts)
    : [];

  return (
    <section className="settings-card enrichment-maintenance">
      <span className="eyebrow">ENRICHMENT</span>
      <h3>Enrichment maintenance</h3>
      <p>
        Scan shelf bottles and queue missing metadata, tasting-note, and image enrichment jobs.
        This only inserts work into the existing queue — it does not edit inventory directly.
      </p>
      <button type="button" className="secondary enrichment-refresh" disabled={loading || busy} onClick={() => {
        void loadPreview();
        void loadHealthHint();
      }}>
        <RefreshCw size={16}/> {loading ? "Loading preview…" : "Refresh preview"}
      </button>
      {searxngUnreachable ? (
        <p className="enrichment-backfill-warning" role="status">
          Metadata/image enrichment may fail because SearXNG is unavailable.
        </p>
      ) : null}
      {error && <p className="error">{error}</p>}
      {preview && (
        <>
          <dl className="enrichment-backfill-stats">
            <div><dt>Bottles checked</dt><dd>{preview.scanned}</dd></div>
            <div><dt>Missing metadata</dt><dd>{preview.metadata}</dd></div>
            <div><dt>Missing tasting notes</dt><dd>{preview.tastingNotes}</dd></div>
            <div><dt>Missing product images</dt><dd>{preview.images}</dd></div>
            <div><dt>No-result / partial metadata</dt><dd>{preview.noResultMetadata ?? 0}</dd></div>
            <div><dt>No-result tasting notes</dt><dd>{preview.noResultTastingNotes ?? 0}</dd></div>
            <div><dt>No-result product images</dt><dd>{preview.noResultImages ?? 0}</dd></div>
            <div><dt>Failed enrichment</dt><dd>{preview.failedEnrichment ?? 0}</dd></div>
            <div><dt>Needs review</dt><dd>{preview.needsReview}</dd></div>
            <div><dt>Unidentified</dt><dd>{preview.unidentified}</dd></div>
            <div><dt>Already complete</dt><dd>{preview.alreadyComplete}</dd></div>
          </dl>
          {preview.needsReview > 0 && (
            <p className="enrichment-backfill-note">
              {preview.needsReview} bottle{preview.needsReview === 1 ? " is" : "s are"} skipped — review required in bottle detail.
            </p>
          )}
          <div className="enrichment-backfill-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || loading || jobTotal === 0}
              onClick={() => void queue()}
            >
              <Sparkles size={17}/> {busy ? "Queueing…" : `Queue missing enrichment${jobTotal ? ` (${jobTotal})` : ""}`}
            </button>
            <button type="button" className="secondary" disabled={busy || loading || preview.metadata === 0} onClick={() => void queue(["metadata"])}>
              Queue metadata ({preview.metadata})
            </button>
            <button type="button" className="secondary" disabled={busy || loading || preview.tastingNotes === 0} onClick={() => void queue(["tasting_notes"])}>
              Queue tasting notes ({preview.tastingNotes})
            </button>
            <button type="button" className="secondary" disabled={busy || loading || preview.images === 0} onClick={() => void queue(["image"])}>
              Queue images ({preview.images})
            </button>
          </div>
        </>
      )}
      {lastQueue && (
        <p className="enrichment-backfill-banner" aria-live="polite">
          Last run queued {totalQueued(lastQueue)} job{totalQueued(lastQueue) === 1 ? "" : "s"}
          {" "}({lastQueue.queued.metadata} metadata, {lastQueue.queued.tasting_notes} tasting notes, {lastQueue.queued.image} images).
        </p>
      )}

      <div className="legacy-beer-audit">
        <h4>Legacy beer audit</h4>
        <p>
          Older packaged-beer records may have been enriched before the current official brewery pipeline.
          Preview records worth checking again. Queuing an audit only schedules the existing enrichment pipeline;
          Keeper-entered values stay protected.
        </p>
        <button
          type="button"
          className="secondary enrichment-refresh"
          disabled={legacyLoading || legacyBusy}
          onClick={() => void loadLegacyPreview()}
        >
          <RefreshCw size={16}/> {legacyLoading ? "Refreshing preview…" : "Refresh preview"}
        </button>
        {legacyError && <p className="error">{legacyError}</p>}
        {legacyPreview && (
          <>
            <p className="legacy-beer-audit-summary">
              Legacy packaged beers needing another look: <strong>{legacyPreview.candidates}</strong>
              {legacyPreview.truncated ? " (showing first 50)" : ""}
            </p>
            {legacyReasonSummary.length > 0 && (
              <ul className="legacy-beer-audit-reasons">
                {legacyReasonSummary.map(([reason, count]) => (
                  <li key={reason}>{count} {REASON_LABELS[reason]}</li>
                ))}
              </ul>
            )}
            <div className="enrichment-backfill-actions">
              <button
                type="button"
                className="primary"
                disabled={legacyBusy || legacyLoading || legacyPreview.candidates === 0}
                onClick={() => void queueLegacyAudit()}
              >
                <Sparkles size={17}/>
                {legacyBusy
                  ? "Queueing…"
                  : `Queue legacy beer audit (${Math.min(50, legacyPreview.candidates)})`}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={legacyPreview.candidates === 0}
                onClick={() => setLegacyExpanded((open) => !open)}
              >
                {legacyExpanded ? "Hide candidates" : "Show candidates"}
              </button>
            </div>
            {legacyExpanded && legacyPreview.items.length > 0 && (
              <ul className="legacy-beer-audit-list">
                {legacyPreview.items.map((item) => (
                  <li key={item.entityId}>
                    <div className="legacy-beer-audit-item-title">
                      {item.name}{item.brewery ? ` — ${item.brewery}` : ""}
                    </div>
                    <ul>
                      {item.reasons.map((reason) => (
                        <li key={reason}>{REASON_LABELS[reason]}</li>
                      ))}
                    </ul>
                    {item.recoveredOfficialDomain ? (
                      <div className="legacy-beer-audit-domain">
                        Recoverable domain: {item.recoveredOfficialDomain}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {lastLegacyQueue && (
          <p className="enrichment-backfill-banner" aria-live="polite">
            Last legacy audit queued {lastLegacyQueue.queued}
            {" "}(already queued {lastLegacyQueue.alreadyQueued}, skipped {lastLegacyQueue.skipped},
            domains backfilled {lastLegacyQueue.domainsBackfilled}
            {lastLegacyQueue.remaining ? `, remaining ${lastLegacyQueue.remaining}` : ""}).
          </p>
        )}
      </div>
    </section>
  );
}
