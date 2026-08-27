export const TAB_KEYS = [
  "overview", "cocktails", "cellar", "brewery", "patrons", "staff", "gallery", "events", "tipjar", "merch", "whatsnext"
] as const;
export type TabKey = (typeof TAB_KEYS)[number];
export type EnabledTabs = Record<TabKey, 0 | 1>;

export const DEFAULT_ENABLED_TABS: EnabledTabs = {
  overview: 1, cocktails: 1, cellar: 1, brewery: 1, patrons: 1, staff: 1, gallery: 1,
  events: 1, tipjar: 1, merch: 0, whatsnext: 1
};

export const DEFAULT_ENABLED_TABS_JSON = '{"overview":1,"cocktails":1,"cellar":1,"brewery":1,"patrons":1,"staff":1,"gallery":1,"events":1,"tipjar":1,"merch":0,"whatsnext":1}';

/** The order tabs appear in the sidebar until the keeper rearranges them. */
export const DEFAULT_TAB_ORDER: TabKey[] = [...TAB_KEYS];

export const DEFAULT_TAB_ORDER_JSON = JSON.stringify(DEFAULT_TAB_ORDER);

/**
 * Reads a saved tab order, dropping anything unrecognized and appending known keys the
 * stored order is missing. That keeps saved orders working when a release adds a tab.
 */
export function parseTabOrder(raw?: string): TabKey[] {
  const known = new Set<string>(TAB_KEYS);
  const seen = new Set<TabKey>();
  const order: TabKey[] = [];

  if (typeof raw === "string" && raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry !== "string" || !known.has(entry)) continue;
        const key = entry as TabKey;
        if (seen.has(key)) continue;
        seen.add(key);
        order.push(key);
      }
    }
  }

  for (const key of TAB_KEYS) {
    if (!seen.has(key)) order.push(key);
  }
  return order;
}

export function serializeTabOrder(order: TabKey[]): string {
  return JSON.stringify(parseTabOrder(JSON.stringify(order)));
}

export const DEFAULT_BAR_LOCATION_TEXT = "Located in 19605";
export const DEFAULT_HOUSE_TIP_BLURB = "Drinks are always on the house at The Smoky Barrel Bar! Tips go directly toward party supplies, fresh kegs, and our annual holiday bashes.";
export const AI_UNAVAILABLE_NOTICE = "Sorry. Due to Roo's vet bills, We can't afford all of the AI needed for this feature right now.";
/** Client-side budget for a mixologist round-trip. LLM + failover often exceeds 5s. */
export const AI_MIXOLOGIST_TIMEOUT_MS = 15_000;
export const BLOCKED_RIBBON_LABEL = "Not for bar patrons";
export const TOP_PATRON_BANNER = "\u{1F451} #1 Bar Legend & Top Supporter";

/** The vault day rolls at 4:00 AM, so a 2 AM nightcap still counts as the night before. */
export const VAULT_DAY_ROLL_HOUR = 4;

export const LEADERBOARD_SIZE = 15;
export const MESSAGE_ALERT_DELAY_MS = 5 * 60_000;
export const KIOSK_IDLE_MS = 3 * 60_000;

export const MAX_PATRON_NAME = 60;
export const MAX_PATRON_NICKNAME = 40;
export const MAX_MESSAGE_BODY = 2000;
export const MAX_CONTACT_INFO = 200;
export const MAX_STAFF_NAME = 80;
export const MAX_STAFF_ROLE = 60;
export const MAX_STAFF_BIO = 600;
export const MAX_GALLERY_CAPTION = 280;

/** Phone video clips are large; keep the ceiling generous enough for a short 4K take. */
export const MAX_GALLERY_BYTES = 150 * 1024 * 1024;

export const STAFF_ROLE_SUGGESTIONS = [
  "Head Mixologist", "Chief Welcome Officer", "Cellar Security", "Brewmaster",
  "Keeper of the Vault", "Resident Taster", "Head of Snacks"
] as const;

export type Patron = {
  id: number;
  name: string;
  nickname: string;
  visit_count: number;
  notes: string;
  created_at: string;
  updated_at: string;
};

export type GuestMessage = {
  id: number;
  sender_name: string;
  contact_info: string;
  body: string;
  is_read: 0 | 1;
  discord_notified: 0 | 1;
  created_at: string;
};

export type HouseEvent = {
  id: number;
  title: string;
  event_date: string;
  description: string;
  image_url: string;
  is_published: 0 | 1;
  created_at: string;
};

export type EventSubscriber = {
  id: number;
  name: string;
  contact_info: string;
  notes: string;
  created_at: string;
};

export type MerchItem = {
  id: number;
  name: string;
  description: string;
  suggested_donation: string;
  image_url: string;
  is_available: 0 | 1;
  created_at: string;
};

export type StaffMember = {
  id: number;
  name: string;
  role: string;
  bio: string;
  image_url: string;
  display_order: number;
  created_at: string;
};

export type GalleryMediaType = "image" | "video";

export type GalleryMedia = {
  id: number;
  filename: string;
  media_type: GalleryMediaType;
  caption: string;
  uploaded_by: string;
  created_at: string;
  url: string;
  download_url: string;
};

export type DailyVoteResult = {
  ok: boolean;
  already_voted: boolean;
  vote_date: string;
  notice: string;
  up: number;
  down: number;
  net: number;
};

export function parseEnabledTabs(raw: unknown): EnabledTabs {
  const tabs: EnabledTabs = { ...DEFAULT_ENABLED_TABS };
  if (typeof raw !== "string" || !raw.trim()) return tabs;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return tabs;
  }
  if (!parsed || typeof parsed !== "object") return tabs;
  const record = parsed as Record<string, unknown>;
  for (const key of TAB_KEYS) {
    if (!(key in record)) continue;
    const value = record[key];
    tabs[key] = value === 1 || value === "1" || value === true ? 1 : 0;
  }
  return tabs;
}

export function serializeEnabledTabs(tabs: EnabledTabs): string {
  return JSON.stringify(Object.fromEntries(TAB_KEYS.map((key) => [key, tabs[key] ? 1 : 0])));
}

/**
 * Date string for the current vault day. Anything before 4:00 AM local time still
 * belongs to the previous calendar day so late-night votes are not double counted.
 */
export function vaultDayDate(now: Date = new Date()): string {
  const shifted = new Date(now.getTime());
  if (shifted.getHours() < VAULT_DAY_ROLL_HOUR) shifted.setDate(shifted.getDate() - 1);
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, "0");
  const day = String(shifted.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function clipText(value: unknown, max: number): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

export function clipBody(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

export function isBlocked(item: Record<string, unknown> | null | undefined): boolean {
  return Number(item?.blocked_from_ordering ?? 0) === 1;
}

export function patronRank(patrons: Patron[]): Patron[] {
  return [...patrons].sort((a, b) =>
    b.visit_count - a.visit_count || String(a.updated_at).localeCompare(String(b.updated_at))
  );
}

export type TipHandle = {
  id: string;
  label: string;
  /** Deep link opened when a guest taps the handle. */
  href: string;
  hint: string;
};

export function tipHandles(values: Record<string, string | undefined>): TipHandle[] {
  const handles: TipHandle[] = [];
  const venmo = clipText(values.tip_venmo, 60).replace(/^@/, "");
  const cashApp = clipText(values.tip_cashapp, 60).replace(/^\$/, "");
  const payPal = clipText(values.tip_paypal, 60).replace(/^@/, "");
  if (venmo) handles.push({ id: "venmo", label: "Venmo", href: `https://venmo.com/${venmo}`, hint: `@${venmo}` });
  if (cashApp) handles.push({ id: "cashapp", label: "Cash App", href: `https://cash.app/$${cashApp}`, hint: `$${cashApp}` });
  if (payPal) handles.push({ id: "paypal", label: "PayPal", href: `https://paypal.me/${payPal}`, hint: `@${payPal}` });
  return handles;
}

export function appleCashLink(phone: string, amountHint = ""): string {
  const digits = String(phone ?? "").replace(/[^\d+]/g, "");
  if (!digits) return "";
  const body = amountHint ? `?&body=${encodeURIComponent(amountHint)}` : "";
  return `sms:${digits}${body}`;
}
