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

export type EnrichmentHealthReport = {
  searxng: ServiceHealthResult;
  ollama: ServiceHealthResult;
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
        Quick connectivity check for SearXNG and Ollama. This does not change the enrichment queue
        or retry behavior.
      </p>
      <button
        type="button"
        className="secondary enrichment-refresh"
        disabled={loading}
        onClick={() => void load()}
      >
        <RefreshCw size={16} /> {loading ? "Checking…" : "Check again"}
      </button>
      {error ? <p className="error">{error}</p> : null}
      {report ? (
        <div className="enrichment-health-list" aria-live="polite">
          <ServiceRow name="SearXNG" service={report.searxng} />
          <ServiceRow name="Ollama" service={report.ollama} />
        </div>
      ) : null}
    </section>
  );
}
