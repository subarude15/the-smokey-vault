import { useEffect, useState } from "react";
import { BottleWine as Bottle, ChevronRight, LoaderCircle } from "lucide-react";
import { api } from "./api";

export type BottleSearchHit = {
  source: "vault" | "cola_cloud" | "cache" | "fwgs" | "openfoodfacts";
  table: "spirits" | "packaged_beer" | "wines" | "brews";
  ttb_id?: string | null;
  product: Record<string, unknown>;
};

function sourceLabel(hit: BottleSearchHit) {
  if (hit.table === "brews") return "BREWERY LAB";
  if (hit.source === "vault") return "IN YOUR VAULT";
  if (hit.source === "cola_cloud") return "COLA CLOUD";
  if (hit.source === "fwgs") return "FWGS CATALOG";
  if (hit.source === "openfoodfacts") return "OPEN FOOD FACTS";
  if (hit.source === "cache") return "PAST SCAN";
  return hit.source.toUpperCase();
}

export function hitFitsModule(moduleId: string, hit: BottleSearchHit) {
  if (moduleId === "shelf") return hit.table === "spirits" || hit.table === "packaged_beer" || hit.table === "wines";
  if (moduleId === "keg" || moduleId === "taps") return hit.table === "packaged_beer" || hit.table === "brews";
  if (moduleId === "brews") return hit.table === "packaged_beer";
  return hit.table === moduleId;
}

function searchBottlesUrl(query: string, moduleId: string) {
  const params = new URLSearchParams({ q: query });
  if (moduleId) params.set("table", moduleId);
  return `/search/bottles?${params}`;
}

function hitLabel(hit: BottleSearchHit) {
  const name = String(hit.product.name ?? hit.product.product_name ?? hit.product.brewery_batch ?? hit.product.batch_name ?? "Untitled");
  const brand = String(hit.product.brand ?? hit.product.brands ?? hit.product.brewery ?? hit.product.producer ?? hit.product.maker ?? "");
  const category = String(hit.product.category ?? hit.product.categories ?? hit.product.style ?? hit.product.varietal ?? hit.product.status ?? "");
  return { name, brand, category };
}

export function BottleSuggest({
  moduleId,
  query,
  locked,
  onPick
}: {
  moduleId: string;
  query: string;
  locked: string;
  onPick: (hit: BottleSearchHit) => void;
}) {
  const [results, setResults] = useState<BottleSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const q = query.trim();
  const open = q.length >= 2 && q !== locked.trim();

  useEffect(() => {
    if (!open) { setResults([]); return; }
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api<{ results: BottleSearchHit[] }>(searchBottlesUrl(q, moduleId));
        const next = data.results.filter((hit) => hitFitsModule(moduleId, hit)).slice(0, 8);
        setResults(next);
        setActive(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 280);
    return () => window.clearTimeout(timer);
  }, [open, q, moduleId]);

  if (!open) return null;
  if (!loading && !results.length) return null;

  return (
    <div className="suggest-list" role="listbox" aria-label="Bottle suggestions">
      {loading && !results.length ? (
        <div className="suggest-status"><LoaderCircle size={16} className="spinner"/> Looking in the vault and catalogs…</div>
      ) : results.map((hit, index) => {
        const { name, brand, category } = hitLabel(hit);
        return (
          <button
            type="button"
            role="option"
            aria-selected={index === active}
            className={`suggest-item${index === active ? " active" : ""}`}
            key={`${hit.source}-${hit.ttb_id ?? hit.product.id ?? index}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(hit)}
          >
            <div className="card-icon">{hit.product.image_url ? <img src={String(hit.product.image_url)} alt=""/> : <Bottle size={18}/>}</div>
            <div>
              <span className="eyebrow">{sourceLabel(hit)}</span>
              <strong>{name}</strong>
              <small>{[brand, category].filter(Boolean).join(" · ")}</small>
            </div>
            <ChevronRight size={16}/>
          </button>
        );
      })}
    </div>
  );
}
