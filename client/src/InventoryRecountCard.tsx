import { useCallback, useEffect, useState } from "react";
import { RotateCcw, ScanBarcode } from "lucide-react";
import { api } from "./api";

export type RecountShelfTable = "spirits" | "wines" | "packaged_beer";

type SectionStats = {
  totalRows: number;
  inStockRows: number;
  zeroStockRows: number;
};

type RecountPreview = {
  sections: Record<RecountShelfTable, SectionStats>;
  totals: SectionStats;
};

type ZeroCountsResult = {
  tables: RecountShelfTable[];
  updatedRows: Record<RecountShelfTable, number>;
  totalUpdated: number;
  preview: RecountPreview;
};

const SECTION_OPTIONS: Array<{
  id: RecountShelfTable;
  label: string;
  detail: string;
}> = [
  {
    id: "spirits",
    label: "Spirits & Mixers",
    detail: "Sets bottle count and fill to 0; scanning a bottle back in sets it to 1 full bottle."
  },
  {
    id: "wines",
    label: "Wine Cellar",
    detail: "Sets bottle count to 0 while keeping vintages, varietals, pairings, and notes."
  },
  {
    id: "packaged_beer",
    label: "Packaged Beer",
    detail: "Sets cold-room count to 0 while keeping breweries, styles, UPCs, and artwork."
  }
];

export function InventoryRecountCard({
  onMessage,
  onStartScan
}: {
  onMessage?: (value: string) => void;
  onStartScan?: () => void;
}) {
  const [preview, setPreview] = useState<RecountPreview | null>(null);
  const [selected, setSelected] = useState<Record<RecountShelfTable, boolean>>({
    spirits: true,
    wines: true,
    packaged_beer: true
  });
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastResult, setLastResult] = useState<ZeroCountsResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setPreview(await api<RecountPreview>("/admin/inventory/recount-preview"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load shelf recount summary");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const chosenTables = SECTION_OPTIONS
    .filter((option) => selected[option.id])
    .map((option) => option.id);

  function toggleSection(table: RecountShelfTable) {
    setConfirming(false);
    setSelected((current) => ({ ...current, [table]: !current[table] }));
  }

  async function runZeroCounts() {
    if (!chosenTables.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<ZeroCountsResult>("/admin/inventory/zero-counts", {
        method: "POST",
        body: JSON.stringify({ tables: chosenTables, confirm: "ZERO" })
      });
      setPreview(result.preview);
      setLastResult(result);
      setConfirming(false);
      onMessage?.(
        result.totalUpdated === 1
          ? "Zeroed 1 shelf record. Ready to scan inventory back in."
          : `Zeroed ${result.totalUpdated} shelf records. Ready to scan inventory back in.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not zero shelf counts");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card inventory-recount-card">
      <span className="eyebrow">PHYSICAL RE-INVENTORY</span>
      <h3>Zero shelf counts</h3>
      <p>
        Reset selected shelf counts to 0 before a full bar audit. Every bottle record, UPC, photo,
        tasting profile, enrichment history, review, and vote stays intact so scanning restores stock cleanly.
        Draft Taps and Homebrew Log are never touched.
      </p>

      <div className="recount-section-list" style={{ display: "grid", gap: 8, margin: "12px 0" }}>
        {SECTION_OPTIONS.map((option) => {
          const stats = preview?.sections[option.id];
          return (
            <label key={option.id} className="toggle-field">
              <input
                type="checkbox"
                checked={selected[option.id]}
                disabled={busy}
                onChange={() => toggleSection(option.id)}
              />
              <span>
                <strong>
                  {option.label}
                  {stats
                    ? ` · ${stats.inStockRows} in stock (${stats.totalRows} saved)`
                    : ""}
                </strong>
                <small>{option.detail}</small>
              </span>
            </label>
          );
        })}
      </div>

      {error ? <p className="error" role="alert">{error}</p> : null}

      {!confirming ? (
        <div className="chip-row" style={{ gap: 8 }}>
          <button
            type="button"
            className="secondary danger"
            disabled={loading || busy || chosenTables.length === 0}
            onClick={() => setConfirming(true)}
          >
            <RotateCcw size={16}/> Zero selected counts…
          </button>
          {onStartScan ? (
            <button type="button" className="secondary" onClick={onStartScan}>
              <ScanBarcode size={16}/> Open Shelf Scan
            </button>
          ) : null}
        </div>
      ) : (
        <div className="cleanup-findings" role="region" aria-label="Confirm zeroing shelf counts">
          <h4>Zero counts on {chosenTables.length === 1 ? "1 section" : `${chosenTables.length} sections`}?</h4>
          <p>
            Selected items will show as Out of stock to guests, stay off automatic Restock, and remain
            available under Keeper Mode’s <strong>0 in stock</strong> filter until scanned back in.
          </p>
          <div className="chip-row" style={{ gap: 8, marginTop: 10 }}>
            <button
              type="button"
              className="secondary danger"
              disabled={busy}
              onClick={() => void runZeroCounts()}
            >
              {busy ? "Zeroing…" : "Confirm zero counts"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {lastResult ? (
        <small className="field-hint">
          Zeroed {lastResult.totalUpdated} {lastResult.totalUpdated === 1 ? "item" : "items"}.
          {" "}Now walk the shelves with Shelf Scan — each scan adds 1 full bottle back to its existing record.
        </small>
      ) : null}
    </section>
  );
}
