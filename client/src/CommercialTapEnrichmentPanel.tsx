import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

type CommercialTapEnrichmentView = {
  tapId: number;
  eligible: boolean;
  reason: string | null;
  job: {
    id: number;
    status: string;
    attempts: number;
    lastError: string | null;
    updatedAt: string;
    result: {
      status?: string;
      match?: string;
      reason?: string;
      updatedFields?: string[];
      imageKind?: string;
    } | null;
  } | null;
};

function statusMessage(view: CommercialTapEnrichmentView | null, busy: boolean): string {
  if (busy) return "Looking up official beer details…";
  if (!view) return "";
  if (!view.eligible) {
    if (view.reason === "homebrew_excluded") {
      return "Homebrew taps stay with Brewery Lab — commercial enrichment is skipped.";
    }
    if (view.reason === "tap_empty") return "Put a beer on this tap first.";
    if (view.reason === "maker_and_beer_required") {
      return "Add brewery and beer name, then try again.";
    }
    return "Not eligible for commercial beer enrichment.";
  }
  const job = view.job;
  if (!job) return "Find style, ABV, and artwork from the brewery’s official product page.";
  if (job.status === "pending" || job.status === "running") {
    return "Enrichment queued — results appear when the background job finishes.";
  }
  if (job.status === "failed") {
    return job.lastError || "Enrichment failed. You can try again.";
  }
  const result = job.result;
  if (!result) return "Enrichment finished.";
  if (result.status === "matched") {
    const fields = Array.isArray(result.updatedFields) ? result.updatedFields : [];
    if (fields.length === 0) {
      return "Official beer matched. Existing Keeper values were preserved.";
    }
    return `Official beer matched. Updated: ${fields.join(", ")}.`;
  }
  if (result.status === "no_result") {
    return "No exact official product page found. Existing tap data was left unchanged.";
  }
  return result.reason || "Enrichment finished.";
}

/**
 * Narrow Keeper action for commercial draft taps.
 * Does not reuse EnrichmentPanel (packaged-beer/spirit/wine only).
 */
export function CommercialTapEnrichmentPanel(props: {
  tapId: number;
  sourceType?: string;
  onApplied?: () => void;
}) {
  const source = String(props.sourceType ?? "Commercial").trim() || "Commercial";
  const isHomebrew = /^homebrew$/i.test(source);
  const [view, setView] = useState<CommercialTapEnrichmentView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const next = await api<CommercialTapEnrichmentView>(
        `/inventory/taps/${props.tapId}/enrich-beer`
      );
      setView(next);
      setError("");
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load enrichment status");
      return null;
    }
  }, [props.tapId]);

  useEffect(() => {
    if (isHomebrew) return;
    void refresh();
  }, [isHomebrew, refresh]);

  useEffect(() => {
    if (isHomebrew) return;
    const status = view?.job?.status;
    if (status !== "pending" && status !== "running") return;
    const timer = window.setInterval(() => {
      void (async () => {
        const next = await refresh();
        if (next?.job?.status === "completed" || next?.job?.status === "failed") {
          props.onApplied?.();
        }
      })();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [isHomebrew, view?.job?.status, refresh, props]);

  if (isHomebrew) return null;

  async function queueEnrichment() {
    setBusy(true);
    setError("");
    try {
      await api(`/inventory/taps/${props.tapId}/enrich-beer`, { method: "POST", body: {} });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue enrichment");
    } finally {
      setBusy(false);
    }
  }

  const jobStatus = view?.job?.status ?? "";
  const inFlight = busy || jobStatus === "pending" || jobStatus === "running";
  const canRun = Boolean(view?.eligible) && !inFlight;

  return (
    <section className="enrichment-panel commercial-tap-enrichment">
      <div className="enrichment-panel-head">
        <div>
          <span className="eyebrow">COMMERCIAL TAP</span>
          <h2>Beer details</h2>
        </div>
        {canRun ? (
          <button type="button" className="secondary" disabled={busy} onClick={() => void queueEnrichment()}>
            {view?.job ? "Find beer details again" : "Find beer details"}
          </button>
        ) : null}
      </div>
      <p className="field-hint">{statusMessage(view, inFlight)}</p>
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
