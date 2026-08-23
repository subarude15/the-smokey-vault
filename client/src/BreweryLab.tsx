import { useCallback, useEffect, useState } from "react";
import { Beer, CircleAlert, FlaskConical, Hop, Thermometer } from "lucide-react";
import { api, type Item } from "./api";
import {
  DEFAULT_KEG_L, formatGravity, isTapEmpty, kegFillPercent, normalizeBrewStatus,
  parseList, pintsRemaining, tapsForBatch
} from "./catalog";

const PIPELINE_STATUSES = new Set(["Fermenting", "Conditioning"]);

function daysSince(raw: unknown): number | null {
  const stamp = Date.parse(String(raw ?? "").replace(" ", "T"));
  if (!Number.isFinite(stamp)) return null;
  return Math.max(0, Math.floor((Date.now() - stamp) / 86_400_000));
}

function stageDaysLabel(brew: Item): string {
  const days = daysSince(brew.updated_at) ?? daysSince(brew.brew_date);
  if (days == null) return "";
  if (days === 0) return "Moved today";
  return `Day ${days} in ${normalizeBrewStatus(brew.status).toLowerCase()}`;
}

function abvText(brew: Item): string {
  const abv = Number(brew.calculated_abv ?? brew.abv ?? 0);
  return abv > 0 ? `${abv.toFixed(1)}% ABV` : "";
}

function gravityText(brew: Item): string {
  const og = formatGravity(brew.measured_og ?? brew.target_og);
  const fg = formatGravity(brew.measured_fg ?? brew.target_fg);
  if (og && fg) return `OG ${og} → FG ${fg}`;
  if (og) return `OG ${og}`;
  if (fg) return `FG ${fg}`;
  return "";
}

function BrewStats({ brew }: { brew: Item }) {
  const hops = parseList(brew.hops);
  const gravity = gravityText(brew);
  const abv = abvText(brew);
  return <div className="lab-stats">
    {gravity ? <span><Thermometer size={13}/> {gravity}</span> : null}
    {abv ? <span>{abv}</span> : null}
    {brew.style ? <span>{String(brew.style)}</span> : null}
    {hops.length ? <span><Hop size={13}/> {hops.slice(0, 4).join(", ")}</span> : null}
  </div>;
}

export function BreweryLab({ admin, keeperName, go }: { admin: boolean; keeperName: string; go: (page: string) => void }) {
  const [brews, setBrews] = useState<Item[]>([]);
  const [taps, setTaps] = useState<Item[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    Promise.all([api<Item[]>("/inventory/brews"), api<Item[]>("/inventory/taps")])
      .then(([brewRows, tapRows]) => { setBrews(brewRows); setTaps(tapRows); setError(""); })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the brewery lab."));
  }, []);
  useEffect(() => { load(); }, [load]);

  const pouring = brews
    .map((brew) => ({ brew, tapNumbers: tapsForBatch(taps, brew.batch_name) }))
    .filter((entry) => entry.tapNumbers.length > 0);
  const pouringIds = new Set(pouring.map((entry) => entry.brew.id));
  const inTheWorks = brews.filter((brew) => !pouringIds.has(brew.id) && PIPELINE_STATUSES.has(normalizeBrewStatus(brew.status)));
  const planned = brews.filter((brew) => normalizeBrewStatus(brew.status) === "Planned");
  const archived = brews.filter((brew) => normalizeBrewStatus(brew.status) === "Archived");
  const readyToKeg = brews.filter((brew) => !pouringIds.has(brew.id) && normalizeBrewStatus(brew.status) === "Ready to Keg");

  function tapDetail(tapNumber: number) {
    const tap = taps.find((row) => Number(row.tap_number) === tapNumber);
    if (!tap || isTapEmpty(tap)) return null;
    const remaining = Number(tap.remaining_l ?? 0);
    const size = Number(tap.keg_size_l || DEFAULT_KEG_L);
    const pints = pintsRemaining(remaining);
    return { tap, remaining, size, pints, kicked: remaining <= 0 };
  }

  return <>
    <div className="page-title">
      <span className="eyebrow">THE BREWERY LAB</span>
      <h1>From the fermenter to your glass.</h1>
      <p>{admin
        ? "Live pipeline across taps and Brewfather batches. Edit batches in the Homebrew Log."
        : `Everything ${keeperName} is brewing, conditioning, and pouring right now.`}</p>
    </div>

    {error && <div className="ai-error load-error"><CircleAlert/><div><strong>Could not load the brewery lab</strong><span>{error}</span></div><button className="secondary" onClick={load}>Retry</button></div>}

    <section className="lab-tier">
      <div className="section-heading">
        <div><span className="eyebrow">TIER ONE</span><h2><Beer size={20}/> Pouring Now from the Lab</h2></div>
      </div>
      {!pouring.length ? <p className="lab-empty">No homebrew on tap right now. {readyToKeg.length ? `${readyToKeg.length} batch${readyToKeg.length === 1 ? "" : "es"} ready to keg.` : ""}</p> :
        <div className="lab-grid">{pouring.map(({ brew, tapNumbers }) => (
          <article className="lab-card lab-pouring" key={brew.id}>
            <div className="lab-thumb">{brew.image_url ? <img src={String(brew.image_url)} alt=""/> : <Beer size={26}/>}</div>
            <div className="lab-body">
              <div className="tap-badges">{tapNumbers.map((number) => <span className="tap-badge" key={number}>TAP {number}</span>)}</div>
              <h3>{String(brew.batch_name ?? "Untitled batch")}</h3>
              <BrewStats brew={brew}/>
              {tapNumbers.map((number) => {
                const detail = tapDetail(number);
                if (!detail) return null;
                return <div className="fill" key={`fill-${number}`}>
                  <span style={{ width: `${kegFillPercent(detail.remaining, detail.size)}%` }}/>
                  <small>{detail.kicked ? "Kicked" : `${detail.pints} pint${detail.pints === 1 ? "" : "s"} left on tap ${number}`}</small>
                </div>;
              })}
            </div>
          </article>
        ))}</div>}
    </section>

    <section className="lab-tier">
      <div className="section-heading">
        <div><span className="eyebrow">TIER TWO</span><h2><FlaskConical size={20}/> In the Works</h2></div>
      </div>
      {!inTheWorks.length ? <p className="lab-empty">Nothing fermenting or conditioning at the moment.</p> :
        <div className="lab-grid">{inTheWorks.map((brew) => (
          <article className="lab-card" key={brew.id}>
            <div className="lab-thumb">{brew.image_url ? <img src={String(brew.image_url)} alt=""/> : <FlaskConical size={26}/>}</div>
            <div className="lab-body">
              <span className={`lab-stage ${normalizeBrewStatus(brew.status).toLowerCase()}`}>{normalizeBrewStatus(brew.status)}</span>
              <h3>{String(brew.batch_name ?? "Untitled batch")}</h3>
              <BrewStats brew={brew}/>
              {stageDaysLabel(brew) ? <small className="lab-stage-days">{stageDaysLabel(brew)}</small> : null}
            </div>
          </article>
        ))}</div>}
    </section>

    <details className="archive-block lab-tier">
      <summary>Planned &amp; archived logs ({planned.length + archived.length + readyToKeg.length})</summary>
      {readyToKeg.length > 0 && <>
        <span className="eyebrow">READY TO KEG</span>
        <ul className="lab-log">{readyToKeg.map((brew) => <li key={brew.id}><strong>{String(brew.batch_name)}</strong><span>{gravityText(brew) || String(brew.style ?? "")}</span></li>)}</ul>
      </>}
      {planned.length > 0 && <>
        <span className="eyebrow">PLANNED</span>
        <ul className="lab-log">{planned.map((brew) => <li key={brew.id}><strong>{String(brew.batch_name)}</strong><span>{String(brew.style ?? "")}</span></li>)}</ul>
      </>}
      {archived.length > 0 && <>
        <span className="eyebrow">ARCHIVE</span>
        <ul className="lab-log">{archived.map((brew) => <li key={brew.id}><strong>{String(brew.batch_name)}</strong><span>{abvText(brew) || String(brew.style ?? "")}</span></li>)}</ul>
      </>}
      {!planned.length && !archived.length && !readyToKeg.length && <p className="lab-empty">The log is empty.</p>}
    </details>

    {admin && <div className="lab-footer-actions">
      <button type="button" className="secondary" onClick={() => go("brews")}>Open the Homebrew Log</button>
      <button type="button" className="secondary" onClick={() => go("taps")}>Manage taps</button>
    </div>}
  </>;
}
