import { useEffect, useId, useRef, useState } from "react";
import { BottleWine as Bottle, ChevronRight, LoaderCircle, Plus } from "lucide-react";
import { api } from "./api";
import {
  BOTTLE_SUGGEST_DEBOUNCE_MS,
  BOTTLE_SUGGEST_MAX_RESULTS,
  clampActiveIndex,
  mapSuggestKey,
  moveActiveIndex,
  runBottleSuggestSearch,
  shouldOpenBottleSuggest,
  suggestListId,
  suggestOptionId,
  suggestStatusId,
  suggestStatusText,
  type BottleSuggestStatus
} from "./bottleSuggestLogic";

export type BottleSearchHit = {
  source: "vault" | "cola_cloud" | "catalog_beer" | "beer_cache" | "cache" | "fwgs" | "openfoodfacts";
  table: "spirits" | "packaged_beer" | "wines" | "brews";
  ttb_id?: string | null;
  catalog_beer_id?: string | null;
  product: Record<string, unknown>;
};

function sourceLabel(hit: BottleSearchHit) {
  if (hit.table === "brews") return "BREWERY LAB";
  if (hit.source === "vault") return "IN YOUR VAULT";
  if (hit.source === "beer_cache") return "BEER CACHE";
  if (hit.source === "catalog_beer") return "CATALOG.BEER";
  if (hit.source === "cola_cloud") return "COLA CLOUD";
  if (hit.source === "fwgs") return "FWGS CATALOG";
  if (hit.source === "openfoodfacts") return "OPEN FOOD FACTS";
  if (hit.source === "cache") return "PAST SCAN";
  return "UNKNOWN";
}

function suggestLoadingCopy(moduleId: string) {
  if (
    moduleId === "packaged_beer" ||
    moduleId === "taps" ||
    moduleId === "keg" ||
    moduleId === "brews" ||
    moduleId === "shelf"
  ) {
    return "Looking in vault, cache, and Catalog.beer…";
  }
  return "Looking in the vault and catalogs…";
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
  const name = String(
    hit.product.name ?? hit.product.product_name ?? hit.product.brewery_batch ?? hit.product.batch_name ?? "Untitled"
  );
  const brand = String(
    hit.product.brand ?? hit.product.brands ?? hit.product.brewery ?? hit.product.producer ?? hit.product.maker ?? ""
  );
  const category = String(
    hit.product.category ?? hit.product.categories ?? hit.product.style ?? hit.product.varietal ?? hit.product.status ?? ""
  );
  return { name, brand, category };
}

export function BottleSuggest({
  moduleId,
  query,
  locked,
  onPick,
  allowCustomAdd = false,
  onCustomAdd
}: {
  moduleId: string;
  query: string;
  locked: string;
  onPick: (hit: BottleSearchHit) => void;
  /** When true and onCustomAdd is set, show an explicit manual-add action (not a search hit). */
  allowCustomAdd?: boolean;
  onCustomAdd?: (query: string) => void;
}) {
  const reactId = useId().replace(/:/g, "");
  const listId = suggestListId(reactId);
  const statusId = suggestStatusId(reactId);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const abortRef = useRef<AbortController | null>(null);
  const latestRequestIdRef = useRef(0);
  const onPickRef = useRef(onPick);
  const onCustomAddRef = useRef(onCustomAdd);
  onPickRef.current = onPick;
  onCustomAddRef.current = onCustomAdd;

  const [results, setResults] = useState<BottleSearchHit[]>([]);
  const [status, setStatus] = useState<BottleSuggestStatus>("idle");
  const [active, setActive] = useState(-1);
  const [dismissed, setDismissed] = useState(false);

  const q = query.trim();
  const searchable = shouldOpenBottleSuggest(query, locked);
  const showCustom = Boolean(allowCustomAdd && onCustomAdd && q.length > 0 && searchable);
  const open =
    searchable &&
    !dismissed &&
    (status === "loading" || status === "ready" || status === "empty" || status === "error" || showCustom);

  const closeList = () => {
    setDismissed(true);
    setActive(-1);
  };

  const pickHit = (hit: BottleSearchHit) => {
    closeList();
    setResults([]);
    setStatus("idle");
    onPickRef.current(hit);
  };

  const pickCustom = () => {
    if (!onCustomAddRef.current) return;
    closeList();
    setResults([]);
    setStatus("idle");
    onCustomAddRef.current(q);
  };

  useEffect(() => {
    setDismissed(false);
    setActive(-1);
  }, [q, moduleId]);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    if (!searchable) {
      setResults([]);
      setStatus("idle");
      setActive(-1);
      return;
    }

    const timer = window.setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;
      const requestId = ++latestRequestIdRef.current;
      setStatus("loading");

      void runBottleSuggestSearch({
        requestId,
        getLatestRequestId: () => latestRequestIdRef.current,
        signal: controller.signal,
        fetch: (signal) =>
          api<{ results: BottleSearchHit[] }>(searchBottlesUrl(q, moduleId), { signal }),
        onSuccess: (data) => {
          const next = data.results
            .filter((hit) => hitFitsModule(moduleId, hit))
            .slice(0, BOTTLE_SUGGEST_MAX_RESULTS);
          setResults(next);
          setActive(next.length ? 0 : -1);
          setStatus(next.length ? "ready" : "empty");
        },
        onError: () => {
          setResults([]);
          setActive(-1);
          setStatus("error");
        }
      });
    }, BOTTLE_SUGGEST_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [searchable, q, moduleId]);

  useEffect(() => {
    setActive((current) => clampActiveIndex(current, results.length));
  }, [results.length]);

  useEffect(() => {
    const root = rootRef.current;
    const input = root?.parentElement?.querySelector("input") as HTMLInputElement | null;
    if (!input) return;

    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", listId);
    input.setAttribute("aria-haspopup", "listbox");
    input.setAttribute("aria-expanded", open ? "true" : "false");
    if (open && active >= 0 && results.length > 0) {
      input.setAttribute("aria-activedescendant", suggestOptionId(reactId, active));
    } else {
      input.removeAttribute("aria-activedescendant");
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const action = mapSuggestKey(event.key, {
        open,
        hasCustomAdd: showCustom,
        activeIndex: active,
        resultCount: results.length
      });
      if (action.type === "none") return;

      if (action.type === "move") {
        event.preventDefault();
        setActive((current) => moveActiveIndex(current, results.length, action.direction));
        return;
      }
      if (action.type === "select") {
        const hit = results[active];
        if (!hit) return;
        event.preventDefault();
        pickHit(hit);
        return;
      }
      if (action.type === "custom") {
        event.preventDefault();
        pickCustom();
        return;
      }
      if (action.type === "close") {
        event.preventDefault();
        closeList();
      }
    };

    input.addEventListener("keydown", onKeyDown);
    return () => {
      input.removeEventListener("keydown", onKeyDown);
      input.removeAttribute("aria-activedescendant");
      input.setAttribute("aria-expanded", "false");
    };
  }, [open, active, results, showCustom, listId, reactId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      const wrap = root?.parentElement;
      const target = event.target as Node | null;
      if (!target) return;
      if (wrap?.contains(target)) return;
      closeList();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (active < 0) return;
    optionRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) {
    return (
      <div ref={rootRef} className="suggest-root">
        <div id={statusId} className="sr-only" aria-live="polite" />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="suggest-root">
      <div id={statusId} className="sr-only" aria-live="polite">
        {suggestStatusText(status, results.length)}
      </div>
      <div
        id={listId}
        className="suggest-list"
        role="listbox"
        aria-label="Bottle suggestions"
        aria-busy={status === "loading"}
      >
        {status === "loading" && (
          <div className="suggest-status" role="status">
            <LoaderCircle size={16} className="spinner" aria-hidden="true" />
            <span>Searching…</span>
            <span className="suggest-status-detail">{suggestLoadingCopy(moduleId)}</span>
          </div>
        )}

        {status === "error" && (
          <div className="suggest-status suggest-error" role="status">
            Search unavailable. Try again.
          </div>
        )}

        {status === "empty" && (
          <div className="suggest-status" role="status">
            No matching bottles found.
          </div>
        )}

        {(status === "ready" || (status === "loading" && results.length > 0)) &&
          results.map((hit, index) => {
            const { name, brand, category } = hitLabel(hit);
            const optionId = suggestOptionId(reactId, index);
            const selected = index === active;
            return (
              <button
                type="button"
                id={optionId}
                role="option"
                aria-selected={selected}
                className={`suggest-item${selected ? " active" : ""}`}
                key={`${hit.source}-${hit.catalog_beer_id ?? hit.ttb_id ?? hit.product.id ?? index}`}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                onMouseEnter={() => setActive(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => pickHit(hit)}
              >
                <div className="card-icon">
                  {hit.product.image_url ? (
                    <img src={String(hit.product.image_url)} alt="" />
                  ) : (
                    <Bottle size={18} />
                  )}
                </div>
                <div>
                  <span className="eyebrow">{sourceLabel(hit)}</span>
                  <strong>{name}</strong>
                  <small>{[brand, category].filter(Boolean).join(" · ")}</small>
                </div>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            );
          })}

        {showCustom && (
          <button
            type="button"
            className="suggest-custom"
            onPointerDown={(event) => event.preventDefault()}
            onClick={pickCustom}
          >
            <Plus size={16} aria-hidden="true" />
            <span>Add “{q}” manually</span>
          </button>
        )}
      </div>
    </div>
  );
}
