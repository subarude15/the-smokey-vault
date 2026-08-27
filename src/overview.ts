import {
  TAP_COUNT,
  brewAbv,
  brewDisplayName,
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
import { wineDrinkByOverdue } from "./catalog.js";
import { DEFAULT_KEEPER_NAME } from "./shared-types.js";
import type { Pour } from "./pours.js";

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

export type OverviewPour = {
  id: number;
  module: string;
  name: string;
  amount: string;
  guest_name: string;
  created_at: string;
};

export type OverviewSnapshot = {
  spirits: { on_shelf: number; low: number; labels: number };
  taps: { pouring: number; empty: number; handles: number; list: OverviewTap[] };
  brews: { active: number; archived: number; list: OverviewBrew[] };
  packaged: { units: number; skus: number; out: number };
  wines: { bottles: number; labels: number };
  cocktails: { ready: number; almost: number; favorites: OverviewFavorite[]; offMenu: OverviewFavorite[] };
  tickets: OverviewTicket[];
  pours: OverviewPour[];
  low: OverviewLow[];
  keeperName: string;
};

export function overviewGreeting(date = new Date(), guest = false): { eyebrow: string; line: string; emphasize: string } {
  const hour = date.getHours();
  const eyebrow = hour >= 5 && hour < 12
    ? "GOOD MORNING"
    : hour >= 12 && hour < 17
      ? "GOOD AFTERNOON"
      : hour >= 17 && hour < 21
        ? "GOOD EVENING"
        : "AFTER HOURS";
  if (guest) {
    return { eyebrow: `${eyebrow} · PATRON LOUNGE`, line: "Tonight at", emphasize: "The Smokey Barrel." };
  }
  if (hour >= 5 && hour < 12) {
    return { eyebrow, line: "The cellar is", emphasize: "waking up." };
  }
  if (hour >= 12 && hour < 17) {
    return { eyebrow, line: "What's pouring", emphasize: "this afternoon." };
  }
  if (hour >= 17 && hour < 21) {
    return { eyebrow, line: "Your private bar,", emphasize: "beautifully organized." };
  }
  return { eyebrow, line: "The Smokey Barrel is", emphasize: "still pouring." };
}

export function overviewHeroCopy(snapshot: OverviewSnapshot, guest = false): string {
  const parts: string[] = [];
  if (snapshot.taps.pouring) parts.push(`${snapshot.taps.pouring} handle${snapshot.taps.pouring === 1 ? "" : "s"} pouring`);
  if (snapshot.cocktails.ready) {
    parts.push(guest
      ? `${snapshot.cocktails.ready} off the menu`
      : `${snapshot.cocktails.ready} ready to mix`);
  }
  if (snapshot.pours.length) parts.push(`${snapshot.pours.length} poured tonight`);
  if (snapshot.spirits.on_shelf) parts.push(`${snapshot.spirits.on_shelf} on the shelf`);
  if (snapshot.wines.bottles) parts.push(`${snapshot.wines.bottles} in the cellar`);
  if (snapshot.packaged.units) parts.push(`${snapshot.packaged.units} in the cold room`);
  if (snapshot.brews.active) parts.push(`${snapshot.brews.active} in the lab`);
  if (!parts.length) {
    return guest
      ? "Browse the collection, see what is pouring, and find your next perfect drink."
      : "Stock the shelf, put a beer on, and the house menu fills in.";
  }
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
  pours?: Array<Pour | Record<string, unknown>>;
  keeperName?: string;
}): OverviewSnapshot {
  const spirits = input.spirits ?? [];
  const taps = [...(input.taps ?? [])].sort((a, b) => num(a.tap_number) - num(b.tap_number));
  const brews = input.brews ?? [];
  const packaged = input.packaged ?? [];
  const wines = input.wines ?? [];
  const cocktails = input.cocktails ?? [];
  const tickets = input.tickets ?? [];
  const pours = input.pours ?? [];
  const keeperName = text(input.keeperName) || DEFAULT_KEEPER_NAME;

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
    batch_name: brewDisplayName(brew.batch_name, brew.style),
    style: text(brew.style),
    status: normalizeBrewStatus(brew.status),
    abv: formatAbv(brewAbv(brew) ?? brew.calculated_abv ?? brew.abv),
    on_tap: onTapLabel(tapsForBatch(taps, brew.batch_name))
  }));

  const packagedUnits = packaged.reduce((sum, item) => sum + packagedCount(item.count), 0);
  const packagedOut = packaged.filter((item) => packagedCount(item.count) <= 0).length;

  const wineBottles = wines.reduce((sum, item) => sum + Math.max(0, Math.floor(num(item.bottle_count))), 0);
  const wineOnRack = wines.filter((item) => wineOnShelf(item)).length;

  const asFavorite = (drink: Record<string, unknown>): OverviewFavorite => ({
    id: itemId(drink.id),
    name: text(drink.name) || "Untitled",
    readiness: text(drink.readiness) || "missing",
    method: text(drink.method),
    glassware: text(drink.glassware),
    image_url: text(drink.image_url)
  });
  const ready = cocktails.filter((drink) => drink.readiness === "ready");
  const almost = cocktails.filter((drink) => drink.readiness === "almost");
  const offMenu = [...ready].sort(compareCocktails).slice(0, 8).map(asFavorite);
  const favorites: OverviewFavorite[] = cocktails
    .filter((drink) => num(drink.bartender_fav) > 0)
    .sort(compareCocktails)
    .slice(0, 8)
    .map(asFavorite);

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
      .filter((item) => wineDrinkByOverdue(item) && Math.floor(num(item.bottle_count)) > 0)
      .map((item) => ({
        module: "wines" as const,
        id: itemId(item.id),
        name: [text(item.name), text(item.producer)].filter(Boolean).join(" · ") || "Untitled wine",
        detail: `Drink by ${text(item.drink_by_date).slice(0, 10)}`,
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
    cocktails: { ready: ready.length, almost: almost.length, favorites, offMenu },
    tickets: tickets.slice(0, 12).map((ticket) => ({
      id: itemId(ticket.id),
      name: text(ticket.name),
      guest_name: text(ticket.guest_name),
      notes: text(ticket.notes),
      image_url: text(ticket.image_url)
    })),
    pours: pours.slice(0, 16).map((pour) => ({
      id: itemId(pour.id),
      module: text(pour.module),
      name: text(pour.name),
      amount: text(pour.amount),
      guest_name: text(pour.guest_name),
      created_at: text(pour.created_at)
    })),
    low,
    keeperName
  };
}
