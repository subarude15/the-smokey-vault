import { useCallback, useEffect, useState } from "react";
import { CalendarDays, CircleAlert, Trash2, X } from "lucide-react";
import { api } from "./api";
import {
  parseUtcTimestamp,
  vaultDayDate,
  type PatronDailyVisitLog,
  type PatronVisitHistory
} from "./catalog";

function formatTime(iso: string): string {
  const date = parseUtcTimestamp(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDateTime(iso: string): string {
  const date = parseUtcTimestamp(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export function lastCheckInLabel(iso: string | null | undefined, now = new Date()): string | null {
  if (!iso) return null;
  const date = parseUtcTimestamp(iso);
  if (Number.isNaN(date.getTime())) return null;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `Checked in today at ${formatTime(iso)}`;
  return `Last check-in ${formatDateTime(iso)}`;
}

export function PatronHistoryModal({
  patronId,
  onClose,
  onChanged
}: {
  patronId: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [history, setHistory] = useState<PatronVisitHistory | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(() => {
    api<PatronVisitHistory>(`/patrons/${patronId}/visits`)
      .then((data) => { setHistory(data); setError(""); })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load visit history."));
  }, [patronId]);

  useEffect(() => { load(); }, [load]);

  async function voidVisit(visitId: number) {
    if (!confirm("Remove this recorded check-in? The visit count will drop by one.")) return;
    setBusyId(visitId);
    try {
      await api(`/patrons/${patronId}/visits/${visitId}`, { method: "DELETE" });
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that visit");
    } finally {
      setBusyId(null);
    }
  }

  const patron = history?.patron;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Patron visit history">
      <section className="modal form-modal patron-history-modal">
        <header className="modal-header">
          <div>
            <span className="eyebrow">VISIT HISTORY</span>
            <h2>{patron?.name ?? "Regular"}</h2>
            {patron?.nickname ? <p className="patron-history-nick">“{patron.nickname}”</p> : null}
          </div>
          <button type="button" className="icon-button" aria-label="Close visit history" onClick={onClose}>
            <X size={18}/>
          </button>
        </header>

        {error && <div className="ai-error load-error"><CircleAlert/><div><strong>Could not load history</strong><span>{error}</span></div><button className="secondary" onClick={load}>Retry</button></div>}

        {patron && <div className="patron-history-summary">
          <div><span>Total visits</span><strong>{patron.visit_count}</strong></div>
          <div><span>Last check-in</span><strong>{patron.last_check_in_at ? formatDateTime(patron.last_check_in_at) : "No dated visits yet"}</strong></div>
        </div>}

        <div className="patron-history-list">
          {history && history.legacy_visit_count > 0 && (
            <div className="patron-history-legacy">
              <strong>{history.legacy_visit_count} visit{history.legacy_visit_count === 1 ? "" : "s"} before check-in history</strong>
              <span>Counted on the leaderboard, but no individual timestamps were recorded.</span>
            </div>
          )}
          {history && !history.visits.length && history.legacy_visit_count === 0 && (
            <p className="patron-history-empty">No check-ins recorded yet.</p>
          )}
          {history?.visits.map((visit) => (
            <div key={visit.id} className="patron-history-row">
              <div>
                <strong>{formatDateTime(visit.checked_in_at)}</strong>
                <small>Recorded visit</small>
              </div>
              <button
                type="button"
                className="icon-button danger"
                aria-label={`Remove check-in at ${formatDateTime(visit.checked_in_at)}`}
                disabled={busyId === visit.id}
                onClick={() => void voidVisit(visit.id)}
              >
                <Trash2 size={16}/>
              </button>
            </div>
          ))}
        </div>

        <footer className="modal-footer">
          <button type="button" className="secondary" onClick={onClose}>Back to leaderboard</button>
        </footer>
      </section>
    </div>
  );
}

export function PatronVisitLogModal({
  onClose,
  onOpenPatron
}: {
  onClose: () => void;
  onOpenPatron: (patronId: number) => void;
}) {
  const [date, setDate] = useState(() => vaultDayDate());
  const [log, setLog] = useState<PatronDailyVisitLog | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    const query = date ? `?date=${encodeURIComponent(date)}` : "";
    api<PatronDailyVisitLog>(`/patrons/visits${query}`)
      .then((data) => { setLog(data); setError(""); })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the visit log."));
  }, [date]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Daily visit log">
      <section className="modal form-modal patron-visit-log-modal">
        <header className="modal-header">
          <div>
            <span className="eyebrow">CHECK-IN HISTORY</span>
            <h2>Visit log</h2>
            <p>Vault day rolls at 4:00 AM.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close visit log" onClick={onClose}>
            <X size={18}/>
          </button>
        </header>

        <label className="patron-visit-log-date">
          <span>Vault day</span>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)}/>
        </label>

        {error && <div className="ai-error load-error"><CircleAlert/><div><strong>Could not load the log</strong><span>{error}</span></div><button className="secondary" onClick={load}>Retry</button></div>}

        {log && <div className="patron-visit-log-summary">
          <div><span>Check-ins</span><strong>{log.check_in_count}</strong></div>
          <div><span>Unique visitors</span><strong>{log.unique_visitor_count}</strong></div>
        </div>}

        <div className="patron-history-list">
          {log && !log.visits.length && <p className="patron-history-empty">No check-ins for this vault day.</p>}
          {log?.visits.map((visit) => (
            <button
              key={visit.id}
              type="button"
              className="patron-history-row patron-history-row-link"
              onClick={() => onOpenPatron(visit.patron_id)}
            >
              <div>
                <strong>{visit.name}</strong>
                {visit.nickname ? <small>“{visit.nickname}”</small> : <small>Regular</small>}
              </div>
              <span className="patron-visits">{formatTime(visit.checked_in_at)}</span>
            </button>
          ))}
        </div>

        <footer className="modal-footer">
          <button type="button" className="secondary" onClick={onClose}>Close</button>
        </footer>
      </section>
    </div>
  );
}

export function VisitLogButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="secondary patron-visit-log-open" onClick={onClick}>
      <CalendarDays size={17}/> Visit log
    </button>
  );
}
