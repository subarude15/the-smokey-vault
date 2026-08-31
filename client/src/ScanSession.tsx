import { useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, RotateCcw, ScanBarcode, XCircle } from "lucide-react";
import { api } from "./api";
import { type ImportKind } from "./catalog";
import { ScanSessionScanner } from "./ScanSessionScanner";
import { playScanFeedback } from "./scan-feedback";

export const SCAN_DUPLICATE_COOLDOWN_MS = 2500;

type ScanSessionAction = "added" | "updated" | "needs_review" | "duplicate" | "failed";

type ScanSessionUndo = {
  table: "spirits" | "packaged_beer" | "wines";
  id: number;
  action: "added" | "updated";
  snapshot: Record<string, unknown>;
};

type ScanSessionSaveResult = {
  action: ScanSessionAction;
  upc: string;
  name: string;
  table: "spirits" | "packaged_beer" | "wines" | null;
  moduleLabel: string;
  message: string;
  quantityField?: string;
  quantityBefore?: number;
  quantityAfter?: number;
  enrichmentQueued: boolean;
  undo?: ScanSessionUndo;
};

type RecentScan = {
  id: number;
  at: number;
  upc: string;
  name: string;
  action: ScanSessionAction;
  message: string;
};

type SessionStats = {
  total: number;
  added: number;
  updated: number;
  needsReview: number;
  failed: number;
};

function emptyStats(): SessionStats {
  return { total: 0, added: 0, updated: 0, needsReview: 0, failed: 0 };
}

function resultLabel(action: ScanSessionAction) {
  if (action === "added") return "Added";
  if (action === "updated") return "Updated";
  if (action === "needs_review") return "Needs review";
  if (action === "duplicate") return "Already scanned";
  return "Failed";
}

function resultIcon(action: ScanSessionAction) {
  if (action === "added" || action === "updated") return <CheckCircle2 size={16}/>;
  if (action === "needs_review" || action === "duplicate") return <CircleAlert size={16}/>;
  return <XCircle size={16}/>;
}

function relativeTime(at: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes === 1 ? "1 min ago" : `${minutes} min ago`;
}

export function ScanSession({
  onFinish,
  onReview
}: {
  onFinish: (summary: SessionStats & { startedAt: number }) => void;
  onReview?: (table: string, id?: number) => void;
}) {
  const [kind, setKind] = useState<ImportKind>("spirits");
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<SessionStats>(() => emptyStats());
  const [recent, setRecent] = useState<RecentScan[]>([]);
  const [lastResult, setLastResult] = useState<ScanSessionSaveResult | null>(null);
  const [lastUndo, setLastUndo] = useState<ScanSessionUndo | null>(null);
  const [error, setError] = useState("");
  const startedAt = useRef(Date.now());
  const lastUpcRef = useRef<{ upc: string; at: number } | null>(null);
  const recentId = useRef(0);

  const elapsed = useMemo(() => {
    const minutes = Math.floor((Date.now() - startedAt.current) / 60_000);
    if (minutes < 1) return "under 1 min";
    return minutes === 1 ? "1 min" : `${minutes} min`;
  }, [stats.total, recent.length]);

  function pushRecent(entry: Omit<RecentScan, "id" | "at">) {
    recentId.current += 1;
    setRecent((current) => [{ id: recentId.current, at: Date.now(), ...entry }, ...current].slice(0, 10));
  }

  function applyStats(action: ScanSessionAction) {
    setStats((current) => ({
      total: current.total + (action === "duplicate" ? 0 : 1),
      added: current.added + (action === "added" ? 1 : 0),
      updated: current.updated + (action === "updated" ? 1 : 0),
      needsReview: current.needsReview + (action === "needs_review" ? 1 : 0),
      failed: current.failed + (action === "failed" ? 1 : 0)
    }));
  }

  async function handleUpc(upc: string) {
    setError("");
    const now = Date.now();
    const last = lastUpcRef.current;
    if (last && last.upc === upc && now - last.at < SCAN_DUPLICATE_COOLDOWN_MS) {
      playScanFeedback("warn");
      setLastResult({
        action: "duplicate",
        upc,
        name: lastResult?.upc === upc ? lastResult.name : upc,
        table: null,
        moduleLabel: "",
        message: "Already scanned — wait a moment before scanning the same bottle again.",
        enrichmentQueued: false
      });
      pushRecent({ upc, name: upc, action: "duplicate", message: "Already scanned" });
      return;
    }
    lastUpcRef.current = { upc, at: now };

    setBusy(true);
    try {
      const result = await api<ScanSessionSaveResult>("/admin/inventory/scan-session/save", {
        method: "POST",
        body: JSON.stringify({ code: upc, kind })
      });
      setLastResult(result);
      setLastUndo(result.undo ?? null);
      applyStats(result.action);
      pushRecent({
        upc: result.upc,
        name: result.name,
        action: result.action,
        message: result.message
      });
      if (result.action === "failed") playScanFeedback("error");
      else if (result.action === "needs_review") playScanFeedback("warn");
      else playScanFeedback("success");
    } catch (err) {
      playScanFeedback("error");
      const message = err instanceof Error ? err.message : "Scan save failed";
      setError(message);
      setLastResult({
        action: "failed",
        upc,
        name: upc,
        table: null,
        moduleLabel: "",
        message,
        enrichmentQueued: false
      });
      applyStats("failed");
      pushRecent({ upc, name: upc, action: "failed", message });
    } finally {
      setBusy(false);
    }
  }

  async function undoLast() {
    if (!lastUndo) return;
    setBusy(true);
    setError("");
    try {
      await api("/admin/inventory/scan-session/undo", {
        method: "POST",
        body: JSON.stringify(lastUndo)
      });
      setLastUndo(null);
      setStats((current) => ({
        ...current,
        total: Math.max(0, current.total - 1),
        added: lastUndo.action === "added" ? Math.max(0, current.added - 1) : current.added,
        updated: lastUndo.action === "updated" ? Math.max(0, current.updated - 1) : current.updated
      }));
      setLastResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not undo the last scan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scan-session">
      <div className="scan-session-header">
        <div>
          <span className="eyebrow">SHELF SCAN</span>
          <h2>Scan inventory</h2>
          <p>Scan → save → next bottle. Enrichment runs in the background.</p>
        </div>
        <div className="scan-session-meta">
          <span>{elapsed}</span>
          <button type="button" className="secondary" onClick={() => onFinish({ ...stats, startedAt: startedAt.current })}>
            Finish scanning
          </button>
        </div>
      </div>

      <div className="scan-session-grid">
        <div className="scan-session-main">
          <ScanSessionScanner
            kind={kind}
            onKindChange={setKind}
            onUpc={handleUpc}
            busy={busy}
            statusHint={busy ? "Saving…" : undefined}
          />
          {lastResult && (
            <article className={`scan-session-result scan-session-result-${lastResult.action}`} aria-live="polite">
              <div className="scan-session-result-head">
                {resultIcon(lastResult.action)}
                <strong>{lastResult.name}</strong>
              </div>
              <p>{lastResult.message}</p>
              {lastResult.action === "added" && lastResult.enrichmentQueued && (
                <p className="scan-session-enrichment">Enrichment queued in background</p>
              )}
              {lastResult.action === "updated" && lastResult.quantityBefore != null && lastResult.quantityAfter != null && (
                <p className="scan-session-quantity">
                  Already in vault · {lastResult.quantityBefore} → {lastResult.quantityAfter}
                </p>
              )}
              {lastResult.action === "needs_review" && onReview && (
                <button type="button" className="secondary" onClick={() => onReview(kind)}>
                  Review now
                </button>
              )}
            </article>
          )}
          {error && <p className="error">{error}</p>}
          <div className="scan-session-actions">
            {lastUndo && (
              <button type="button" className="secondary" disabled={busy} onClick={() => void undoLast()}>
                <RotateCcw size={16}/> Undo last
              </button>
            )}
          </div>
        </div>

        <aside className="scan-session-side">
          <section className="scan-session-stats">
            <h3>Session</h3>
            <dl>
              <div><dt>Total scans</dt><dd>{stats.total}</dd></div>
              <div><dt>Added</dt><dd>{stats.added}</dd></div>
              <div><dt>Updated</dt><dd>{stats.updated}</dd></div>
              <div><dt>Needs review</dt><dd>{stats.needsReview}</dd></div>
              <div><dt>Failed</dt><dd>{stats.failed}</dd></div>
            </dl>
          </section>
          <section className="scan-session-recent">
            <h3>Recent scans</h3>
            {recent.length === 0 ? <p className="scan-session-empty">Nothing scanned yet.</p> : (
              <ol>
                {recent.map((entry) => (
                  <li key={entry.id}>
                    <span className={`scan-session-recent-icon scan-session-recent-${entry.action}`}>
                      {resultIcon(entry.action)}
                    </span>
                    <div>
                      <strong>{entry.name}</strong>
                      <span>{resultLabel(entry.action)} · {relativeTime(entry.at)}</span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

export function ScanSessionSummary({
  summary,
  onClose,
  onOpenMaintenance
}: {
  summary: SessionStats & { startedAt: number };
  onClose: () => void;
  onOpenMaintenance?: () => void;
}) {
  return (
    <section className="scan-session-summary">
      <span className="eyebrow">SHELF SCAN</span>
      <h2>Shelf scan complete</h2>
      <dl>
        <div><dt>Scans</dt><dd>{summary.total}</dd></div>
        <div><dt>Added</dt><dd>{summary.added}</dd></div>
        <div><dt>Updated</dt><dd>{summary.updated}</dd></div>
        <div><dt>Need review</dt><dd>{summary.needsReview}</dd></div>
        <div><dt>Failed</dt><dd>{summary.failed}</dd></div>
      </dl>
      <div className="scan-session-summary-actions">
        <button type="button" className="primary" onClick={onClose}>
          <ScanBarcode size={17}/> Back to inventory
        </button>
        {onOpenMaintenance && summary.needsReview > 0 && (
          <button type="button" className="secondary" onClick={onOpenMaintenance}>
            Open Import Review
          </button>
        )}
      </div>
    </section>
  );
}
