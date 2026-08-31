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

type JobType = "metadata" | "tasting_notes" | "image";

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

export function EnrichmentMaintenance({ onMessage }: { onMessage: (value: string) => void }) {
  const [preview, setPreview] = useState<EnrichmentBackfillPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastQueue, setLastQueue] = useState<EnrichmentBackfillQueueResult | null>(null);
  const [searxngUnreachable, setSearxngUnreachable] = useState(false);

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
    void loadHealthHint();
  }, [loadPreview, loadHealthHint]);

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

  const jobTotal = preview ? preview.metadata + preview.tastingNotes + preview.images : 0;

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
    </section>
  );
}
