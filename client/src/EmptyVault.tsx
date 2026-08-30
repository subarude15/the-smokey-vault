import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { api } from "./api";

type PurgeWindow = "1h" | "6h" | "24h" | "all";

type PurgeCounts = {
  spirits: number;
  packaged_beer: number;
  wines: number;
  total: number;
};

const WINDOWS: Array<{ id: PurgeWindow; label: string }> = [
  { id: "1h", label: "Last 1 hour" },
  { id: "6h", label: "Last 6 hours" },
  { id: "24h", label: "Last 24 hours" },
  { id: "all", label: "ALL" }
];

const CONFIRM_WORD = "DELETE";

export function EmptyVault({ onMessage }: { onMessage: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [purgeWindow, setPurgeWindow] = useState<PurgeWindow>("1h");
  const [confirm, setConfirm] = useState("");
  const [preview, setPreview] = useState<PurgeCounts | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    api<PurgeCounts>(`/inventory/purge?window=${purgeWindow}`)
      .then((counts) => { if (!cancelled) setPreview(counts); })
      .catch((err) => {
        if (!cancelled) {
          setPreview(null);
          setError(err instanceof Error ? err.message : "Could not preview the purge");
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, purgeWindow]);

  async function runPurge() {
    if (confirm !== CONFIRM_WORD || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<PurgeCounts>("/inventory/purge", {
        method: "POST",
        body: JSON.stringify({ window: purgeWindow, confirm: CONFIRM_WORD })
      });
      setConfirm("");
      setPreview(result);
      onMessage(
        result.total
          ? `Removed ${result.total} bottle${result.total === 1 ? "" : "s"} from the vault.`
          : "Nothing matched that window."
      );
      const next = await api<PurgeCounts>(`/inventory/purge?window=${purgeWindow}`);
      setPreview(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not empty the vault");
    } finally {
      setBusy(false);
    }
  }

  const ready = confirm === CONFIRM_WORD && !busy && !loading;

  return (
    <section className={`settings-card vault-purge${open ? " vault-purge-open" : ""}`}>
      <button
        type="button"
        className="vault-purge-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <AlertTriangle size={18} aria-hidden />
        <span>
          <span className="eyebrow">Danger zone</span>
          <strong>Empty the vault</strong>
        </span>
        {open ? <ChevronDown size={18} aria-hidden /> : <ChevronRight size={18} aria-hidden />}
      </button>

      {open && (
        <div className="vault-purge-body">
          <p>
            Permanently removes scanned shelf bottles — spirits, packaged beer, and wine.
            Taps, brewery batches, cocktails, guests, and settings stay put. Download a backup first if you might want any of this back.
          </p>
          <div className="chip-row vault-purge-windows" role="group" aria-label="Purge window">
            {WINDOWS.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`chip${purgeWindow === item.id ? " active" : ""}${item.id === "all" ? " vault-purge-all" : ""}`}
                onClick={() => { setPurgeWindow(item.id); setConfirm(""); }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="vault-purge-count" aria-live="polite">
            {loading
              ? "Counting…"
              : preview
                ? <>This will remove <strong>{preview.total}</strong> bottle{preview.total === 1 ? "" : "s"}
                  {preview.total > 0
                    ? ` (${preview.spirits} spirit${preview.spirits === 1 ? "" : "s"}, ${preview.packaged_beer} beer, ${preview.wines} wine)`
                    : ""}.</>
                : "Could not count matching bottles."}
          </p>
          <label>
            <span>Type {CONFIRM_WORD} to confirm</span>
            <input
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={CONFIRM_WORD}
              aria-label={`Type ${CONFIRM_WORD} to confirm`}
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <button
            type="button"
            className="vault-purge-go"
            disabled={!ready || (preview?.total === 0 && !busy)}
            onClick={() => void runPurge()}
          >
            <Trash2 size={17} />
            {busy ? "Deleting…" : purgeWindow === "all" ? "Delete all shelf bottles" : `Delete last ${purgeWindow === "1h" ? "1 hour" : purgeWindow === "6h" ? "6 hours" : "24 hours"}`}
          </button>
        </div>
      )}
    </section>
  );
}
