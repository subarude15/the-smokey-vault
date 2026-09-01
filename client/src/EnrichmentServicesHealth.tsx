import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "./api";

export type ServiceHealthStatus = "connected" | "unreachable" | "degraded";

export type ServiceHealthResult = {
  status: ServiceHealthStatus;
  host: string;
  latencyMs: number | null;
  error: string | null;
};

export type GovernmentDatasetSnapshotHealth = {
  dataset: "plcb_spirits" | "plcb_wines" | "iowa";
  currentSources: number;
  currentProducts: number;
  currentBarcodes: number;
  extractedAt: string | null;
  importedAt: string | null;
};

export type GovernmentCatalogHealth = {
  exists: boolean;
  path: string;
  dataDir: string;
  dataDirWritable: boolean;
  fileSizeBytes: number | null;
  totals: {
    sources: number;
    products: number;
    barcodes: number;
  };
  currentByDataset: Record<"plcb_spirits" | "plcb_wines" | "iowa", GovernmentDatasetSnapshotHealth>;
  latestExtractedAt: string | null;
  latestImportedAt: string | null;
  lookupOperational: boolean;
  warning: string | null;
};

export type EnrichmentHealthReport = {
  searxng: ServiceHealthResult;
  ollama: ServiceHealthResult;
  governmentCatalog: GovernmentCatalogHealth;
  checkedAt: string;
};

function statusLabel(status: ServiceHealthStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "degraded":
      return "Degraded";
    default:
      return "Unreachable";
  }
}

function ServiceRow({ name, service }: { name: string; service: ServiceHealthResult }) {
  return (
    <div className={`enrichment-health-row enrichment-health-${service.status}`}>
      <div className="enrichment-health-name">{name}</div>
      <div className="enrichment-health-status">
        <strong>{statusLabel(service.status)}</strong>
        {service.latencyMs != null && service.status === "connected" ? (
          <span className="enrichment-health-latency">{service.latencyMs} ms</span>
        ) : null}
      </div>
      <div className="enrichment-health-host">{service.host}</div>
      {service.error ? <div className="enrichment-health-error">{service.error}</div> : null}
    </div>
  );
}

function datasetLabel(dataset: string): string {
  if (dataset === "plcb_spirits") return "PA spirits";
  if (dataset === "plcb_wines") return "PA wines";
  if (dataset === "iowa") return "Iowa";
  return dataset;
}

function GovernmentCatalogPanel({ catalog }: { catalog: GovernmentCatalogHealth }) {
  const status = !catalog.exists
    ? "unreachable"
    : catalog.warning || !catalog.lookupOperational
      ? "degraded"
      : "connected";
  const statusText = !catalog.exists
    ? "Missing"
    : !catalog.lookupOperational
      ? "Not operational"
      : catalog.warning
        ? "Warning"
        : "Ready";

  return (
    <div className={`enrichment-health-row enrichment-health-${status} enrichment-health-catalog`}>
      <div className="enrichment-health-name">Government catalog</div>
      <div className="enrichment-health-status">
        <strong>{statusText}</strong>
        {catalog.lookupOperational ? (
          <span className="enrichment-health-latency">lookup ok</span>
        ) : null}
      </div>
      <div className="enrichment-health-host">{catalog.path}</div>
      <div className="enrichment-health-catalog-meta">
        <div>
          Data dir: {catalog.dataDir} ·{" "}
          {catalog.dataDirWritable ? "writable" : "not writable"}
          {catalog.fileSizeBytes != null
            ? ` · ${(catalog.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB`
            : ""}
        </div>
        <div>
          Totals: {catalog.totals.sources.toLocaleString()} sources ·{" "}
          {catalog.totals.products.toLocaleString()} products ·{" "}
          {catalog.totals.barcodes.toLocaleString()} barcodes
        </div>
        <div>
          Current snapshots:{" "}
          {(["plcb_spirits", "plcb_wines", "iowa"] as const).map((dataset, index) => {
            const snap = catalog.currentByDataset[dataset];
            return (
              <span key={dataset}>
                {index > 0 ? " · " : ""}
                {datasetLabel(dataset)} {snap.currentProducts.toLocaleString()}
              </span>
            );
          })}
        </div>
        <div>
          Latest extract: {catalog.latestExtractedAt ?? "—"} · Latest import:{" "}
          {catalog.latestImportedAt ?? "—"}
        </div>
      </div>
      {catalog.warning ? <div className="enrichment-health-error">{catalog.warning}</div> : null}
    </div>
  );
}

/** Keeper-only enrichment dependency health. */
export function EnrichmentServicesHealth() {
  const [report, setReport] = useState<EnrichmentHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const next = await api<EnrichmentHealthReport>("/admin/enrichment/health");
      setReport(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check enrichment services");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="settings-card enrichment-services-health">
      <span className="eyebrow">ENRICHMENT</span>
      <h3>Enrichment services</h3>
      <p>
        Quick connectivity check for SearXNG and Ollama, plus local government catalog status. This
        does not change the enrichment queue or retry behavior.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {report ? (
        <div className="enrichment-health-list" aria-live="polite">
          <ServiceRow name="SearXNG" service={report.searxng} />
          <ServiceRow name="Ollama" service={report.ollama} />
          {report.governmentCatalog ? (
            <GovernmentCatalogPanel catalog={report.governmentCatalog} />
          ) : null}
        </div>
      ) : loading ? (
        <p className="enrichment-health-pending">Checking services…</p>
      ) : null}
      <button
        type="button"
        className="secondary enrichment-refresh"
        disabled={loading}
        onClick={() => void load()}
      >
        <RefreshCw size={16} /> {loading ? "Checking…" : "Check again"}
      </button>
    </section>
  );
}
