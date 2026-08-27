import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Plus, ScanBarcode, ScanText, Search, SkipForward, Upload } from "lucide-react";
import { api } from "./api";
import { BottleSuggest, hitFitsModule, type BottleSearchHit } from "./BottleSuggest";
import {
  IMPORT_KIND_LABELS,
  IMPORT_KINDS,
  LOOKUP_SOURCE_LABELS,
  MISS_REASON_LABELS,
  MISS_REASONS,
  lookupHasName,
  type ImportKind,
  type ImportQueueRow,
  type LookupSource,
  type MissReason
} from "./catalog";
import type { ScanResult } from "./Scanner";

type QueuePayload = {
  rows: ImportQueueRow[];
  counts: { pending: number; ready: number; needs_review: number; skipped: number; total: number };
  running: boolean;
};

const EMPTY_COUNTS: QueuePayload["counts"] = { pending: 0, ready: 0, needs_review: 0, skipped: 0, total: 0 };

const TABLE_CHIPS: Array<{ id: ImportKind | "all"; label: string }> = [
  { id: "all", label: "All" },
  ...IMPORT_KINDS.map((id) => ({ id, label: IMPORT_KIND_LABELS[id] }))
];

export function ImportReview({
  focusUpc,
  liveMiss,
  onConfirmHit,
  onManual,
  onSearchPick,
  onRescan
}: {
  focusUpc?: string;
  liveMiss?: ScanResult | null;
  onConfirmHit: (result: ScanResult) => Promise<unknown>;
  onManual: (table: "spirits" | "packaged_beer" | "wines", upc: string) => void;
  onSearchPick: (hit: BottleSearchHit, upc: string) => Promise<void>;
  onRescan?: () => void;
}) {
  const [payload, setPayload] = useState<QueuePayload>({ rows: [], counts: EMPTY_COUNTS, running: false });
  const [kind, setKind] = useState<ImportKind | "all">("all");
  const [reason, setReason] = useState<MissReason | "all">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "ready" | "needs_review" | "skipped">("all");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [openSearch, setOpenSearch] = useState<number | null>(null);
  const [openLabel, setOpenLabel] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (!focusUpc) {
      if (kind !== "all") params.set("kind", kind);
      if (reason !== "all") params.set("reason", reason);
      if (statusFilter !== "all") params.set("status", statusFilter);
    }
    const data = await api<QueuePayload>(`/inventory/import-queue?${params}`);
    setPayload(data);
  }, [kind, reason, statusFilter, focusUpc]);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Could not load Import Review"));
  }, [load]);

  useEffect(() => {
    if (!payload.running) return;
    const timer = window.setInterval(() => { void load(); }, 2500);
    return () => window.clearInterval(timer);
  }, [payload.running, load]);

  const matched = focusUpc
    ? payload.rows.filter((row) => row.upc === focusUpc || (liveMiss != null && row.upc === liveMiss.upc))
    : payload.rows;
  const rows = focusUpc && liveMiss && !matched.length
    ? [liveMissAsRow(liveMiss)]
    : matched;
  const counts = payload.counts;

  async function uploadCsv(file: File) {
    setError("");
    setBusy("Queuing…");
    try {
      const text = await file.text();
      await api("/inventory/import-batch", { method: "POST", body: JSON.stringify({ csv: text }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue that file");
    } finally {
      setBusy("");
    }
  }

  async function commitReady() {
    setError("");
    setBusy("Committing…");
    try {
      const result = await api<{ imported: number }>("/inventory/import-queue/commit", { method: "POST", body: JSON.stringify({}) });
      setBusy("");
      await load();
      if (!result.imported) setError("Nothing Ready to commit.");
    } catch (err) {
      setBusy("");
      setError(err instanceof Error ? err.message : "Commit failed");
    }
  }

  async function skipRow(id: number) {
    await api(`/inventory/import-queue/${id}/skip`, { method: "POST", body: "{}" });
    await load();
  }

  return (
    <section className="scan-stage import-review">
      {!focusUpc && <>
        <div className="import-upload">
          <label className="secondary wide file-button">
            <Upload size={16}/> Drop a CSV of UPCs
            <input ref={fileRef} type="file" accept=".csv,text/csv,application/json,.json,text/plain" onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadCsv(file);
            }}/>
          </label>
          <p className="scanner-hint">Overnight list-only lookups. Empty photos still count as Ready. Commit writes Ready rows only.</p>
        </div>
        <div className="import-sticky" aria-live="polite">
          <span><strong>{counts.ready}</strong> Ready</span>
          <span><strong>{counts.needs_review}</strong> Needs review</span>
          <span><strong>{counts.skipped}</strong> Skipped</span>
          {payload.running ? <span className="muted">Looking up…</span> : null}
          <button type="button" className="primary" disabled={!counts.ready || Boolean(busy)} onClick={() => void commitReady()}>
            Commit Ready
          </button>
        </div>
        <div className="chip-row">
          {TABLE_CHIPS.map((item) => (
            <button type="button" key={item.id} className={kind === item.id ? "chip active" : "chip"} onClick={() => setKind(item.id)}>{item.label}</button>
          ))}
        </div>
        <div className="chip-row">
          <button type="button" className={reason === "all" ? "chip active" : "chip"} onClick={() => setReason("all")}>All misses</button>
          {MISS_REASONS.map((id) => (
            <button type="button" key={id} className={reason === id ? "chip active" : "chip"} onClick={() => setReason(id)}>{MISS_REASON_LABELS[id]}</button>
          ))}
        </div>
        <div className="chip-row">
          {(["all", "ready", "needs_review", "skipped"] as const).map((id) => (
            <button type="button" key={id} className={statusFilter === id ? "chip active" : "chip"} onClick={() => setStatusFilter(id)}>
              {id === "all" ? "All rows" : id === "needs_review" ? "Needs review" : id === "ready" ? "Ready" : "Skipped"}
            </button>
          ))}
        </div>
      </>}
      {focusUpc && <p className="scanner-hint">Miss for UPC <strong className="upc-chip">{focusUpc}</strong>. Scan label only lives here — never on a hit.</p>}
      {error && <p className="error">{error}</p>}
      {busy && <p className="scanner-status">{busy}</p>}
      <div className="import-rows">
        {rows.map((row) => (
          <ImportRow
            key={row.id}
            row={row}
            searching={openSearch === row.id}
            labeling={openLabel === row.id}
            onSearch={() => setOpenSearch((current) => current === row.id ? null : row.id)}
            onLabel={() => setOpenLabel((current) => current === row.id ? null : row.id)}
            onSkip={() => { if (row.id > 0) void skipRow(row.id); }}
            onManual={() => onManual(row.table, row.upc)}
            onSearchPick={async (hit) => {
              await onSearchPick(hit, row.upc);
              if (row.id > 0) await skipRow(row.id);
            }}
            onLabelRead={async (result) => {
              await load();
              if (lookupHasName(result.product)) await onConfirmHit(result);
            }}
            onRescan={onRescan}
          />
        ))}
        {!rows.length && <p className="scanner-hint">{payload.running ? "Lookups are still running." : "Nothing in this filter."}</p>}
      </div>
      {focusUpc && onRescan ? (
        <div className="scan-miss-actions">
          <button type="button" className="secondary" onClick={onRescan}><ScanBarcode size={16}/> Scan another</button>
        </div>
      ) : null}
    </section>
  );
}

function liveMissAsRow(miss: ScanResult): ImportQueueRow {
  return {
    id: 0,
    upc: miss.upc,
    kind: miss.kind ?? "spirits",
    table: miss.table ?? "spirits",
    status: "needs_review",
    reason: miss.reason ?? "no_catalog",
    source: miss.source,
    product: miss.product ?? { upc: miss.upc },
    message: miss.message ?? "",
    variants: miss.variants ?? null,
    created_at: "",
    updated_at: ""
  };
}

function ImportRow({
  row, searching, labeling, onSearch, onLabel, onSkip, onManual, onSearchPick, onLabelRead, onRescan
}: {
  row: ImportQueueRow;
  searching: boolean;
  labeling: boolean;
  onSearch: () => void;
  onLabel: () => void;
  onSkip: () => void;
  onManual: () => void;
  onSearchPick: (hit: BottleSearchHit) => Promise<void>;
  onLabelRead: (result: ScanResult) => Promise<void>;
  onRescan?: () => void;
}) {
  const miss = row.status === "needs_review" || row.status === "pending";
  const sourceLabel = LOOKUP_SOURCE_LABELS[row.source as LookupSource] ?? row.source;
  return (
    <article className={`import-row ${row.status}`}>
      <header>
        <strong className="upc-chip">{row.upc || "—"}</strong>
        <span className="chip static">{IMPORT_KIND_LABELS[row.kind]}</span>
        {row.status === "ready" && row.source !== "not_found" ? <span className="chip static source-chip">{sourceLabel}</span> : null}
        {row.reason ? <span className="chip static miss-chip">{MISS_REASON_LABELS[row.reason]}</span> : null}
      </header>
      <p>{row.message || (lookupHasName(row.product) ? String(row.product.name) : "Waiting on a name.")}</p>
      {row.reason === "variant" && row.variants ? (
        <p className="scanner-hint">UPC-A {row.variants.upcA} · EAN-13 {row.variants.ean13}</p>
      ) : null}
      {miss && row.reason !== "invalid" && (
        <div className="import-row-actions">
          <button type="button" className="secondary" onClick={onSearch}><Search size={16}/> Search name</button>
          <button type="button" className="secondary" onClick={onLabel}><ScanText size={16}/> Scan label</button>
          <button type="button" className="secondary" onClick={onManual}><Plus size={16}/> Manual add</button>
          <button type="button" className="secondary" onClick={onSkip}><SkipForward size={16}/> Skip</button>
        </div>
      )}
      {miss && row.reason === "invalid" && (
        <div className="import-row-actions">
          {onRescan ? <button type="button" className="primary" onClick={onRescan}><ScanBarcode size={16}/> Rescan</button> : null}
          <button type="button" className="secondary" onClick={onSkip}><SkipForward size={16}/> Skip</button>
        </div>
      )}
      {searching && <NameSearch upc={row.upc} table={row.table} onPick={onSearchPick}/>}
      {labeling && <MissLabelCapture row={row} onUseLabel={onLabelRead} onPick={onSearchPick}/>}
    </article>
  );
}

function NameSearch({
  upc, table, onPick
}: {
  upc: string;
  table: "spirits" | "packaged_beer" | "wines";
  onPick: (hit: BottleSearchHit) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [locked, setLocked] = useState("");
  return (
    <div className="import-search">
      <label className="search finder-search"><Search/><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Eagle Rare, Lagavulin, Champagne…"/></label>
      <BottleSuggest
        moduleId={table}
        query={query}
        locked={locked}
        onPick={async (hit) => {
          if (!hitFitsModule(table, hit)) return;
          setLocked(String(hit.product.name ?? query));
          await onPick(hit);
        }}
      />
      <p className="scanner-hint">Kept UPC <strong className="upc-chip">{upc}</strong>.</p>
    </div>
  );
}

function MissLabelCapture({
  row,
  onUseLabel,
  onPick
}: {
  row: ImportQueueRow;
  onUseLabel: (result: ScanResult) => Promise<void>;
  onPick: (hit: BottleSearchHit) => Promise<void>;
}) {
  const [status, setStatus] = useState("Line up the front label.");
  const [busy, setBusy] = useState(false);
  const [labelResult, setLabelResult] = useState<ScanResult | null>(null);
  const [suggestions, setSuggestions] = useState<BottleSearchHit[]>([]);

  async function send(file: Blob) {
    setBusy(true);
    setStatus("Reading the label…");
    setLabelResult(null);
    setSuggestions([]);
    try {
      const body = new FormData();
      body.append("image", file, "label.jpg");
      const path = row.id > 0 ? `/inventory/import-queue/${row.id}/label` : "/ai/vision-label";
      const data = await api<ScanResult>(path, { method: "POST", body });
      if (!lookupHasName(data.product)) {
        setStatus("Couldn’t read a name. Try a little closer.");
        setBusy(false);
        return;
      }
      const nextSuggestions = (data.suggestions ?? []) as BottleSearchHit[];
      const result = { ...data, source: "label" as const, upc: row.upc || data.upc, product: data.product ?? {} };
      setLabelResult(result);
      setSuggestions(nextSuggestions);
      setStatus(nextSuggestions.length
        ? `Read “${String(data.product?.name ?? "label")}”. Pick a catalog match or use the label read.`
        : `Read “${String(data.product?.name ?? "label")}”.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not read that label");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="import-label">
      <label className="primary wide file-button">
        <Camera size={16}/> {busy ? "Reading…" : "Scan label"}
        <input type="file" accept="image/*" capture="environment" disabled={busy} onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void send(file);
        }}/>
      </label>
      <p className="scanner-status">{status}</p>
      {labelResult ? (
        <div className="scan-miss-actions">
          <button type="button" className="primary" onClick={() => void onUseLabel(labelResult)}>Use label read</button>
        </div>
      ) : null}
      {suggestions.length ? (
        <div className="scan-miss finder-results">
          {suggestions.map((hit, index) => {
            const name = String(hit.product.name ?? "Untitled");
            const brewery = String(hit.product.brewery ?? hit.product.brand ?? "");
            const style = String(hit.product.style ?? hit.product.category ?? "");
            return (
              <button type="button" key={`${hit.catalog_beer_id ?? index}`} className="secondary wide" onClick={() => void onPick(hit)}>
                {name}{brewery ? ` · ${brewery}` : ""}{style ? ` · ${style}` : ""}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
