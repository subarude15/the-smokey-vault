import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { Beer, FlaskConical, Settings, WineOff } from "lucide-react";
import { api, type Item } from "./api";
import {
  BLOCKED_RIBBON_LABEL,
  DEFAULT_KEG_L,
  displayCanonicalFamily,
  displayCanonicalType,
  fillStopLabel,
  isTapEmpty,
  kegSizeLabel,
  nearestFillStop,
  openNextSpirit,
  pintsRemaining,
  pourPint,
  pourSpirit,
  spiritStockLabel,
  tapTitle
} from "./catalog";
import {
  guestSpiritAvailabilityLabel,
  guestTapAvailabilityLabel,
  readAvailabilityPct,
  spiritGaugePct,
  tapGaugeForDisplay
} from "./guestAvailability";
import { SpiritCardMedia } from "./SpiritCardMedia";
import "./tap-spirit-card.css";

type CardProps = {
  item: Item;
  admin: boolean;
  onOpenDetail: () => void;
  onEdit: () => void;
  onUpdated: (item: Item) => void;
  onClearTap?: () => void;
  onOpenBreweryLab?: () => void;
};

function stop(event: MouseEvent<HTMLElement>) {
  event.stopPropagation();
}

function openOnKeyboard(event: KeyboardEvent<HTMLElement>, open: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  open();
}

function imageUrl(item: Item): string {
  return String(item.display_image_url ?? item.image_url ?? "").trim();
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function tastingPreview(item: Item): string {
  const raw = text(item.tasting_notes);
  if (!raw) return "";
  return raw.length > 128 ? `${raw.slice(0, 125).trimEnd()}…` : raw;
}

function isHomebrew(item: Item): boolean {
  return /^homebrew$/i.test(text(item.source_type));
}

function TapCardMedia({ item }: { item: Item }) {
  const src = imageUrl(item);
  const label = tapTitle(item);
  return <div className={`domain-card-media ${src ? "has-image" : ""}`} aria-hidden={!src}>
    {src ? <img src={src} alt={label}/> : <Beer/>}
  </div>;
}

function Availability({ pct, label, keeper }: { pct: number; label: string; keeper?: string }) {
  const safe = Math.max(0, Math.min(100, pct));
  return <div className="domain-card-availability">
    <div className="domain-card-availability-row">
      <span>{label}</span>
      {keeper ? <strong>{keeper}</strong> : null}
    </div>
    <div className="domain-card-gauge" role="img" aria-label={keeper ? `${label}: ${keeper}` : label}>
      <span style={{ width: `${safe}%` }}/>
    </div>
  </div>;
}

export function TapInventoryCard({
  item,
  admin,
  onOpenDetail,
  onEdit,
  onUpdated,
  onClearTap,
  onOpenBreweryLab
}: CardProps) {
  const [acting, setActing] = useState<"pour" | "">("");
  const [error, setError] = useState("");
  const empty = isTapEmpty(item);
  const homebrew = !empty && isHomebrew(item);
  const guestPct = !admin ? readAvailabilityPct(item) : null;
  const keeperGauge = admin && !empty ? tapGaugeForDisplay(item, true, DEFAULT_KEG_L) : null;
  const kegSize = Number(item.keg_size_l || DEFAULT_KEG_L);
  const remaining = Number(item.remaining_l ?? 0);
  const pints = pintsRemaining(remaining);
  const kicked = !empty && ((admin && remaining <= 0) || (!admin && guestPct === 0));

  async function patch(payload: Record<string, unknown>, failed: string, mode: typeof acting) {
    if (!admin || acting) return;
    setActing(mode);
    setError("");
    try {
      const next = await api<Item>(`/inventory/taps/${item.id}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      onUpdated(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : failed);
    } finally {
      setActing("");
    }
  }

  function pourPintNow(event: MouseEvent<HTMLButtonElement>) {
    stop(event);
    if (remaining <= 0) return;
    void patch({ remaining_l: pourPint(remaining) }, "Could not pour a pint", "pour");
  }

  const availability = admin
    ? keeperGauge
    : guestPct == null || empty
      ? null
      : { pct: guestPct, label: guestTapAvailabilityLabel(guestPct) };

  return <article className={`domain-card tap-card${empty ? " empty-tap" : ""}${kicked ? " kicked-tap" : ""}`}>
    <div
      className="domain-card-main"
      role="button"
      tabIndex={0}
      onClick={onOpenDetail}
      onKeyDown={(event) => openOnKeyboard(event, onOpenDetail)}
      aria-label={empty ? `Tap ${item.tap_number}, empty` : `Tap ${item.tap_number}, ${tapTitle(item)}`}
    >
      <TapCardMedia item={item}/>
      <div className="domain-card-copy">
        <div className="domain-card-kicker">
          <span className="tap-number">Tap {item.tap_number}</span>
          {empty ? <span className="status-pill muted">Empty</span> : kicked ? <span className="status-pill warning">Kicked</span> : <span className="status-pill">Pouring</span>}
        </div>
        <h3>{empty ? "Line currently empty" : tapTitle(item)}</h3>
        {!empty && <div className="domain-card-meta">
          {text(item.maker) ? <span>{text(item.maker)}</span> : null}
          {text(item.style) ? <span>{text(item.style)}</span> : null}
          {item.abv ? <span>{item.abv}% ABV</span> : null}
        </div>}
        {!empty && availability ? <Availability
          pct={availability.pct}
          label={admin ? "Keg remaining" : availability.label}
          keeper={admin ? `${remaining.toFixed(1)} L · ${pints} pint${pints === 1 ? "" : "s"} · ${kegSizeLabel(kegSize)}` : undefined}
        /> : null}
        {empty ? <p className="domain-card-empty-copy">Ready for the next keg.</p> : null}
      </div>
    </div>

    {homebrew && onOpenBreweryLab ? <div className="domain-card-context" onClick={stop}>
      <button type="button" className="homebrew-link" onClick={onOpenBreweryLab}>
        <FlaskConical size={15}/> Homebrew · open Brewery Lab
      </button>
    </div> : null}

    {admin ? <div className="keeper-card-controls" onClick={stop}>
      <span className="keeper-controls-label">Keeper controls</span>
      {!empty ? <button type="button" className="secondary" disabled={remaining <= 0 || Boolean(acting)} onClick={pourPintNow}>
        {acting === "pour" ? "Pouring…" : "− Pour pint"}
      </button> : null}
      <button type="button" className="secondary" onClick={onEdit}><Settings size={15}/> {empty ? "Put a beer on" : "Edit tap"}</button>
      {!empty && onClearTap ? <button type="button" className="secondary danger" onClick={onClearTap}>Clear tap</button> : null}
    </div> : null}
    {error ? <p className="domain-card-error" role="alert">{error}</p> : null}
  </article>;
}

export function SpiritInventoryCard({ item, admin, onOpenDetail, onEdit, onUpdated }: CardProps) {
  const [acting, setActing] = useState<"pour" | "open" | "block" | "">("");
  const [error, setError] = useState("");
  const blocked = Number(item.blocked_from_ordering ?? 0) === 1;
  const guestPct = !admin ? readAvailabilityPct(item) : null;
  const gaugePct = spiritGaugePct(item, admin);
  const fill = nearestFillStop(item.fill_level);
  const nextSpirit = admin ? openNextSpirit(item) : null;
  const preview = tastingPreview(item);
  const family = displayCanonicalFamily(text(item.category));
  const subtype = displayCanonicalType(text(item.sub_category));

  async function patch(payload: Record<string, unknown>, failed: string, mode: typeof acting) {
    if (!admin || acting) return;
    setActing(mode);
    setError("");
    try {
      const next = await api<Item>(`/inventory/spirits/${item.id}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      onUpdated(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : failed);
    } finally {
      setActing("");
    }
  }

  function pour(event: MouseEvent<HTMLButtonElement>) {
    stop(event);
    if (fill <= 0) return;
    void patch({ fill_level: pourSpirit(item.fill_level) }, "Could not pour a drink", "pour");
  }

  function openNext(event: MouseEvent<HTMLButtonElement>) {
    stop(event);
    if (!nextSpirit) return;
    void patch(nextSpirit, "Could not open the next bottle", "open");
  }

  function toggleBlock(event: MouseEvent<HTMLButtonElement>) {
    stop(event);
    void patch({ blocked_from_ordering: blocked ? 0 : 1 }, "Could not update patron access", "block");
  }

  const guestLabel = guestPct == null ? "" : guestSpiritAvailabilityLabel(guestPct);
  const keeperLabel = `${fillStopLabel(fill)} · ${spiritStockLabel(item.stock_count)}`;

  return <article className={`domain-card spirit-card${blocked ? " blocked-bottle" : ""}`}>
    {blocked ? <span className="blocked-ribbon">{BLOCKED_RIBBON_LABEL}</span> : null}
    <div
      className="domain-card-main"
      role="button"
      tabIndex={0}
      onClick={onOpenDetail}
      onKeyDown={(event) => openOnKeyboard(event, onOpenDetail)}
      aria-label={`Open ${text(item.name) || "bottle"} details`}
    >
      <SpiritCardMedia item={item}/>
      <div className="domain-card-copy">
        <div className="domain-card-kicker">
          <span>{text(item.brand) || family || "Bottle Library"}</span>
          {blocked ? <span className="status-pill warning">Patrons blocked</span> : null}
        </div>
        <h3>{text(item.name) || "Untitled"}</h3>
        <div className="domain-card-meta">
          {family ? <span>{family}</span> : null}
          {subtype ? <span>{subtype}</span> : null}
          {item.abv ? <span>{item.abv}% ABV</span> : null}
        </div>
        {preview ? <p className="domain-card-tasting">{preview}</p> : null}
        {gaugePct != null ? <Availability
          pct={gaugePct}
          label={admin ? "Bottle availability" : guestLabel}
          keeper={admin ? keeperLabel : undefined}
        /> : null}
        {admin ? <div className="domain-card-ops-meta">
          {item.stock_count != null ? <span><strong>{item.stock_count}</strong> bottles</span> : null}
          {text(item.shelf_location) ? <span><strong>Shelf</strong> {text(item.shelf_location)}</span> : null}
        </div> : null}
      </div>
    </div>

    {admin ? <div className="keeper-card-controls" onClick={stop}>
      <span className="keeper-controls-label">Keeper controls</span>
      <button type="button" className="secondary" disabled={fill <= 0 || Boolean(acting)} onClick={pour}>
        {acting === "pour" ? "Pouring…" : "− Pour"}
      </button>
      {nextSpirit ? <button type="button" className="secondary" disabled={Boolean(acting)} onClick={openNext}>
        {acting === "open" ? "Opening…" : "+ Open next"}
      </button> : null}
      <button type="button" className="secondary" disabled={Boolean(acting)} onClick={toggleBlock}>
        <WineOff size={15}/> {acting === "block" ? "Saving…" : blocked ? "Allow for patrons" : "Block from patrons"}
      </button>
      <button type="button" className="secondary" onClick={onEdit}><Settings size={15}/> Edit</button>
    </div> : null}
    {error ? <p className="domain-card-error" role="alert">{error}</p> : null}
  </article>;
}
