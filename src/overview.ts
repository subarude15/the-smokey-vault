import {
  TAP_COUNT,
  brewAbv,
  compareBrews,
  formatAbv,
  isTapEmpty,
  kegFillPercent,
  normalizeBrewStatus,
  onTapLabel,
  packagedCount,
  pintsRemaining,
  tapTitle,
  tapsForBatch
} from "./catalog.js";
import { compareCocktails, spiritOnShelf, wineOnShelf } from "./cocktails.js";

export type OverviewTap = {
  tap_number: number;
  title: string;
  maker: string;
  style: string;
  abv: string;
  remaining_pct: number;
  pints: number;
  image_url: string;
  source_type: string;
  empty: boolean;
};

export type OverviewBrew = {
  id: number;
  batch_name: string;
  style: string;
  status: string;
  abv: string;
  on_tap: string;
};

export type OverviewLow = {
  module: "spirits" | "wines" | "packaged_beer";
  id: number;
  name: string;
  detail: string;
  image_url: string;
};

export type OverviewFavorite = {
  id: number;
  name: string;
  readiness: string;
  method: string;
  glassware: string;
  image_url: string;
};

export type OverviewTicket = {
  id: number;
  name: string;
  guest_name: string;
  notes: string;
  image_url: string;
};

export type OverviewSnapshot = {
  spirits: { on_shelf: number; low: number; labels: number };
  taps: { pouring: number; empty: number; handles: number; list: OverviewTap[] };
  brews: { active: number; archived: number; list: OverviewBrew[] };
  packaged: { units: number; skus: number; out: number };
  wines: { bottles: number; labels: number };
  cocktails: { ready: number; almost: number; favorites: OverviewFavorite[] };
  tickets: OverviewTicket[];
  low: OverviewLow[];
};

export function overviewGreeting(date = new Date()): { eyebrow: string; line: string; emphasize: string } {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) {
    return { eyebrow: "GOOD MORNING", line: "The cellar is", emphasize: "waking up." };
  }
  if (hour >= 12 && hour < 17) {
    return { eyebrow: "GOOD AFTERNOON", line: "What's pouring", emphasize: "this afternoon." };
  }
  if (hour >= 17 && hour < 21) {
    return { eyebrow: "GOOD EVENING", line: "Your private bar,", emphasize: "beautifully organized." };
  }
  return { eyebrow: "AFTER HOURS", line: "The vault is", emphasize: "still pouring." };
}

export function overviewHeroCopy(snapshot: OverviewSnapshot): string {
  const parts: string[] = [];
  if (snapshot.taps.pouring) parts.push(`${snapshot.taps.pouring} handle${snapshot.taps.pouring === 1 ? "" : "s"} pouring`);
  if (snapshot.cocktails.ready) parts.push(`${snapshot.cocktails.ready} ready to mix`);
  if (snapshot.tickets.length) parts.push(`${snapshot.tickets.length} on the ticket`);
  if (snapshot.spirits.on_shelf) parts.push(`${snapshot.spirits.on_shelf} on the shelf`);
  if (snapshot.wines.bottles) parts.push(`${snapshot.wines.bottles} in the cellar`);
  if (snapshot.packaged.units) parts.push(`${snapshot.packaged.units} in the cold room`);
  if (snapshot.brews.active) parts.push(`${snapshot.brews.active} in the lab`);
  if (!parts.length) return "Stock the shelf, put a beer on, and the house menu fills in.";
  return parts.join(" · ");
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function itemId(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function buildOverview(input: {
  spirits?: Array<Record<string, unknown>>;
  taps?: Array<Record<string, unknown>>;
  brews?: Array<Record<string, unknown>>;
  packaged?: Array<Record<string, unknown>>;
  wines?: Array<Record<string, unknown>>;
  cocktails?: Array<Record<string, unknown>>;
  tickets?: Array<Record<string, unknown>>;
}): OverviewSnapshot {
  const spirits = input.spirits ?? [];
  const taps = [...(input.taps ?? [])].sort((a, b) => num(a.tap_number) - num(b.tap_number));
  const brews = input.brews ?? [];
  const packaged = input.packaged ?? [];
  const wines = input.wines ?? [];
  const cocktails = input.cocktails ?? [];
  const tickets = input.tickets ?? [];

  const onShelfSpirits = spirits.filter((item) => spiritOnShelf(item));
  const lowSpirits = onShelfSpirits.filter((item) => num(item.fill_level) <= 25);

  const tapList: OverviewTap[] = taps.map((tap) => {
    const empty = isTapEmpty(tap);
    const remaining = num(tap.remaining_l);
    const size = num(tap.keg_size_l);
    return {
      tap_number: num(tap.tap_number),
      title: tapTitle(tap),
      maker: text(tap.maker),
      style: text(tap.style),
      abv: empty ? "" : formatAbv(tap.abv),
      remaining_pct: empty ? 0 : Math.round(kegFillPercent(remaining, size)),
      pints: empty ? 0 : pintsRemaining(remaining),
      image_url: text(tap.image_url),
      source_type: text(tap.source_type),
      empty
    };
  });
  const pouring = tapList.filter((tap) => !tap.empty).length;

  const activeBrews = brews.filter((brew) => normalizeBrewStatus(brew.status) !== "Archived").sort(compareBrews);
  const brewList: OverviewBrew[] = activeBrews.slice(0, 8).map((brew) => ({
    id: itemId(brew.id),
    batch_name: text(brew.batch_name) || "Untitled batch",
    style: text(brew.style),
    status: normalizeBrewStatus(brew.status),
    abv: formatAbv(brewAbv(brew) ?? brew.calculated_abv ?? brew.abv),
    on_tap: onTapLabel(tapsForBatch(taps, brew.batch_name))
  }));

  const packagedUnits = packaged.reduce((sum, item) => sum + packagedCount(item.count), 0);
  const packagedOut = packaged.filter((item) => packagedCount(item.count) <= 0).length;

  const wineBottles = wines.reduce((sum, item) => sum + Math.max(0, Math.floor(num(item.bottle_count))), 0);
  const wineOnRack = wines.filter((item) => wineOnShelf(item)).length;

  const ready = cocktails.filter((drink) => drink.readiness === "ready");
  const almost = cocktails.filter((drink) => drink.readiness === "almost");
  const favorites: OverviewFavorite[] = cocktails
    .filter((drink) => num(drink.bartender_fav) > 0)
    .sort(compareCocktails)
    .slice(0, 8)
    .map((drink) => ({
      id: itemId(drink.id),
      name: text(drink.name) || "Untitled",
      readiness: text(drink.readiness) || "missing",
      method: text(drink.method),
      glassware: text(drink.glassware),
      image_url: text(drink.image_url)
    }));

  const low: OverviewLow[] = [
    ...lowSpirits
      .sort((a, b) => num(a.fill_level) - num(b.fill_level))
      .map((item) => ({
        module: "spirits" as const,
        id: itemId(item.id),
        name: [text(item.name), text(item.brand)].filter(Boolean).join(" · ") || "Untitled bottle",
        detail: `${Math.round(num(item.fill_level))}% full`,
        image_url: text(item.image_url)
      })),
    ...wines
      .filter((item) => Math.floor(num(item.bottle_count)) === 1)
      .map((item) => ({
        module: "wines" as const,
        id: itemId(item.id),
        name: [text(item.name), text(item.producer)].filter(Boolean).join(" · ") || "Untitled wine",
        detail: "Last bottle",
        image_url: text(item.image_url)
      })),
    ...packaged
      .filter((item) => packagedCount(item.count) === 1)
      .map((item) => ({
        module: "packaged_beer" as const,
        id: itemId(item.id),
        name: [text(item.name), text(item.brewery)].filter(Boolean).join(" · ") || "Untitled beer",
        detail: "Last one in the cold room",
        image_url: text(item.image_url)
      }))
  ].slice(0, 8);

  return {
    spirits: { on_shelf: onShelfSpirits.length, low: lowSpirits.length, labels: spirits.length },
    taps: { pouring, empty: Math.max(0, tapList.length - pouring), handles: TAP_COUNT, list: tapList },
    brews: { active: activeBrews.length, archived: brews.length - activeBrews.length, list: brewList },
    packaged: { units: packagedUnits, skus: packaged.length, out: packagedOut },
    wines: { bottles: wineBottles, labels: wineOnRack },
    cocktails: { ready: ready.length, almost: almost.length, favorites },
    tickets: tickets.slice(0, 12).map((ticket) => ({
      id: itemId(ticket.id),
      name: text(ticket.name),
      guest_name: text(ticket.guest_name),
      notes: text(ticket.notes),
      image_url: text(ticket.image_url)
    })),
    low
  };
}
