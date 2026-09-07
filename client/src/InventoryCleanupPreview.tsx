import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "./api";

type CleanupPreview = {
  readOnly: true;
  inventory: { spirits: number; wines: number; packaged_beer: number; total: number };
  invalidPackagedBeerBarcodes: {
    count: number;
    items: Array<{ entityId: number; name: string; brewery: string; upc: string }>;
    truncated: boolean;
  };
  orphanedArtifacts: {
    total: number;
    byTable: Record<string, number>;
    truncated: boolean;
  };
  enrichmentJobs: { pending: number; running: number; failed: number };
  unreferencedLookupCache: { total: number; byTable: Record<string, number> };
  unlinkedImportReview: number;
};

const ARTIFACT_LABELS: Record<string, string> = {
  enrichment_jobs: "jobs",
  product_content: "content",
  product_images: "images",
  product_field_ownership: "field ownership",
  enrichment_sources: "sources",
  official_image_repair_requests: "image repairs"
};

export function InventoryCleanupPreview() {
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setPreview(await api<CleanupPreview>("/admin/inventory/cleanup-preview"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load inventory data health");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const artifactSummary = preview
    ? Object.entries(preview.orphanedArtifacts.byTable)
      .filter(([, count]) => count > 0)
      .map(([table, count]) => `${count} ${ARTIFACT_LABELS[table] ?? table}`)
      .join(" · ")
    : "";

  return (
    <section className="settings-card inventory-cleanup-preview">
      <span className="eyebrow">DATA HEALTH</span>
      <h3>Inventory cleanup preview</h3>
      <p>
        Check for invalid packaged-beer barcodes, enrichment records without a bottle,
        and reusable lookup rows not referenced by the current shelf. Read-only — nothing is deleted.
      </p>
      <button type="button" className="secondary enrichment-refresh" disabled={loading} onClick={() => void load()}>
        <RefreshCw size={16}/> {loading ? "Checking…" : "Run check again"}
      </button>
      {error && <p className="error">{error}</p>}
      {preview && <>
        <dl className="enrichment-backfill-stats">
          <div><dt>Shelf bottles</dt><dd>{preview.inventory.total}</dd></div>
          <div><dt>Invalid beer barcodes</dt><dd>{preview.invalidPackagedBeerBarcodes.count}</dd></div>
          <div><dt>Orphaned enrichment rows</dt><dd>{preview.orphanedArtifacts.total}</dd></div>
          <div><dt>Unreferenced lookup rows</dt><dd>{preview.unreferencedLookupCache.total}</dd></div>
          <div><dt>Import Review only</dt><dd>{preview.unlinkedImportReview}</dd></div>
          <div><dt>Running jobs</dt><dd>{preview.enrichmentJobs.running}</dd></div>
        </dl>
        <p className="enrichment-backfill-note">
          Shelf: {preview.inventory.spirits} spirits · {preview.inventory.wines} wines · {preview.inventory.packaged_beer} packaged beers.
          {artifactSummary ? ` Orphans: ${artifactSummary}.` : " No orphaned enrichment records found."}
        </p>
        {preview.invalidPackagedBeerBarcodes.items.length > 0 && <div className="cleanup-findings">
          <h4>Packaged beers needing barcode review</h4>
          <ul>
            {preview.invalidPackagedBeerBarcodes.items.map((item) => <li key={item.entityId}>
              <strong>{item.name}</strong>{item.brewery ? ` — ${item.brewery}` : ""} <code>{item.upc}</code>
            </li>)}
          </ul>
          {preview.invalidPackagedBeerBarcodes.truncated && <small>Showing the first 50.</small>}
        </div>}
        <small className="field-hint">
          Unreferenced lookup rows may still be useful for future scans. This report does not call them safe to delete.
        </small>
      </>}
    </section>
  );
}
