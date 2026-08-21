import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type ReactNode } from "react";
import {
  ArrowLeft, Beer, BottleWine as Bottle, ChevronDown, ChevronRight, ChevronUp, CircleAlert, Copy, Database, Download, FlaskConical, Grape, LayoutDashboard,
  Link, LoaderCircle, Lock, LockOpen, Menu, Moon, Plus, Save, Search, Settings, Share2, ShoppingBag, Shuffle, Sparkles, Star, Sun, ThumbsUp, Trash2, Upload, Wine, X, ClipboardPaste
} from "lucide-react";
import { api, clearToken, downloadExport, Item, setToken, tokenExists } from "./api";
import { ImageField } from "./ImageField";
import { BottleSuggest, hitFitsModule, type BottleSearchHit } from "./BottleSuggest";
import { GuestReviews } from "./GuestReviews";
import { BottleVotes, scoreLabel, voterId } from "./BottleVotes";
import {
  BASE_INGREDIENTS, BEER_STYLES, BEER_VESSELS, BREW_FLAVOR_OPTIONS, DEFAULT_KEG_L, FLAVOR_OPTIONS, HOP_OPTIONS,
  KEG_REMAINING_STOPS, KEG_SIZES, PACK_COUNT_STOPS, SPARKLING_STYLES, SPIRIT_FAMILIES, SPIRIT_TYPES, WINE_FAMILIES,
  BREW_STATUSES, defaultSweetnessForWine, inferWineFamilyAndStyle, kegFillPercent, kegSizeLabel,
  migrateWineSweetnessValue, nearestKegStop, parseList, parseTagInput, pintsRemaining, pourPint,
  remainingFromPercent, serializeList, wineKindLabel, wineSweetnessStops, brewToTap,
  TAP_COUNT, emptyTapBeerFields, firstEmptyTapNumber, isTapEmpty, tapTitle,
  brewAbv, compareBrews, formatAbv, formatGravity, nextBrewStatus, normalizeBrewStatus,
  onTapLabel, parseGravity, tapsForBatch, comparePackagedBeer, drinkOnePackaged, normalizeBeerVessel,
  packagedCount, packagedStockLabel, FILL_STOPS, compareSpirits, fillStopLabel, isSpiritEmpty,
  nearestFillStop, openNextSpirit, pourSpirit, spiritStock, spiritStockLabel,
  SEASONS, collectionGroup, compareCocktails, currentSeason,
  overviewGreeting, overviewHeroCopy, type OverviewSnapshot, type RestockItem, type RestockThresholds,
  parseRestockThresholds, RESTOCK_PACKAGED_STOPS, RESTOCK_WINE_STOPS, MAX_WANTED_NAME, MAX_WANTED_NOTE,
  formatRestockShare, extractSharedRecipeUrl, type WantedLabel,
  type NextBoards, type NextItem, type NextKind, MAX_NEXT_NAME
} from "./catalog";
import { Scanner, ScanResult, ScanReviewOutcome } from "./Scanner";

type Field = { key: string; label: string; type?: string; options?: string[] };
type Module = {
  id: string; label: string; singular: string; icon: typeof Bottle; title: string; subtitle: string;
  fields: Field[]; primary: string; secondary: string; makerKey: string; kindKey: string;
};

const beerFields: Field[] = [
  { key:"style",label:"Style",options:BEER_STYLES },
  { key:"base_ingredient",label:"Base / grain",options:BASE_INGREDIENTS },
  { key:"tasting_notes",label:"Tasting notes",type:"tasting" },
  { key:"flavors",label:"Flavors",type:"flavors" },
  { key:"tags",label:"Tags",type:"tags" }
];

const modules: Module[] = [
  { id: "spirits", label: "Spirits & Mixers", singular: "Bottle", icon: Bottle, title: "The Bottle Library", subtitle: "Spirits, liqueurs, bitters, and every essential mixer.", primary: "name", secondary: "brand", makerKey: "brand", kindKey: "category", fields: [
    { key:"name",label:"Name" },{ key:"brand",label:"Brand / maker" },{ key:"category",label:"Family",options:SPIRIT_FAMILIES },
    { key:"sub_category",label:"Type" },{ key:"base_ingredient",label:"Base / grain",options:BASE_INGREDIENTS },
    { key:"abv",label:"ABV %",type:"number" },{ key:"volume_ml",label:"Volume (ml)",type:"number" },{ key:"fill_level",label:"Fill",type:"fillLevel" },
    { key:"purchase_date",label:"Purchase date",type:"date" },{ key:"opened_date",label:"Date opened",type:"date" },{ key:"shelf_location",label:"Shelf location" },{ key:"upc",label:"UPC" },
    { key:"stock_count",label:"Bottles",type:"spiritStock" },{ key:"image_url",label:"Photo",type:"image" },
    { key:"notes",label:"Cellar notes",type:"textarea" },{ key:"tasting_notes",label:"Tasting notes",type:"tasting" },
    { key:"flavors",label:"Flavors",type:"flavors" },{ key:"tags",label:"Tags",type:"tags" }
  ]},
  { id: "taps", label: "Draft Taps", singular: "Tap", icon: Beer, title: "On Tap", subtitle: "Seven handles. Empty taps show None until something is pouring.", primary: "brewery_batch", secondary: "style", makerKey: "maker", kindKey: "style", fields: [
    {key:"tap_number",label:"Tap #",type:"tapNumber"},{key:"maker",label:"Brewery / maker"},{key:"brewery_batch",label:"Beer / batch"},
    {key:"keg_size_l",label:"Keg size",type:"kegSize"},{key:"source_type",label:"Source",options:["Commercial","Homebrew"]},
    {key:"abv",label:"ABV %",type:"number"},{key:"ibu",label:"IBU",type:"number"},{key:"tapped_date",label:"Date tapped",type:"date"},
    {key:"remaining_l",label:"Keg remaining",type:"kegRemaining"},
    {key:"image_url",label:"Photo",type:"image"},
    ...beerFields, {key:"notes",label:"Cellar notes",type:"textarea"}
  ]},
  { id: "brews", label: "Brewery", singular: "Batch", icon: FlaskConical, title: "Brewery Lab", subtitle: "Plan batches and follow fermentation through the cellar.", primary: "batch_name", secondary: "style", makerKey: "maker", kindKey: "style", fields: [
    {key:"batch_name",label:"Batch name"},{key:"maker",label:"Brewery / maker"},
    {key:"brew_date",label:"Brew date",type:"date"},{key:"status",label:"Status",type:"brewStatus"},
    {key:"style",label:"Style",options:BEER_STYLES},{key:"base_ingredient",label:"Base / grain",options:BASE_INGREDIENTS},
    {key:"hops",label:"Hops used",type:"hops"},
    {key:"target_og",label:"Target OG",type:"gravity"},{key:"target_fg",label:"Target FG",type:"gravity"},
    {key:"measured_og",label:"Measured OG",type:"gravity"},{key:"measured_fg",label:"Measured FG",type:"gravity"},
    {key:"calculated_abv",label:"Calculated ABV %",type:"brewAbv"},
    {key:"flavors",label:"Flavor profile",type:"flavors"},
    {key:"tasting_notes",label:"Tasting notes",type:"tasting"},
    {key:"schedule",label:"Dry hop / adjunct schedule",type:"textarea"},
    {key:"image_url",label:"Photo",type:"image"},
    {key:"tags",label:"Tags",type:"tags"},
    {key:"notes",label:"Brew notes",type:"textarea"}
  ]},
  { id: "packaged_beer", label: "Packaged Beer", singular: "Beer", icon: Beer, title: "Packaged Beer", subtitle: "The cold-room count for cans and bottles.", primary: "name", secondary: "brewery", makerKey: "brewery", kindKey: "style", fields: [
    {key:"brewery",label:"Brewery / maker"},{key:"name",label:"Name"},
    {key:"vessel",label:"Can or bottle",options:[...BEER_VESSELS]},
    {key:"count",label:"In the cold room",type:"packagedCount"},
    {key:"pack_date",label:"Pack date",type:"date"},{key:"abv",label:"ABV %",type:"number"},{key:"upc",label:"UPC"},{key:"image_url",label:"Photo",type:"image"},
    ...beerFields, {key:"notes",label:"Cellar notes",type:"textarea"}
  ]},
  { id: "wines", label: "Wine Cellar", singular: "Wine", icon: Grape, title: "The Wine Cellar", subtitle: "Track bottles, vintages, pairings, and what's on the shelf.", primary: "name", secondary: "producer", makerKey: "producer", kindKey: "type", fields: [
    {key:"producer",label:"Producer / maker"},{key:"name",label:"Wine name"},{key:"varietal",label:"Varietal"},{key:"vintage",label:"Vintage",type:"number"},
    {key:"type",label:"Family",options:[...WINE_FAMILIES]},{key:"style",label:"Sparkling style",options:[...SPARKLING_STYLES]},
    {key:"base_ingredient",label:"Base / fruit",options:BASE_INGREDIENTS},{key:"region",label:"Region"},{key:"sweetness",label:"Sweetness",type:"wineSweetness"},
    {key:"bottle_count",label:"Bottle count",type:"number"},{key:"pairings",label:"Pairings"},{key:"upc",label:"UPC"},{key:"image_url",label:"Photo",type:"image"},
    {key:"notes",label:"Cellar notes",type:"textarea"},{key:"tasting_notes",label:"Tasting notes",type:"tasting"},
    {key:"flavors",label:"Flavors",type:"flavors"},{key:"tags",label:"Tags",type:"tags"}
  ]}
];

const themePresets: Record<string, Record<string,string>> = {
  light: { "--bg":"#f4f0e8","--surface":"#fffdf8","--surface-2":"#ebe5d9","--text":"#252018","--muted":"#70675b","--line":"#d8d0c2","--accent":"#8f4d2e","--accent-2":"#dba95f" },
  dark: { "--bg":"#11100e","--surface":"#1a1815","--surface-2":"#24211c","--text":"#f4ecdf","--muted":"#a69b8b","--line":"#39342c","--accent":"#c77647","--accent-2":"#e1b46e" },
  oled: { "--bg":"#000","--surface":"#080808","--surface-2":"#111","--text":"#f5f1ea","--muted":"#98928a","--line":"#26231f","--accent":"#d37d4e","--accent-2":"#edbd72" }
};

function applyTheme(theme: string, tokens?: Record<string,string>) {
  const values = { ...(themePresets[theme] ?? themePresets.dark), ...tokens };
  Object.entries(values).forEach(([key,value]) => document.documentElement.style.setProperty(key, value));
  document.documentElement.dataset.theme = theme;
}

type ScanModuleId = "spirits" | "packaged_beer" | "wines";
type ScanDraft = {
  moduleId: ScanModuleId;
  values: Record<string, unknown>;
  key: number;
  mode: "view" | "edit" | "create";
  guestAdd?: boolean;
};

function itemId(values: Record<string, unknown> | undefined) {
  const id = Number(values?.id);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function scannedInventoryDraft(result: ScanResult): ScanDraft {
  const product = result.product ?? {};
  const text = (...keys:string[]) => keys.map((key)=>product[key]).find((value)=>typeof value==="string"&&value.trim()) as string|undefined;
  const categories = text("categories","category") ?? "";
  const productType = text("product_type") ?? "";
  const isBeer = /beer|ale|lager|stout|porter|ipa|cider|seltzer|malt/i.test(`${categories} ${productType}`);
  const isWine = /wine|sparkling|vermouth|sake|mead/i.test(`${categories} ${productType}`);
  const rawAbv = product.abv ?? product.alcohol_100g ?? (product.nutriments as Record<string,unknown>|undefined)?.alcohol_100g;
  const abv = typeof rawAbv==="number" ? rawAbv : Number.parseFloat(String(rawAbv??"")) || 0;
  const name = text("product_name","product_name_en","name") ?? "";
  const brand = text("brands","brand","producer","brewery") ?? "";
  const upc = result.upc ?? text("code","upc") ?? "";
  const image = text("image_front_url","image_url") ?? "";
  const notes = text("notes") ?? "";
  const volume = typeof product.volume_ml === "number" ? product.volume_ml : Number.parseFloat(String(product.volume_ml ?? "")) || 750;
  const moduleId = result.table === "packaged_beer" || result.table === "wines" || result.table === "spirits"
    ? result.table
    : isBeer ? "packaged_beer" : isWine ? "wines" : "spirits";
  if (moduleId === "packaged_beer") {
    return {
      moduleId: "packaged_beer",
      key: Date.now(),
      mode: "create",
      values: { name, brewery: brand, style: categories.split(",")[0] ?? "", abv, count: 1, vessel: /bottle/i.test(`${categories} ${productType} ${name}`) ? "Bottle" : "Can", upc, image_url: image }
    };
  }
  if (moduleId === "wines") {
    const inferred = inferWineFamilyAndStyle(`${name} ${brand} ${categories} ${productType}`);
    return {
      moduleId: "wines",
      key: Date.now(),
      mode: "create",
      values: {
        name,
        producer: brand,
        varietal: categories.split(",")[0] ?? "",
        type: inferred.type,
        style: inferred.style,
        sweetness: defaultSweetnessForWine(inferred.type, inferred.style),
        region: text("origin") ?? "",
        bottle_count: 1,
        notes,
        upc,
        image_url: image
      }
    };
  }
  return {
    moduleId: "spirits",
    key: Date.now(),
    mode: "create",
    values: {
      name,
      brand,
      category: categories.split(",")[0] || "Mixer",
      sub_category: text("sub_category","derived_subcategory") ?? "",
      abv,
      upc,
      image_url: image,
      stock_count: Number(product.stock_count ?? product.bottle_count ?? 1) || 1,
      fill_level: Number(product.fill_level ?? product.fill_level_percent ?? 100) || 100,
      volume_ml: volume,
      notes
    }
  };
}

function mapDraftToModule(module: Module, draft: ScanDraft) {
  if (module.id === "taps") {
    return {
      maker: draft.values.brewery ?? draft.values.brand ?? draft.values.maker ?? "",
      brewery_batch: draft.values.name ?? draft.values.batch_name ?? "",
      style: draft.values.style ?? "",
      abv: draft.values.abv ?? draft.values.calculated_abv ?? 0,
      image_url: draft.values.image_url ?? "",
      source_type: draft.values.source_type ?? "Commercial"
    };
  }
  if (module.id === "brews") {
    return {
      maker: draft.values.brewery ?? draft.values.brand ?? draft.values.maker ?? "",
      batch_name: draft.values.name ?? draft.values.batch_name ?? "",
      style: draft.values.style ?? "",
      calculated_abv: draft.values.abv ?? draft.values.calculated_abv ?? 0,
      image_url: draft.values.image_url ?? "",
      tasting_notes: draft.values.tasting_notes ?? "",
      status: "Planned"
    };
  }
  return draft.values;
}

function brewAbvDisplay(item: Record<string, unknown>): string {
  return formatAbv(brewAbv(item) ?? item.calculated_abv ?? item.abv);
}

function findBeerLabel(moduleId: string) {
  return moduleId === "taps" || moduleId === "brews" || moduleId === "packaged_beer" ? "Find beer" : "Find bottle";
}

async function resolveSuggestion(module: Module, hit: BottleSearchHit) {
  if (hit.table === "brews") {
    return module.id === "taps" ? brewToTap(hit.product) : {
      maker: hit.product.maker ?? "",
      batch_name: hit.product.batch_name ?? hit.product.name ?? "",
      style: hit.product.style ?? "",
      calculated_abv: hit.product.calculated_abv ?? hit.product.abv ?? 0,
      image_url: hit.product.image_url ?? ""
    };
  }
  let product = hit.product;
  if (hit.source === "cola_cloud" && hit.ttb_id) {
    const enriched = await api<ScanResult>(`/cola/enrich/${encodeURIComponent(hit.ttb_id)}`);
    if (enriched.product) product = enriched.product;
  }
  const draft = scannedInventoryDraft({
    source: hit.source === "vault" ? "vault" : "cola_cloud",
    table: hit.table,
    upc: String(product.upc ?? ""),
    product
  });
  return mapDraftToModule(module, draft);
}

export default function App() {
  const [page, setPage] = useState("dashboard");
  const [admin, setAdmin] = useState(tokenExists());
  const [mobileNav, setMobileNav] = useState(false);
  const [scanner, setScanner] = useState(false);
  const [unlock, setUnlock] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem("smokey-theme") ?? "dark");
  const [backupDue, setBackupDue] = useState(false);
  const [scanDraft, setScanDraft] = useState<ScanDraft>();
  const [tapSeed, setTapSeed] = useState<Item>();
  const [sharedRecipeUrl, setSharedRecipeUrl] = useState("");
  const scanReviewResolver = useRef<((outcome: ScanReviewOutcome) => void) | undefined>(undefined);
  const lock = useCallback(() => { clearToken(); setAdmin(false); }, []);

  useEffect(() => { applyTheme(theme); localStorage.setItem("smokey-theme", theme); }, [theme]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const found = extractSharedRecipeUrl({
      url: params.get("url"),
      text: params.get("text"),
      title: params.get("title")
    });
    if (!found) return;
    setSharedRecipeUrl(found);
    setPage("cocktails");
    window.history.replaceState({}, "", window.location.pathname || "/");
  }, []);
  useEffect(() => {
    if (!admin) return;
    api<Record<string,string>>("/settings").then((values) => {
      const last = Date.parse(values.lastBackupDownload ?? "");
      setBackupDue(!last || Date.now() - last > 30 * 86400000);
      if (values.themeTokens) {
        try { applyTheme("custom", JSON.parse(values.themeTokens)); } catch { /* ignore invalid saved tokens */ }
      }
    }).catch(() => {});
    let timer = window.setTimeout(lock, 15 * 60_000);
    const touch = () => { clearTimeout(timer); timer = window.setTimeout(lock, 15 * 60_000); };
    ["pointerdown","keydown","scroll"].forEach((event) => window.addEventListener(event, touch, { passive:true }));
    return () => { clearTimeout(timer); ["pointerdown","keydown","scroll"].forEach((event) => window.removeEventListener(event, touch)); };
  }, [admin, lock]);

  const navigate = (next: string) => { setPage(next); setMobileNav(false); };
  function handleScan(result: ScanResult) {
    const table = result.table;
    const vaultId = result.source === "vault" && table ? itemId(result.product) : 0;
    const draft: ScanDraft = vaultId && table
      ? { moduleId: table, key: Date.now(), values: result.product, mode: admin ? "edit" : "view" }
      : { ...scannedInventoryDraft(result), guestAdd: !admin };
    setScanDraft(draft);
    navigate(draft.moduleId);
    if (draft.mode === "view") setScanner(false);
    return new Promise<ScanReviewOutcome>((resolve) => {
      scanReviewResolver.current = resolve;
    });
  }
  function finishScanReview(outcome: ScanReviewOutcome) {
    setScanDraft(undefined);
    scanReviewResolver.current?.(outcome);
    scanReviewResolver.current = undefined;
  }
  const nav = [
    { id:"dashboard",label:"Overview",icon:LayoutDashboard }, ...modules.map((m) => ({ id:m.id,label:m.label,icon:m.icon })),
    { id:"cocktails",label:"Cocktails & Seasonal",icon:Wine },{ id:"mixologist",label:"AI Mixologist",icon:Sparkles },
    { id:"next",label:"What's next",icon:ThumbsUp },
    { id:"restock",label:"Restock",icon:ShoppingBag,admin:true },{ id:"settings",label:"Settings",icon:Settings,admin:true }
  ];

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <button className="mobile-close icon-button" onClick={() => setMobileNav(false)}><X/></button>
        <div className="brand"><div className="brand-mark"><Wine/></div><div><strong>The Smokey Vault</strong><span>PRIVATE CELLAR</span></div></div>
        <nav>
          <span className="nav-label">COLLECTION</span>
          {nav.filter((n) => !n.admin || admin).map((item) => <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => navigate(item.id)}><item.icon size={19}/>{item.label}<ChevronRight size={15}/></button>)}
        </nav>
        <div className="sidebar-footer">
          <button onClick={() => admin ? lock() : setUnlock(true)}>{admin ? <LockOpen/> : <Lock/>}<span><strong>{admin ? "Admin unlocked" : "Guest menu"}</strong><small>{admin ? "Tap to lock" : "Read-only access"}</small></span></button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setMobileNav(true)}><Menu/></button>
          <div className="top-actions">
            <button className="icon-button" onClick={() => setTheme(theme === "light" ? "dark" : theme === "dark" ? "oled" : "light")} aria-label="Change theme">{theme === "light" ? <Sun/> : <Moon/>}</button>
            <button className="scan-button" onClick={() => setScanner(true)}><Search size={18}/> Scan bottle</button>
            <button className="icon-button lock-button" onClick={() => admin ? lock() : setUnlock(true)} aria-label={admin ? "Lock admin mode" : "Unlock admin mode"}>{admin ? <LockOpen/> : <Lock/>}</button>
          </div>
        </header>
        {admin && backupDue && <button className="backup-banner" onClick={() => navigate("settings")}><Database size={17}/><span>Your last portable backup is over 30 days old.</span><strong>Back up now</strong></button>}
        <div className="page">
          {page === "dashboard" && <Dashboard admin={admin} go={navigate}/>}
          {modules.map((module) => page === module.id && <Inventory
            key={module.id}
            module={module}
            admin={admin}
            scanDraft={scanDraft?.moduleId===module.id?scanDraft:undefined}
            finishScanReview={finishScanReview}
            openScanner={() => setScanner(true)}
            seedCreate={module.id === "taps" ? tapSeed : undefined}
            onSeedConsumed={() => setTapSeed(undefined)}
            onPutOnTap={admin && module.id === "brews" ? async (brew) => {
              const taps = await api<Item[]>("/inventory/taps");
              const slot = [...taps].sort((a, b) => Number(a.tap_number) - Number(b.tap_number)).find(isTapEmpty) ?? taps[0];
              setTapSeed({
                ...(slot ?? { tap_number: firstEmptyTapNumber(taps) }),
                ...brewToTap(brew),
                id: slot?.id ?? 0,
                tap_number: slot?.tap_number ?? firstEmptyTapNumber(taps),
                keg_size_l: slot?.keg_size_l ?? DEFAULT_KEG_L
              } as Item);
              navigate("taps");
            } : undefined}
          />)}
          {page === "cocktails" && <Cocktails admin={admin} sharedUrl={sharedRecipeUrl} onSharedConsumed={() => setSharedRecipeUrl("")}/>}
          {page === "mixologist" && <Mixologist admin={admin} goSettings={()=>navigate("settings")}/>}
          {page === "next" && <WhatsNextPage admin={admin}/>}
          {page === "restock" && admin && <RestockPage go={navigate}/>}
          {page === "settings" && admin && <SettingsPage theme={theme} setTheme={setTheme}/>}
        </div>
      </main>
      {mobileNav && <button className="nav-backdrop" onClick={() => setMobileNav(false)} aria-label="Close navigation"/>}
      {scanner && !scanDraft && !unlock && <Scanner onClose={() => setScanner(false)} onProduct={handleScan}/>}
      {scanDraft?.guestAdd && !unlock && <GuestAddPrompt draft={scanDraft} onUnlock={() => setUnlock(true)} onClose={() => { finishScanReview("cancelled"); setScanner(false); }}/>}
      {unlock && <Unlock onClose={() => { setUnlock(false); if (scanDraft?.guestAdd) return; if (scanDraft) finishScanReview("cancelled"); }} onSuccess={() => { setAdmin(true); setUnlock(false); if (scanDraft?.guestAdd) setScanDraft({ ...scanDraft, guestAdd: false, mode: "create" }); }}/>}
    </div>
  );
}

function Dashboard({ admin, go }: { admin: boolean; go: (page: string) => void }) {
  const [snap, setSnap] = useState<OverviewSnapshot>();
  const [restock, setRestock] = useState<{ items: RestockItem[]; open: number; total: number }>();
  const [error, setError] = useState("");
  const greeting = overviewGreeting(new Date(), !admin);
  function load() {
    setError("");
    api<OverviewSnapshot>("/overview")
      .then(setSnap)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the house snapshot."));
    if (!admin) {
      setRestock(undefined);
      return;
    }
    api<{ items: RestockItem[]; open: number; total: number }>("/restock")
      .then(setRestock)
      .catch(() => setRestock(undefined));
  }
  useEffect(() => { load(); }, [admin]);
  const orbitValue = snap?.spirits.on_shelf ?? 0;
  const orbitLabel = "BOTTLES";
  const stats = snap ? (admin ? [
    { id: "spirits", icon: Bottle, value: snap.spirits.on_shelf, label: "ON THE SHELF", hint: snap.spirits.low ? `${snap.spirits.low} running low` : "Spirits & mixers" },
    { id: "taps", icon: Beer, value: snap.taps.pouring, label: "POURING", hint: `${snap.taps.empty} open handle${snap.taps.empty === 1 ? "" : "s"}` },
    { id: "brews", icon: FlaskConical, value: snap.brews.active, label: "IN THE LAB", hint: snap.brews.archived ? `${snap.brews.archived} archived` : "Active batches" },
    { id: "packaged_beer", icon: Beer, value: snap.packaged.units, label: "COLD ROOM", hint: snap.packaged.out ? `${snap.packaged.out} out of stock` : "Cans & bottles" },
    { id: "wines", icon: Grape, value: snap.wines.bottles, label: "WINE CELLAR", hint: `${snap.wines.labels} on the rack` },
    { id: "cocktails", icon: Wine, value: snap.cocktails.ready, label: "READY TO POUR", hint: snap.cocktails.almost ? `${snap.cocktails.almost} one bottle away` : "Matched to the shelf" }
  ] : [
    { id: "taps", icon: Beer, value: snap.taps.pouring, label: "POURING", hint: "What’s on tap tonight" },
    { id: "cocktails", icon: Wine, value: snap.cocktails.ready, label: "OFF THE MENU", hint: "We’ve never tried this before" },
    { id: "spirits", icon: Bottle, value: snap.spirits.on_shelf, label: "ON THE SHELF", hint: "Spirits & mixers" },
    { id: "wines", icon: Grape, value: snap.wines.bottles, label: "WINE CELLAR", hint: "On the rack" }
  ]) : [];
  async function pourTicket(id: number) {
    await api(`/cocktails/tickets/${id}/pour`, { method: "POST" });
    load();
  }
  async function removeTicket(id: number) {
    await api(`/cocktails/tickets/${id}`, { method: "DELETE" });
    load();
  }
  const ticketBoard = snap && snap.tickets.length > 0 ? <section className="ticket-board">
      <div className="section-heading"><div><span className="eyebrow">ON THE TICKET</span><h2>Make for someone</h2></div><span className="guest-badge">{snap.tickets.length}</span></div>
      <div className="ticket-row">
        {snap.tickets.map((ticket) => (
          <article className="ticket-card" key={ticket.id}>
            {ticket.image_url ? <img src={ticket.image_url} alt=""/> : null}
            <div>
              <span className="eyebrow">FOR {ticket.guest_name.toUpperCase()}</span>
              <h3>{ticket.name}</h3>
              {ticket.notes ? <p>{ticket.notes}</p> : null}
            </div>
            <div className="ticket-actions">
              <button type="button" className="secondary" onClick={() => go("cocktails")}>Open recipes</button>
              {admin && <button type="button" className="primary" onClick={() => void pourTicket(ticket.id)}>Poured</button>}
              {admin && <button type="button" className="icon-button danger" aria-label="Remove ticket" onClick={() => void removeTicket(ticket.id)}><Trash2 size={16}/></button>}
            </div>
          </article>
        ))}
      </div>
    </section> : null;
  return <>
    {error && <div className="ai-error load-error"><CircleAlert/><div><strong>Could not load Overview</strong><span>{error}</span></div></div>}
    <div className="hero">
      <div className="hero-copy">
        <span className="eyebrow">{greeting.eyebrow}</span>
        <h1>{greeting.line}<br/><em>{greeting.emphasize}</em></h1>
      </div>
      <div className="hero-orbit" aria-label={`${orbitValue} bottles on the shelf`}>
        <Wine/>
        <span>{orbitValue}<small>{orbitLabel}</small></span>
      </div>
      <p className="hero-lede">{snap ? overviewHeroCopy(snap, !admin) : "Browse the collection, see what is pouring, and find your next perfect drink."}</p>
    </div>
    <section>
      <div className="section-heading">
        <div><span className="eyebrow">AT A GLANCE</span><h2>Inside the vault</h2></div>
        {!admin && <span className="guest-badge"><Lock size={13}/> DIGITAL BAR MENU</span>}
      </div>
      <div className={`stat-grid${!admin ? " guest-stats" : ""}`}>
        {stats.map((stat) => (
          <button className="stat-card" key={stat.id} onClick={() => go(stat.id)}>
            <stat.icon/>
            <span>{stat.value}</span>
            <small>{stat.label}</small>
            <b className="stat-hint">{stat.hint}</b>
            <ChevronRight/>
          </button>
        ))}
      </div>
    </section>
    {admin && ticketBoard}
    {snap && <section className="overview-board">
      <div className="section-heading"><div><span className="eyebrow">ON TAP</span><h2>What's pouring</h2></div><button type="button" className="secondary" onClick={() => go("taps")}>All handles</button></div>
      <div className="overview-taps">
        {(snap.taps.list.length ? snap.taps.list : Array.from({ length: 7 }, (_, i) => ({
          tap_number: i + 1, title: "None", maker: "", style: "", abv: "", remaining_pct: 0, pints: 0, image_url: "", source_type: "", empty: true
        }))).map((tap) => (
          <button type="button" className={`overview-tap${tap.empty ? " empty" : ""}`} key={tap.tap_number} onClick={() => go("taps")}>
            <span className="eyebrow">TAP {tap.tap_number}</span>
            <strong>{tap.title}</strong>
            <small>{tap.empty ? "Nothing pouring" : [tap.style, tap.abv ? `${tap.abv}%` : "", admin && tap.pints ? `${tap.pints} pints` : ""].filter(Boolean).join(" · ")}</small>
            {!tap.empty && <span className="overview-tap-fill"><span style={{ width: `${tap.remaining_pct}%` }}/></span>}
          </button>
        ))}
      </div>
    </section>}
    {admin && snap && snap.cocktails.favorites.length > 0 && <section className="favorite-board">
      <div className="section-heading"><div><span className="eyebrow">BEHIND THE STICK</span><h2>Bartender favorites</h2></div><button type="button" className="secondary" onClick={() => go("cocktails")}>Recipe book</button></div>
      <div className="favorite-row">
        {snap.cocktails.favorites.map((drink) => (
          <button type="button" className="favorite-card" key={drink.id} onClick={() => go("cocktails")}>
            <div className="card-icon">{drink.image_url ? <img src={drink.image_url} alt=""/> : <Star/>}</div>
            <div>
              <span className="eyebrow">{drink.readiness === "ready" ? "READY TO POUR" : drink.readiness === "almost" ? "ONE ITEM AWAY" : "BUILD THE SHELF"}</span>
              <strong>{drink.name}</strong>
              <small>{[drink.method, drink.glassware].filter(Boolean).join(" · ")}</small>
            </div>
          </button>
        ))}
      </div>
    </section>}
    {!admin && snap && snap.cocktails.offMenu.length > 0 && <section className="favorite-board">
      <div className="section-heading"><div><span className="eyebrow">WE’VE NEVER TRIED THIS BEFORE</span><h2>Off the menu</h2></div><button type="button" className="secondary" onClick={() => go("cocktails")}>Recipe book</button></div>
      <div className="favorite-row">
        {snap.cocktails.offMenu.map((drink) => (
          <button type="button" className="favorite-card" key={drink.id} onClick={() => go("cocktails")}>
            <div className="card-icon">{drink.image_url ? <img src={drink.image_url} alt=""/> : <Wine/>}</div>
            <div>
              <span className="eyebrow">OFF THE MENU</span>
              <strong>{drink.name}</strong>
              <small>{[drink.method, drink.glassware].filter(Boolean).join(" · ")}</small>
            </div>
          </button>
        ))}
      </div>
    </section>}
    {!admin && ticketBoard}
    {admin && snap && snap.brews.list.length > 0 && <section className="overview-board">
      <div className="section-heading"><div><span className="eyebrow">BREWERY LAB</span><h2>In the pipeline</h2></div><button type="button" className="secondary" onClick={() => go("brews")}>Open lab</button></div>
      <div className="overview-brew-row">
        {snap.brews.list.map((brew) => (
          <button type="button" className="overview-brew" key={brew.id || brew.batch_name} onClick={() => go("brews")}>
            <span className="eyebrow">{brew.status.toUpperCase()}</span>
            <strong>{brew.batch_name}</strong>
            <small>{[brew.style, brew.abv ? `${brew.abv}% ABV` : "", brew.on_tap].filter(Boolean).join(" · ")}</small>
          </button>
        ))}
      </div>
    </section>}
    {admin && restock && restock.open > 0 && <section className="overview-board">
      <div className="section-heading">
        <div><span className="eyebrow">NEED TO RESTOCK</span><h2>{restock.open} to pick up</h2></div>
        <button type="button" className="secondary" onClick={() => go("restock")}>Open list</button>
      </div>
      <div className="overview-low-row">
        {restock.items.filter((item) => !item.got).slice(0, 8).map((item) => (
          <button type="button" className="overview-low" key={item.key} onClick={() => go("restock")}>
            <div className="card-icon">{item.image_url ? <img src={item.image_url} alt=""/> : <ShoppingBag/>}</div>
            <div>
              <span className="eyebrow">{item.kind === "wanted" ? "WANTED" : item.kind === "ingredient" ? "MIXER" : item.kind === "wines" ? "WINE" : item.kind === "packaged_beer" ? "COLD ROOM" : "SPIRITS"}</span>
              <strong>{item.name}</strong>
              <small>{item.reason}</small>
            </div>
          </button>
        ))}
      </div>
    </section>}
    {admin && snap && snap.low.length > 0 && !(restock && restock.open > 0) && <section className="overview-board">
      <div className="section-heading"><div><span className="eyebrow">CELLAR WATCH</span><h2>Running low</h2></div></div>
      <div className="overview-low-row">
        {snap.low.map((item) => (
          <button type="button" className="overview-low" key={`${item.module}-${item.id}`} onClick={() => go(item.module)}>
            <div className="card-icon">{item.image_url ? <img src={item.image_url} alt=""/> : <Bottle/>}</div>
            <div>
              <span className="eyebrow">{item.module === "wines" ? "WINE" : item.module === "packaged_beer" ? "COLD ROOM" : "SPIRITS"}</span>
              <strong>{item.name}</strong>
              <small>{item.detail}</small>
            </div>
          </button>
        ))}
      </div>
    </section>}
    <section className="feature-grid">
      <button className="feature-card warm" onClick={() => go("cocktails")}><div><span className="eyebrow">SURPRISE ME · SEASONAL</span><h2>What can I make?</h2><p>Inventory-matched recipes, random picks, and drinks on the ticket.</p></div><Shuffle size={56}/></button>
      <button className="feature-card" onClick={() => go("mixologist")}><div><span className="eyebrow">CUSTOM CREATIONS</span><h2>Ask the Mixologist</h2><p>{admin ? "Describe the mood. Your own AI key powers the pour." : "Describe the mood. We’ll mix from what’s on the shelf."}</p></div><Sparkles size={56}/></button>
      <button className="feature-card" onClick={() => go("next")}><div><span className="eyebrow">GUEST PICKS</span><h2>What’s next?</h2><p>Request liquor and wine, then vote the next keg and brew Nick puts up.</p></div><ThumbsUp size={56}/></button>
    </section>
  </>;
}

type RestockList = { items: RestockItem[]; open: number; total: number; thresholds?: RestockThresholds };

function restockRuleHint(thresholds?: RestockThresholds): string {
  const rules = parseRestockThresholds({
    restockPackagedBelow: thresholds ? String(thresholds.packagedBelow) : undefined,
    restockSpiritFill: thresholds ? String(thresholds.spiritFill) : undefined,
    restockWineBelow: thresholds ? String(thresholds.wineBelow) : undefined
  });
  const fill = FILL_STOPS.find((stop) => stop.percent === rules.spiritFill)?.label ?? "¼";
  return `Cans below ${rules.packagedBelow} · spirits at or below ${fill} · wine below ${rules.wineBelow}`;
}

function restockKindLabel(kind: RestockItem["kind"]): string {
  if (kind === "wanted") return "WANTED";
  if (kind === "ingredient") return "MIXER / BOTTLE";
  if (kind === "wines") return "WINE";
  if (kind === "packaged_beer") return "COLD ROOM";
  return "SPIRITS";
}

function RestockPage({ go }:{ go: (page: string) => void }) {
  const [data, setData] = useState<RestockList>();
  const [filter, setFilter] = useState<"open" | "got" | "all">("open");
  const [error, setError] = useState("");
  const [wantName, setWantName] = useState("");
  const [wantNote, setWantNote] = useState("");
  const [wantLabel, setWantLabel] = useState<WantedLabel>("bottle");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  function load() {
    setError("");
    api<RestockList>("/restock")
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the restock list."));
  }
  useEffect(() => { load(); }, []);
  async function toggle(item: RestockItem) {
    try {
      const next = await api<RestockList>("/restock/check", {
        method: "POST",
        body: JSON.stringify({ key: item.key, got: !item.got })
      });
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update that item");
    }
  }
  async function addWanted(e: React.FormEvent) {
    e.preventDefault();
    if (!wantName.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const next = await api<RestockList>("/restock/wanted", {
        method: "POST",
        body: JSON.stringify({ name: wantName, note: wantNote, label: wantLabel })
      });
      setData(next);
      setWantName("");
      setWantNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that");
    } finally {
      setSaving(false);
    }
  }
  async function dropWanted(item: RestockItem) {
    if (!item.id) return;
    try {
      const next = await api<RestockList>(`/restock/wanted/${item.id}`, { method: "DELETE" });
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not drop that");
    }
  }
  async function shareList() {
    const text = formatRestockShare(data?.items ?? []);
    if (!text) {
      setNotice("Nothing left to pick up.");
      return;
    }
    try {
      if (canShare) {
        await navigator.share({ title: "Smokey Vault restock", text });
        return;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setNotice("List copied. Paste it into Keep or anywhere else.");
    } catch {
      setNotice("Could not copy the list.");
    }
  }
  const shown = (data?.items ?? []).filter((item) => filter === "all" || (filter === "got" ? item.got : !item.got));
  const wanted = shown.filter((item) => item.kind === "wanted");
  const low = shown.filter((item) => item.kind !== "wanted");
  return <>
    <PageTitle
      eyebrow="STORE RUN"
      title="What to pick up."
      subtitle={data ? `${data.open} still needed · ${data.total} on the list. ${restockRuleHint(data.thresholds)}.` : "Empty bottles, low cans, last wines, mixers that unlock a favorite, and bottles you want for the vault."}
    />
    {error && <div className="ai-error load-error"><CircleAlert/><div><strong>Could not load restock</strong><span>{error}</span></div></div>}
    <section className="wanted-card">
      <span className="eyebrow">WANTED FOR THE VAULT</span>
      <h2>Not on the shelf yet</h2>
      <p>Add a bottle or mixer when it crosses your mind. It stays here until you drop it — even if it is not in inventory.</p>
      <form className="wanted-form" onSubmit={(e) => void addWanted(e)}>
        <div className="chip-row restock-stops">
          {([["bottle", "Bottle"], ["mixer", "Mixer"]] as const).map(([id, label]) => (
            <button type="button" key={id} className={`chip${wantLabel === id ? " active" : ""}`} onClick={() => setWantLabel(id)}>{label}</button>
          ))}
        </div>
        <input value={wantName} onChange={(e) => setWantName(e.target.value)} maxLength={MAX_WANTED_NAME} placeholder="Green Chartreuse, orgeat, a rye you keep meaning to buy…" autoComplete="off"/>
        <input value={wantNote} onChange={(e) => setWantNote(e.target.value)} maxLength={MAX_WANTED_NOTE} placeholder="Note (optional) — store, size, why"/>
        <button className="primary" disabled={!wantName.trim() || saving}><Plus size={16}/> Add to list</button>
      </form>
    </section>
    <div className="cocktail-toolbar">
      <div className="segmented cocktail-filters">
        {([["open", "Still need"], ["got", "Grabbed"], ["all", "All"]] as const).map(([id, label]) => (
          <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>
      <div className="toolbar-actions">
        <button type="button" className="secondary" onClick={() => void shareList()} disabled={!(data?.open)}>{canShare ? <Share2 size={16}/> : <Copy size={16}/>} {canShare ? "Share list" : "Copy list"}</button>
        <button type="button" className="secondary" onClick={() => go("settings")}>Change rules</button>
      </div>
    </div>
    {!shown.length ? <Empty icon={ShoppingBag} title={filter === "got" ? "Nothing grabbed yet" : "Shelf looks stocked"} text={filter === "got" ? "Tap a bottle when you pick it up." : "When something hits the cutoff you set, or you add a wanted bottle, it lands here."}/> :
      <div className="restock-list">
        {wanted.map((item) => (
          <div className={`restock-row${item.got ? " got" : ""}`} key={item.key}>
            <button type="button" className="restock-main" onClick={() => void toggle(item)}>
              <span className="restock-check" aria-hidden="true">{item.got ? "✓" : ""}</span>
              <div className="card-icon"><ShoppingBag/></div>
              <div>
                <span className="eyebrow">{restockKindLabel(item.kind)}</span>
                <strong>{item.name}</strong>
                <small>{item.reason}</small>
              </div>
            </button>
            <button type="button" className="icon-button danger restock-drop" aria-label="Drop from wanted list" onClick={() => void dropWanted(item)}><Trash2 size={17}/></button>
          </div>
        ))}
        {low.map((item) => (
          <button type="button" className={`restock-row${item.got ? " got" : ""}`} key={item.key} onClick={() => void toggle(item)}>
            <span className="restock-check" aria-hidden="true">{item.got ? "✓" : ""}</span>
            <div className="card-icon">{item.image_url ? <img src={item.image_url} alt=""/> : <ShoppingBag/>}</div>
            <div>
              <span className="eyebrow">{restockKindLabel(item.kind)}</span>
              <strong>{item.name}</strong>
              <small>{item.reason}</small>
            </div>
            {item.module ? <span className="restock-open" onClick={(e) => { e.stopPropagation(); go(item.module!); }}>Open</span> : null}
          </button>
        ))}
      </div>}
    {notice && <div className="toast">{notice}</div>}
  </>;
}

const SHELF_KINDS: { id: NextKind; label: string }[] = [
  { id: "spirits", label: "Liquor" },
  { id: "wines", label: "Wine" }
];

function nextKindLabel(kind: NextKind) {
  if (kind === "wines") return "WINE";
  if (kind === "keg") return "KEG";
  if (kind === "brew") return "BREW";
  return "LIQUOR";
}

function WhatsNextPage({ admin }: { admin: boolean }) {
  const [boards, setBoards] = useState<NextBoards>({ shelf: [], keg: [], brew: [] });
  const [error, setError] = useState("");
  const [shelfKind, setShelfKind] = useState<NextKind>("spirits");
  const [shelfQuery, setShelfQuery] = useState("");
  const [shelfLocked, setShelfLocked] = useState("");
  const [kegQuery, setKegQuery] = useState("");
  const [kegLocked, setKegLocked] = useState("");
  const [brewName, setBrewName] = useState("");
  const voter = voterId();

  function load() {
    setError("");
    api<NextBoards>(`/next?voter=${encodeURIComponent(voter)}`)
      .then(setBoards)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load What’s next."));
  }
  useEffect(() => { load(); }, []);

  async function add(partial: { board: "shelf" | "keg" | "brew"; name: string; maker?: string; kind?: NextKind; image_url?: string }) {
    setError("");
    try {
      const next = await api<NextBoards>("/next", {
        method: "POST",
        body: JSON.stringify({ voter, ...partial })
      });
      setBoards(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that");
    }
  }

  async function vote(id: number, value?: 1 | -1) {
    setError("");
    try {
      setBoards(await api<NextBoards>(`/next/${id}/vote`, { method: "POST", body: JSON.stringify({ voter, value }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save vote");
    }
  }

  async function drop(item: NextItem) {
    if (!confirm(`Remove ${item.name} from What’s next?`)) return;
    try {
      await api(`/next/${item.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that");
    }
  }

  function pickHit(board: "shelf" | "keg", hit: BottleSearchHit) {
    const name = String(hit.product.name ?? hit.product.product_name ?? hit.product.brewery_batch ?? hit.product.batch_name ?? "").trim();
    const maker = String(hit.product.brand ?? hit.product.brewery ?? hit.product.producer ?? hit.product.maker ?? "").trim();
    const kind: NextKind = board === "keg" ? "keg" : hit.table === "wines" ? "wines" : "spirits";
    void add({ board, name, maker, kind, image_url: String(hit.product.image_url ?? "") });
    if (board === "shelf") { setShelfQuery(""); setShelfLocked(name); }
    else { setKegQuery(""); setKegLocked(name); }
  }

  function submitFreeform(event: FormEvent, board: "shelf" | "keg" | "brew") {
    event.preventDefault();
    const name = board === "brew" ? brewName : board === "keg" ? kegQuery : shelfQuery;
    if (board === "shelf") void add({ board, name, kind: shelfKind });
    else if (board === "keg") void add({ board, name, kind: "keg" });
    else void add({ board, name, kind: "brew" });
    if (board === "shelf") { setShelfQuery(""); setShelfLocked(name); }
    if (board === "keg") { setKegQuery(""); setKegLocked(name); }
    if (board === "brew") setBrewName("");
  }

  function boardList(items: NextItem[], mode: "up" | "updown", empty: string) {
    if (!items.length) return <p className="next-empty">{empty}</p>;
    return <div className="next-list">
      {items.map((item) => (
        <div className="next-row" key={item.id}>
          {mode === "up" ? (
            <button type="button" className={`next-vote${item.mine === 1 ? " active" : ""}`} aria-pressed={item.mine === 1} aria-label={`Vote for ${item.name}`} onClick={() => void vote(item.id)}>
              <ThumbsUp size={18}/>
              <strong>{item.up}</strong>
            </button>
          ) : (
            <div className="next-vote-pair">
              <button type="button" className={`vote-button${item.mine === 1 ? " active" : ""}`} aria-label={`Upvote ${item.name}`} aria-pressed={item.mine === 1} onClick={() => void vote(item.id, 1)}>
                <ChevronUp size={22}/>
              </button>
              <div className="vote-score">
                <strong>{item.net}</strong>
                <small>{item.up} up · {item.down} down</small>
              </div>
              <button type="button" className={`vote-button down${item.mine === -1 ? " active" : ""}`} aria-label={`Downvote ${item.name}`} aria-pressed={item.mine === -1} onClick={() => void vote(item.id, -1)}>
                <ChevronDown size={22}/>
              </button>
            </div>
          )}
          <div className="card-icon">{item.image_url ? <img src={item.image_url} alt=""/> : <ThumbsUp size={18}/>}</div>
          <div className="next-main">
            <span className="eyebrow">{nextKindLabel(item.kind)}</span>
            <strong>{item.name}</strong>
            {item.maker ? <small>{item.maker}</small> : null}
          </div>
          {admin && <button type="button" className="icon-button danger" aria-label={`Remove ${item.name}`} onClick={() => void drop(item)}><Trash2 size={17}/></button>}
        </div>
      ))}
    </div>;
  }

  return <>
    <PageTitle
      eyebrow="GUEST PICKS"
      title="What’s next."
      subtitle="Ask for liquor and wine you want in the vault. Nick puts kegs and brew ideas on the board — tap up or down for what you’d actually drink."
    />
    {error && <div className="ai-error load-error"><CircleAlert/><div><strong>Could not update What’s next</strong><span>{error}</span></div></div>}

    <section className="next-board">
      <div className="section-heading"><div><span className="eyebrow">ON THE SHELF</span><h2>Liquor &amp; wine</h2></div></div>
      <div className="next-add">
        <div className="chip-row">
          {SHELF_KINDS.map((kind) => (
            <button type="button" key={kind.id} className={`chip${shelfKind === kind.id ? " active" : ""}`} onClick={() => setShelfKind(kind.id)}>{kind.label}</button>
          ))}
        </div>
        <form className="wanted-form" onSubmit={(event) => submitFreeform(event, "shelf")}>
          <div className="suggest-wrap">
            <input value={shelfQuery} onChange={(e) => { setShelfQuery(e.target.value); setShelfLocked(""); }} maxLength={MAX_NEXT_NAME} placeholder="Search a bottle or wine…" autoComplete="off"/>
            <BottleSuggest moduleId={shelfKind} query={shelfQuery} locked={shelfLocked} onPick={(hit) => pickHit("shelf", hit)}/>
          </div>
          <button className="primary" type="submit" disabled={!shelfQuery.trim()}><Plus size={16}/> Add to the board</button>
        </form>
      </div>
      {boardList(boards.shelf, "up", "Add a liquor or wine you want to see next.")}
    </section>

    <section className="next-board">
      <div className="section-heading"><div><span className="eyebrow">ON TAP</span><h2>Next keg</h2></div></div>
      <p className="next-lede">What would you actually drink if Nick tapped one of these?</p>
      {admin && <div className="next-add">
        <form className="wanted-form" onSubmit={(event) => submitFreeform(event, "keg")}>
          <div className="suggest-wrap">
            <input value={kegQuery} onChange={(e) => { setKegQuery(e.target.value); setKegLocked(""); }} maxLength={MAX_NEXT_NAME} placeholder="Search a beer or type a keg idea…" autoComplete="off"/>
            <BottleSuggest moduleId="keg" query={kegQuery} locked={kegLocked} onPick={(hit) => pickHit("keg", hit)}/>
          </div>
          <button className="primary" type="submit" disabled={!kegQuery.trim()}><Plus size={16}/> Put on the board</button>
        </form>
        <div className="chip-row restock-stops">
          {BEER_STYLES.filter((style) => style !== "Other").map((style) => (
            <button type="button" key={style} className="chip" onClick={() => void add({ board: "keg", name: style, kind: "keg" })}>{style}</button>
          ))}
        </div>
      </div>}
      {boardList(boards.keg, "updown", admin ? "Add keg options guests can vote on." : "Nick hasn’t put kegs up for a vote yet.")}
    </section>

    <section className="next-board">
      <div className="section-heading"><div><span className="eyebrow">IN THE LAB</span><h2>Next brew</h2></div></div>
      <p className="next-lede">Help Nick pick the next batch from the options he puts up.</p>
      {admin && <div className="next-add">
        <div className="chip-row restock-stops">
          {BEER_STYLES.filter((style) => style !== "Other").map((style) => (
            <button type="button" key={style} className="chip" onClick={() => void add({ board: "brew", name: style, kind: "brew" })}>{style}</button>
          ))}
        </div>
        <form className="wanted-form" onSubmit={(event) => submitFreeform(event, "brew")}>
          <input value={brewName} onChange={(e) => setBrewName(e.target.value)} maxLength={MAX_NEXT_NAME} placeholder="Coffee stout, hoppy pils, saison with apricot…"/>
          <button className="primary" type="submit" disabled={!brewName.trim()}><Plus size={16}/> Put on the board</button>
        </form>
      </div>}
      {boardList(boards.brew, "updown", admin ? "Add brew ideas guests can vote on." : "Nick hasn’t put brew ideas up for a vote yet.")}
    </section>
  </>;
}


function Inventory({ module, admin, scanDraft, finishScanReview, openScanner, seedCreate, onSeedConsumed, onPutOnTap }: {
  module: Module; admin: boolean; scanDraft?: ScanDraft; finishScanReview: (outcome: ScanReviewOutcome) => void; openScanner: () => void;
  seedCreate?: Item; onSeedConsumed?: () => void; onPutOnTap?: (item: Item) => void;
}) {
  const [items,setItems] = useState<Item[]>([]);
  const [search,setSearch] = useState("");
  const [editing,setEditing] = useState<Item | null | undefined>();
  const [viewing,setViewing] = useState<Item>();
  const [finderOpen,setFinderOpen] = useState(false);
  const [loadError,setLoadError] = useState("");
  const [taps,setTaps] = useState<Item[]>([]);
  const openedScanKey = useRef<number | undefined>(undefined);
  const load = useCallback(() => {
    setLoadError("");
    return api<Item[]>(`/inventory/${module.id}`).then(setItems).catch((err) => {
      setLoadError(err instanceof Error ? err.message : "Could not load this section.");
    });
  }, [module.id]);
  useEffect(() => { load(); setViewing(undefined); }, [load]);
  useEffect(() => {
    if (module.id !== "brews") {
      setTaps([]);
      return;
    }
    api<Item[]>("/inventory/taps").then(setTaps).catch(() => setTaps([]));
  }, [module.id, items]);
  useEffect(() => {
    if (!seedCreate) return;
    if (module.id === "taps" && items.length === 0) return;
    if (module.id === "taps") {
      const num = Number(seedCreate.tap_number);
      const slot = items.find((row) => Number(row.tap_number) === num) ?? items.find(isTapEmpty) ?? items[0];
      setViewing(undefined);
      setEditing({ ...slot, ...seedCreate, id: slot?.id ?? seedCreate.id } as Item);
    } else {
      setViewing(undefined);
      setEditing({ ...seedCreate, id: 0 } as Item);
    }
    onSeedConsumed?.();
  }, [seedCreate, items, onSeedConsumed, module.id]);
  useEffect(() => {
    if (!scanDraft || scanDraft.guestAdd || openedScanKey.current === scanDraft.key) return;
    openedScanKey.current = scanDraft.key;
    if (scanDraft.mode === "view") {
      setEditing(undefined);
      setViewing({ id: itemId(scanDraft.values), ...scanDraft.values } as Item);
      finishScanReview("viewed");
      return;
    }
    if (!admin) return;
    setViewing(undefined);
    setEditing({ ...scanDraft.values, id: scanDraft.mode === "edit" ? itemId(scanDraft.values) : 0 } as Item);
  }, [admin, scanDraft, finishScanReview]);
  const [maker,setMaker] = useState("All");
  const [kind,setKind] = useState("All");
  const [tag,setTag] = useState("All");
  const [flavor,setFlavor] = useState("All");
  const makers = ["All", ...uniqueValues(items, module.makerKey)];
  const kinds = ["All", ...(module.id === "wines" ? uniqueWineKinds(items) : uniqueValues(items, module.kindKey))];
  const tags = ["All", ...uniqueItemLists(items, "tags")];
  const flavors = ["All", ...uniqueItemLists(items, "flavors")];
  const filtered = items.filter((item) => {
    const haystack = JSON.stringify(item).toLowerCase();
    if (search && !haystack.includes(search.toLowerCase())) return false;
    if (maker !== "All" && String(item[module.makerKey] ?? "") !== maker) return false;
    if (kind !== "All") {
      if (module.id === "wines") {
        const label = wineKindLabel(String(item.type ?? ""), String(item.style ?? ""));
        if (String(item.type ?? "") !== kind && label !== kind) return false;
      } else if (String(item[module.kindKey] ?? "") !== kind) return false;
    }
    if (tag !== "All" && !parseList(item.tags).some((value) => value.toLowerCase() === tag.toLowerCase())) return false;
    if (flavor !== "All" && !parseList(item.flavors).some((value) => value.toLowerCase() === flavor.toLowerCase())) return false;
    return true;
  });
  const activeFilters = maker !== "All" || kind !== "All" || tag !== "All" || flavor !== "All" || Boolean(search.trim());
  async function remove(id:number) { if (!confirm("Remove this item from the vault?")) return; await api(`/inventory/${module.id}/${id}`,{method:"DELETE"}); setViewing(undefined); load(); }
  async function clearTap(item: Item) {
    if (!confirm("Clear this tap back to None?")) return;
    await api(`/inventory/taps/${item.id}`, { method: "PUT", body: JSON.stringify(emptyTapBeerFields()) });
    setViewing(undefined);
    load();
  }
  const listed = module.id === "taps"
    ? [...filtered].sort((a, b) => Number(a.tap_number) - Number(b.tap_number))
    : module.id === "brews"
      ? [...filtered].sort(compareBrews)
      : module.id === "packaged_beer"
        ? [...filtered].sort(comparePackagedBeer)
        : module.id === "spirits"
          ? [...filtered].sort(compareSpirits)
          : filtered;
  const canFind = ["spirits","packaged_beer","wines","taps","brews"].includes(module.id);
  const emptyActions = admin ? <>
    {canFind && <button className="secondary" onClick={() => setFinderOpen(true)}><Search size={17}/> {findBeerLabel(module.id)}</button>}
    <button className="primary" onClick={() => setEditing(null)}><Plus/> Add {module.singular}</button>
    <button className="secondary" onClick={openScanner}><Search size={17}/> Scan bottle</button>
  </> : undefined;

  if (viewing) {
    return <BottleDetail
      module={module}
      item={viewing}
      admin={admin}
      onBack={() => setViewing(undefined)}
      onEdit={() => { setEditing(viewing); setViewing(undefined); }}
      onDelete={() => module.id === "taps" ? clearTap(viewing) : remove(viewing.id)}
      onUpdated={(next) => { setViewing(next); load(); }}
      onPutOnTap={onPutOnTap ? () => onPutOnTap(viewing) : undefined}
      tapNumbers={module.id === "brews" ? tapsForBatch(taps, viewing.batch_name) : []}
    />;
  }

  return <>
    <PageTitle eyebrow={module.label.toUpperCase()} title={module.title} subtitle={module.subtitle}/>
    <div className="toolbar">
      <label className="search"><Search/><input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder={`Filter ${module.label.toLowerCase()}…`}/></label>
      {admin && <div className="toolbar-actions">
        {canFind && <button className="secondary" onClick={() => setFinderOpen(true)}><Search size={17}/> {findBeerLabel(module.id)}</button>}
        {module.id !== "taps" && <button className="primary" onClick={() => setEditing(null)}><Plus/> Add {module.singular}</button>}
      </div>}
    </div>
    {items.length > 0 && <div className="filter-row">
      <select value={maker} onChange={(e)=>setMaker(e.target.value)} aria-label="Filter by maker">{makers.map((value)=><option key={value}>{value === "All" ? "All makers" : value}</option>)}</select>
      <select value={kind} onChange={(e)=>setKind(e.target.value)} aria-label="Filter by type">{kinds.map((value)=><option key={value}>{value === "All" ? (module.id === "spirits" ? "All families" : module.id === "wines" ? "All wine types" : "All styles") : value}</option>)}</select>
      <select value={tag} onChange={(e)=>setTag(e.target.value)} aria-label="Filter by tag">{tags.map((value)=><option key={value}>{value === "All" ? "All tags" : `#${value}`}</option>)}</select>
      <select value={flavor} onChange={(e)=>setFlavor(e.target.value)} aria-label="Filter by flavor">{flavors.map((value)=><option key={value}>{value === "All" ? "All flavors" : value}</option>)}</select>
      {activeFilters && <button type="button" className="secondary" onClick={() => { setSearch(""); setMaker("All"); setKind("All"); setTag("All"); setFlavor("All"); }}>Clear</button>}
    </div>}
    {loadError ? <div className="ai-error load-error"><CircleAlert/><div><strong>Could not load this section</strong><span>{loadError}</span></div><button className="secondary" onClick={() => load()}>Retry</button></div> :
    !items.length ? <Empty icon={module.icon} title={`No ${module.label.toLowerCase()} yet`} text={admin ? `Add your first ${module.singular.toLowerCase()} to begin.` : "The vault keeper has not stocked this section yet."} actions={emptyActions}/> :
    !filtered.length ? <Empty icon={module.icon} title="No matches" text={`Nothing in ${module.label.toLowerCase()} matches those filters.`}/> :
      <div className="inventory-grid">{listed.map((item) => {
        const brewTaps = module.id === "brews" ? tapsForBatch(taps, item.batch_name) : [];
        const brewAbvText = module.id === "brews" ? brewAbvDisplay(item) : "";
        const archived = module.id === "brews" && normalizeBrewStatus(item.status) === "Archived";
        const outOfStock = (module.id === "packaged_beer" && packagedCount(item.count) <= 0)
          || (module.id === "spirits" && isSpiritEmpty(item));
        return <button type="button" className={`inventory-card inventory-card-button${module.id === "taps" && isTapEmpty(item) ? " empty-tap" : ""}${archived ? " archived-brew" : ""}${outOfStock ? " out-of-stock" : ""}`} key={item.id} onClick={() => setViewing(item)}>
        <div className="card-icon">{item.image_url ? <img src={String(item.image_url)} alt=""/> : <module.icon/>}</div>
        <div className="card-content"><span className="eyebrow">{module.id === "taps" ? `TAP ${item.tap_number}` : String(item[module.secondary] ?? item.style ?? "")}</span><h3>{module.id === "taps" ? tapTitle(item) : String(item[module.primary] ?? "Untitled")}</h3>
          <div className="meta">
            {module.id === "taps" && isTapEmpty(item) ? <span>Nothing pouring</span> : null}
            {item.category ? <span>{String(item.category)}</span> : null}
            {item.sub_category ? <span>{String(item.sub_category)}</span> : null}
            {module.id === "wines"
              ? (wineKindLabel(String(item.type ?? ""), String(item.style ?? "")) ? <span>{wineKindLabel(String(item.type ?? ""), String(item.style ?? ""))}</span> : null)
              : module.id !== "taps" && item.style ? <span>{String(item.style)}</span> : null}
            {module.id === "taps" && !isTapEmpty(item) && item.style ? <span>{String(item.style)}</span> : null}
            {module.id === "wines" && item.sweetness != null && String(item.sweetness).trim() !== ""
              ? <span>{migrateWineSweetnessValue(item.sweetness, String(item.type ?? ""), String(item.style ?? ""))}</span>
              : null}
            {module.id === "brews" && brewAbvText ? <span>{brewAbvText}% ABV</span>
              : item.abv && !(module.id === "taps" && isTapEmpty(item)) ? <span>{item.abv}% ABV</span> : null}
            {item.status ? <span>{normalizeBrewStatus(item.status)}</span> : null}
            {brewTaps.length ? <span>{onTapLabel(brewTaps)}</span> : null}
            {module.id === "brews" && parseList(item.hops).slice(0,3).map((value) => <span key={`hop-${value}`}>{value}</span>)}
            {module.id === "brews" && parseList(item.flavors).slice(0,3).map((value) => <span key={`flavor-${value}`}>{value}</span>)}
            {module.id !== "taps" && module.id !== "brews" && module.id !== "packaged_beer" && item.tap_number != null && String(item.tap_number).trim() !== "" ? <span>Tap {item.tap_number}</span> : null}
            {item.bottle_count != null && module.id !== "packaged_beer" ? <span>{item.bottle_count} bottles</span> : null}
            {module.id === "spirits" ? <span>{spiritStockLabel(item.stock_count)}</span> : null}
            {module.id === "packaged_beer" ? <span>{packagedStockLabel(item.count, item.vessel)}</span> : item.count != null ? <span>{item.count} packaged</span> : null}
            {item.upc ? <span>UPC {String(item.upc)}</span> : null}
            {parseList(item.tags).slice(0,3).map((value) => <span key={value}>#{value}</span>)}
            {scoreLabel(item.vote_score as number | null, Number(item.vote_total)) ? <span>{scoreLabel(item.vote_score as number | null, Number(item.vote_total))}</span> : null}
          </div>
          {module.id === "spirits" && <div className="fill"><span style={{width:`${nearestFillStop(item.fill_level)}%`}}/><small>{fillStopLabel(item.fill_level)}</small></div>}
          {module.id === "taps" && !isTapEmpty(item) && (() => {
            const remaining = Number(item.remaining_l ?? 0);
            const size = Number(item.keg_size_l || DEFAULT_KEG_L);
            const pints = pintsRemaining(remaining);
            const kicked = remaining <= 0;
            return <div className="fill"><span style={{width:`${kegFillPercent(remaining, size)}%`}}/><small>{kicked ? "Kicked" : `${pints} pint${pints === 1 ? "" : "s"} left`}</small></div>;
          })()}
          {module.id === "brews" && <BrewPipeline status={String(item.status ?? "")}/>}
        </div>{admin && <div className="card-actions" onClick={(e)=>e.stopPropagation()}><button className="icon-button" onClick={() => setEditing(item)}><Settings size={17}/></button>{module.id !== "taps" && <button className="icon-button danger" onClick={() => remove(item.id)}><Trash2 size={17}/></button>}</div>}
      </button>;
      })}</div>}
    {finderOpen && <BottleFinder module={module} onClose={() => setFinderOpen(false)} onPick={(values) => {
      setFinderOpen(false);
      if (module.id === "taps") {
        const slot = listed.find(isTapEmpty) ?? items[0];
        setEditing({ ...slot, ...values, id: slot?.id ?? 0, tap_number: slot?.tap_number ?? firstEmptyTapNumber(items), keg_size_l: slot?.keg_size_l ?? values.keg_size_l } as Item);
      } else {
        setEditing({id:0,...values} as Item);
      }
    }}/>}
    {editing !== undefined && <ItemForm module={module} item={editing} review={Boolean(scanDraft) && !scanDraft?.guestAdd} close={() => { setEditing(undefined); if(scanDraft)finishScanReview("cancelled"); }} saved={() => { setEditing(undefined); setViewing(undefined); load(); if(scanDraft)finishScanReview("saved"); }}/>}
  </>;
}

function BottleDetail({ module, item, admin, onBack, onEdit, onDelete, onUpdated, onPutOnTap, tapNumbers }:{
  module: Module; item: Item; admin: boolean; onBack: () => void; onEdit: () => void; onDelete: () => void; onUpdated?: (item: Item) => void; onPutOnTap?: () => void; tapNumbers?: number[];
}) {
  const flavors = parseList(item.flavors);
  const hops = parseList(item.hops);
  const tags = parseList(item.tags);
  const skip = new Set(["notes", "tasting_notes", "flavors", "tags", "hops", "image_url", "sweetness", "body", "drink_by_date", "remaining_l", "keg_size_l", "status", "calculated_abv", "count", "fill_level", "stock_count", module.primary]);
  const wineKind = module.id === "wines" ? wineKindLabel(String(item.type ?? ""), String(item.style ?? "")) : "";
  const wineSweetness = module.id === "wines"
    ? migrateWineSweetnessValue(item.sweetness, String(item.type ?? ""), String(item.style ?? ""))
    : "";
  const bottlesLeft = Number(item.bottle_count ?? 0);
  const packagedLeft = packagedCount(item.count);
  const packagedLabel = module.id === "packaged_beer" ? packagedStockLabel(item.count, item.vessel) : "";
  const spiritFill = module.id === "spirits" ? nearestFillStop(item.fill_level) : 0;
  const nextSpirit = module.id === "spirits" ? openNextSpirit(item) : null;
  const kegSize = Number(item.keg_size_l || DEFAULT_KEG_L);
  const kegLeft = Number(item.remaining_l ?? 0);
  const kegPints = pintsRemaining(kegLeft);
  const brewStatus = module.id === "brews" ? normalizeBrewStatus(item.status) : "";
  const brewNext = module.id === "brews" ? nextBrewStatus(item.status) : null;
  const brewAbvText = module.id === "brews" ? brewAbvDisplay(item) : "";
  const onTap = onTapLabel(tapNumbers ?? []);
  const [actionError, setActionError] = useState("");
  const [acting, setActing] = useState(false);
  async function patchItem(payload: Record<string, unknown>, failed: string) {
    if (!admin || acting) return;
    setActing(true);
    setActionError("");
    try {
      const next = await api<Item>(`/inventory/${module.id}/${item.id}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      onUpdated?.(next);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : failed);
    } finally {
      setActing(false);
    }
  }
  async function drinkOne() {
    if (module.id === "wines" && bottlesLeft > 0) {
      await patchItem({ bottle_count: bottlesLeft - 1 }, "Could not drink one");
      return;
    }
    if (module.id === "packaged_beer" && packagedLeft > 0) {
      await patchItem({ count: drinkOnePackaged(item.count) }, "Could not drink one");
    }
  }
  async function pourDrink() {
    if (module.id !== "spirits" || spiritFill <= 0) return;
    await patchItem({ fill_level: pourSpirit(item.fill_level) }, "Could not pour a drink");
  }
  async function openNextBottle() {
    if (!nextSpirit) return;
    await patchItem(nextSpirit, "Could not open the next bottle");
  }
  async function pourPintNow() {
    if (module.id !== "taps" || kegLeft <= 0) return;
    await patchItem({ remaining_l: pourPint(kegLeft) }, "Could not pour a pint");
  }
  async function advanceBrew() {
    if (module.id !== "brews" || !brewNext) return;
    await patchItem({ status: brewNext }, "Could not advance this batch");
  }
  async function archiveBrew() {
    if (module.id !== "brews") return;
    await patchItem({ status: brewStatus === "Archived" ? "Ready to Keg" : "Archived" }, "Could not update archive status");
  }
  return (
    <section className="bottle-detail">
      <button className="secondary back-button" onClick={onBack}><ArrowLeft size={17}/> Back to {module.label}</button>
      <div className="bottle-detail-hero">
        <div className="bottle-detail-image">
          {item.image_url ? <img src={String(item.image_url)} alt={String(item[module.primary] ?? "")}/> : <module.icon size={64}/>}
        </div>
        <div>
          <span className="eyebrow">{module.id === "taps" ? `TAP ${item.tap_number}` : String(item[module.makerKey] ?? item[module.secondary] ?? item.category ?? item.style ?? module.label)}</span>
          <h1>{module.id === "taps" ? tapTitle(item) : String(item[module.primary] ?? "Untitled")}</h1>
          <div className="meta">
            {module.id === "taps" && isTapEmpty(item) ? <span>Nothing pouring</span> : null}
            {item.category ? <span>{String(item.category)}</span> : null}
            {item.sub_category ? <span>{String(item.sub_category)}</span> : null}
            {module.id === "wines"
              ? (wineKind ? <span>{wineKind}</span> : null)
              : module.id === "taps" && isTapEmpty(item) ? null
              : item.style ? <span>{String(item.style)}</span> : null}
            {item.abv && !(module.id === "taps" && isTapEmpty(item)) && module.id !== "brews" ? <span>{item.abv}% ABV</span> : null}
            {brewAbvText ? <span>{brewAbvText}% ABV</span> : null}
            {item.volume_ml ? <span>{item.volume_ml} ml</span> : null}
            {onTap ? <span>{onTap}</span> : null}
            {module.id !== "taps" && module.id !== "brews" && module.id !== "packaged_beer" && item.tap_number != null && String(item.tap_number).trim() !== "" ? <span>Tap {item.tap_number}</span> : null}
            {module.id === "spirits" ? <span>{spiritStockLabel(item.stock_count)}</span> : item.stock_count != null ? <span>{item.stock_count} bottles</span> : null}
            {item.bottle_count != null && module.id !== "packaged_beer" ? <span>{item.bottle_count} bottles</span> : null}
            {packagedLabel ? <span>{packagedLabel}</span> : item.count != null && module.id !== "packaged_beer" ? <span>{item.count} packaged</span> : null}
            {item.upc ? <span>UPC {String(item.upc)}</span> : null}
            {tags.map((value) => <span key={value}>#{value}</span>)}
          </div>
          {!(module.id === "taps" && isTapEmpty(item)) && <BottleVotes table={module.id} itemId={item.id}/>}
          {admin && <div className="bottle-detail-actions">
            {(module.id === "wines" || module.id === "packaged_beer") && <button type="button" className="secondary drink-one" disabled={(module.id === "wines" ? bottlesLeft : packagedLeft) <= 0 || acting} onClick={drinkOne}>{acting ? "Saving…" : "Drink one"}</button>}
            {module.id === "spirits" && <button type="button" className="secondary drink-one" disabled={spiritFill <= 0 || acting} onClick={pourDrink}>{acting ? "Pouring…" : "Pour a drink"}</button>}
            {module.id === "spirits" && nextSpirit && <button type="button" className="secondary drink-one" disabled={acting} onClick={openNextBottle}>{acting ? "Opening…" : "Open next"}</button>}
            {module.id === "taps" && !isTapEmpty(item) && <button type="button" className="secondary drink-one" disabled={kegLeft <= 0 || acting} onClick={pourPintNow}>{acting ? "Pouring…" : "Pour a pint"}</button>}
            {module.id === "brews" && brewNext && <button type="button" className="secondary drink-one" disabled={acting} onClick={advanceBrew}>{acting ? "Saving…" : `Advance to ${brewNext}`}</button>}
            {module.id === "brews" && <button type="button" className="secondary" disabled={acting} onClick={archiveBrew}>{acting ? "Saving…" : brewStatus === "Archived" ? "Unarchive" : "Archive"}</button>}
            {onPutOnTap && <button type="button" className="secondary" onClick={onPutOnTap}>Put on tap</button>}
            <button className="primary" onClick={onEdit}><Settings size={16}/> {module.id === "taps" && isTapEmpty(item) ? "Put a beer on" : "Edit"}</button>
            {module.id === "taps" && !isTapEmpty(item) && <button className="secondary danger" onClick={onDelete}>Clear tap</button>}
            {module.id !== "taps" && <button className="secondary danger" onClick={onDelete}><Trash2 size={16}/> Remove</button>}
          </div>}
          {actionError ? <p className="error">{actionError}</p> : null}
        </div>
      </div>
      <div className="bottle-detail-grid">
        {module.id === "wines" && <div className="full"><span>Sweetness</span><WineSweetnessScale type={String(item.type ?? "")} style={String(item.style ?? "")} value={wineSweetness}/></div>}
        {module.id === "brews" && <div className="full"><span>Status</span>
          <BrewStatusScale
            value={brewStatus}
            abv={brewAbvText}
            onTap={onTap}
            onChange={admin ? (status) => { void patchItem({ status }, "Could not update status"); } : undefined}
          />
        </div>}
        {module.id === "taps" && !isTapEmpty(item) && <div className="full">
          <span>Keg remaining</span>
          <div className="fill tap-fill"><span style={{width:`${kegFillPercent(kegLeft, kegSize)}%`}}/><small>{kegLeft <= 0 ? "Kicked" : `${kegPints} pint${kegPints === 1 ? "" : "s"} left · ${kegSizeLabel(kegSize)}`}</small></div>
        </div>}
        {module.id === "spirits" && <div className="full">
          <span>Fill</span>
          <FillLevelScale
            value={item.fill_level}
            onChange={admin ? (fill) => { void patchItem({ fill_level: fill }, "Could not update fill"); } : undefined}
          />
          <small className="field-hint">{fillStopLabel(item.fill_level)} · {spiritStockLabel(item.stock_count)}</small>
        </div>}
        {module.id === "packaged_beer" && <div className="full">
          <span>In the cold room</span>
          <strong>{packagedLabel}</strong>
        </div>}
        {!(module.id === "taps" && isTapEmpty(item)) && module.fields.filter((field) => !skip.has(field.key) && item[field.key] != null && String(item[field.key]).trim() !== "" && String(item[field.key]) !== "[]").map((field) => (
          <div key={field.key} className={field.type === "textarea" ? "full" : ""}>
            <span>{field.label}</span>
            {field.key === "keg_size_l" ? <strong>{kegSizeLabel(Number(item.keg_size_l))}</strong>
              : field.type === "gravity" ? <strong>{formatGravity(item[field.key]) || String(item[field.key])}</strong>
              : <strong>{String(item[field.key])}</strong>}
          </div>
        ))}
      </div>
      {hops.length > 0 && <div className="detail-chip-block"><span className="eyebrow">HOPS</span><div className="chip-row detail-chips">{hops.map((value) => <span className="chip static" key={value}>{value}</span>)}</div></div>}
      {flavors.length > 0 && <div className="detail-chip-block">{module.id === "brews" ? <span className="eyebrow">FLAVOR PROFILE</span> : null}<div className="chip-row detail-chips">{flavors.map((value) => <span className="chip static" key={value}>{value}</span>)}</div></div>}
      {item.tasting_notes ? <article className="bottle-notes"><span className="eyebrow">TASTING NOTES</span><p>{String(item.tasting_notes)}</p></article> : null}
      {item.notes ? <article className="bottle-notes"><span className="eyebrow">CELLAR NOTES</span><p>{String(item.notes)}</p></article> : null}
      {!(module.id === "taps" && isTapEmpty(item)) && <GuestReviews table={module.id} itemId={item.id} admin={admin}/>}
    </section>
  );
}

function BottleFinder({ module, onClose, onPick }:{
  module: Module;
  onClose: () => void;
  onPick: (values: Record<string, unknown>) => void;
}) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<BottleSearchHit[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(module.id === "taps" || module.id === "brews" || module.id === "packaged_beer"
    ? "Type at least 2 characters to search packaged beer, the brewery lab, and COLA Cloud."
    : "Type at least 2 characters to search your vault and COLA Cloud.");

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setStatus(module.id === "taps" || module.id === "brews" || module.id === "packaged_beer"
        ? "Type at least 2 characters to search packaged beer, the brewery lab, and COLA Cloud."
        : "Type at least 2 characters to search your vault and COLA Cloud.");
      return;
    }
    const timer = window.setTimeout(async () => {
      setLoading(true); setError("");
      try {
        const data = await api<{ results: BottleSearchHit[] }>(`/search/bottles?q=${encodeURIComponent(q)}&table=${encodeURIComponent(module.id)}`);
        const next = data.results.filter((hit) => hitFitsModule(module.id, hit));
        setResults(next);
        setStatus(next.length ? `${next.length} matches` : "No matches yet — try a brand or bottle name.");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
      } finally {
        setLoading(false);
      }
    }, 320);
    return () => clearTimeout(timer);
  }, [query, module.id]);

  async function choose(hit: BottleSearchHit) {
    try {
      setLoading(true);
      onPick(await resolveSuggestion(module, hit));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load bottle details");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal finder-modal">
        <header className="modal-header">
          <div><span className="eyebrow">{module.id === "taps" || module.id === "brews" || module.id === "packaged_beer" ? "FIND A BEER" : "FIND A BOTTLE"}</span><h2>Search and add</h2></div>
          <button type="button" className="icon-button" onClick={onClose}><X/></button>
        </header>
        <label className="search finder-search"><Search/><input autoFocus value={query} onChange={(e)=>setQuery(e.target.value)} placeholder={module.id === "taps" || module.id === "brews" || module.id === "packaged_beer" ? "House IPA, Nugget Nectar…" : "Eagle Rare, Lagavulin, Champagne…"}/></label>
        <p className="scanner-status">{loading ? "Searching…" : status}</p>
        {error && <p className="error">{error}</p>}
        <div className="finder-results">
          {results.map((hit, index) => {
            const name = String(hit.product.name ?? hit.product.product_name ?? hit.product.batch_name ?? "Untitled");
            const brand = String(hit.product.brand ?? hit.product.brands ?? hit.product.brewery ?? hit.product.producer ?? hit.product.maker ?? "");
            const category = String(hit.product.category ?? hit.product.categories ?? hit.product.style ?? hit.product.status ?? "");
            const origin = hit.table === "brews" ? "BREWERY LAB" : hit.source === "vault" ? "IN YOUR VAULT" : "COLA CLOUD";
            return (
              <button type="button" className="finder-result" key={`${hit.source}-${hit.ttb_id ?? hit.product.id ?? index}`} onClick={() => choose(hit)}>
                <div className="card-icon">{hit.product.image_url ? <img src={String(hit.product.image_url)} alt=""/> : <Bottle/>}</div>
                <div>
                  <span className="eyebrow">{origin} · {hit.table.replace("_"," ")}</span>
                  <strong>{name}</strong>
                  <small>{[brand, category].filter(Boolean).join(" · ")}</small>
                </div>
                <ChevronRight size={16}/>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ItemForm({ module,item,review,close,saved }:{module:Module;item:Item|null;review?:boolean;close:()=>void;saved:()=>void}) {
  const [form,setForm] = useState<Record<string,unknown>>(() => {
    const defaults = (item ?? (module.id === "spirits"
      ? { category: "Whiskey", fill_level: 100, stock_count: 1 }
      : module.id === "wines"
        ? { type: "Red", sweetness: defaultSweetnessForWine("Red"), bottle_count: 1 }
        : module.id === "taps"
          ? { tap_number: 1, keg_size_l: DEFAULT_KEG_L, remaining_l: 0, source_type: "Commercial", brewery_batch: "" }
          : module.id === "brews"
            ? { status: "Planned" }
            : module.id === "packaged_beer"
              ? { count: 1, vessel: "Can" }
              : {})) as Record<string, unknown>;
    return {
      ...defaults,
      flavors: parseList(item?.flavors),
      hops: parseList(item?.hops),
      tags: parseList(item?.tags),
      ...(module.id === "wines" ? {
        sweetness: migrateWineSweetnessValue(defaults.sweetness, String(defaults.type ?? ""), String(defaults.style ?? ""))
      } : {}),
      ...(module.id === "packaged_beer" ? {
        vessel: normalizeBeerVessel(defaults.vessel),
        count: packagedCount(defaults.count ?? 1)
      } : {}),
      ...(module.id === "spirits" ? {
        fill_level: nearestFillStop(defaults.fill_level ?? 100),
        stock_count: defaults.stock_count == null || String(defaults.stock_count).trim() === "" ? 1 : spiritStock(defaults.stock_count)
      } : {})
    };
  });
  const [tagDraft,setTagDraft] = useState("");
  const [flavorDraft,setFlavorDraft] = useState("");
  const [hopDraft,setHopDraft] = useState("");
  const [error,setError] = useState("");
  const [suggestLock,setSuggestLock] = useState(() => String(item?.[module.primary] ?? ""));
  const existing = Boolean(item?.id);
  const flavors = parseList(form.flavors);
  const hops = parseList(form.hops);
  const tags = parseList(form.tags);
  async function submit(e:React.FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      ...form,
      flavors: serializeList(flavors),
      hops: serializeList(hopDraft.trim() ? [...hops, hopDraft.trim()] : hops),
      tags: serializeList(parseTagInput([...tags, tagDraft].join(" ")))
    };
    if (module.id === "brews") {
      payload.status = normalizeBrewStatus(payload.status);
      for (const key of ["target_og", "target_fg", "measured_og", "measured_fg"] as const) {
        payload[key] = parseGravity(payload[key]);
      }
      const abv = brewAbv(payload);
      if (abv != null) payload.calculated_abv = abv;
    }
    if (module.id === "packaged_beer") {
      payload.count = packagedCount(payload.count);
      payload.vessel = normalizeBeerVessel(payload.vessel);
    }
    if (module.id === "spirits") {
      payload.fill_level = nearestFillStop(payload.fill_level);
      payload.stock_count = spiritStock(payload.stock_count ?? 1);
    }
    try {
      await api(`/inventory/${module.id}${existing ? `/${item!.id}` : ""}`,{method:existing?"PUT":"POST",body:JSON.stringify(payload)});
      saved();
    } catch(err) {
      setError(err instanceof Error?err.message:"Could not save");
    }
  }
  function typeOptions(field: Field) {
    if (field.key === "sub_category" && module.id === "spirits") {
      return SPIRIT_TYPES[String(form.category || "Whiskey")] ?? [];
    }
    if (field.key === "style" && module.id === "wines") {
      return [...SPARKLING_STYLES];
    }
    return field.options ?? [];
  }
  function setWineFamily(type: string) {
    const style = type === "Sparkling" ? String(form.style ?? "") : "";
    setForm({ ...form, type, style, sweetness: defaultSweetnessForWine(type, style) });
  }
  function setWineStyle(style: string) {
    setForm({ ...form, style, sweetness: defaultSweetnessForWine(String(form.type ?? "Sparkling"), style) });
  }
  function setKegSize(liters: number) {
    const prev = Number(form.keg_size_l || 0);
    const remaining = Number(form.remaining_l ?? prev);
    const wasFull = prev <= 0 || Math.abs(remaining - prev) < 0.05;
    setForm({
      ...form,
      keg_size_l: liters,
      remaining_l: wasFull ? liters : Math.min(remaining, liters)
    });
  }
  function setGravityField(key: string, raw: string, commit = false) {
    setForm((current) => {
      const parsed = parseGravity(raw);
      const stored = commit ? (raw.trim() === "" ? "" : parsed ?? raw) : raw;
      const next = { ...current, [key]: stored };
      const abv = brewAbv({ ...next, [key]: parsed ?? stored });
      return abv != null ? { ...next, calculated_abv: abv } : next;
    });
  }
  return <div className={`modal-backdrop ${review?"review-backdrop":""}`}><form className="modal form-modal" onSubmit={submit}><header className="modal-header"><div><span className="eyebrow">{review?"SCAN REVIEW":existing?"EDIT":"NEW"} {module.singular.toUpperCase()}</span><h2>{module.id === "taps" ? `Tap ${form.tap_number ?? ""}` : existing ? String(item![module.primary]) : `Add ${module.singular}`}</h2></div><button type="button" className="icon-button" onClick={close}><X/></button></header>
    <div className="form-grid">{module.fields.map((field) => {
      if (field.type === "image") {
        return <div className="full field-block" key={field.key}><span>{field.label}</span>
          <ImageField value={String(form.image_url ?? "")} onChange={(url) => setForm({ ...form, image_url: url })}/>
        </div>;
      }
      if (field.type === "flavors") {
        const catalog = module.id === "brews" ? BREW_FLAVOR_OPTIONS : FLAVOR_OPTIONS;
        const options = Array.from(new Set([...catalog, ...flavors]));
        return <label className="full" key={field.key}><span>{field.label}</span>
          <div className="chip-row">{options.map((value) => {
            const on = flavors.some((entry) => entry.toLowerCase() === value.toLowerCase());
            return <button type="button" key={value} className={on ? "chip active" : "chip"} onClick={() => setForm({ ...form, flavors: on ? flavors.filter((entry) => entry.toLowerCase() !== value.toLowerCase()) : [...flavors, value] })}>{value}</button>;
          })}</div>
          <div className="tag-input-row">
            <input value={flavorDraft} onChange={(e)=>setFlavorDraft(e.target.value)} placeholder={module.id === "brews" ? "Add grapefruit, pine, biscuit…" : "Add a custom flavor"}/>
            <button type="button" className="secondary" disabled={!flavorDraft.trim()} onClick={() => { setForm({ ...form, flavors: [...flavors, flavorDraft.trim()] }); setFlavorDraft(""); }}>Add</button>
          </div>
          {module.id === "brews" ? <small className="field-hint">Tap common notes or type your own. Several are fine.</small> : null}
        </label>;
      }
      if (field.type === "hops") {
        const options = Array.from(new Set([...HOP_OPTIONS, ...hops]));
        return <label className="full" key={field.key}><span>{field.label}</span>
          <div className="chip-row">{options.map((value) => {
            const on = hops.some((entry) => entry.toLowerCase() === value.toLowerCase());
            return <button type="button" key={value} className={on ? "chip active" : "chip"} onClick={() => setForm({ ...form, hops: on ? hops.filter((entry) => entry.toLowerCase() !== value.toLowerCase()) : [...hops, value] })}>{value}</button>;
          })}</div>
          <div className="tag-input-row">
            <input value={hopDraft} onChange={(e)=>setHopDraft(e.target.value)} placeholder="Add a hop name" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const next = hopDraft.trim(); if (!next) return; setForm({ ...form, hops: hops.some((entry) => entry.toLowerCase() === next.toLowerCase()) ? hops : [...hops, next] }); setHopDraft(""); } }}/>
            <button type="button" className="secondary" disabled={!hopDraft.trim()} onClick={() => { const next = hopDraft.trim(); setForm({ ...form, hops: hops.some((entry) => entry.toLowerCase() === next.toLowerCase()) ? hops : [...hops, next] }); setHopDraft(""); }}>Add</button>
          </div>
          <small className="field-hint">Tap every hop in the bill, or type a name Nick uses that is not listed.</small>
        </label>;
      }
      if (field.type === "tags") {
        return <label className="full" key={field.key}><span>{field.label}</span>
          <div className="chip-row">{tags.map((value) => <button type="button" className="chip active" key={value} onClick={() => setForm({ ...form, tags: tags.filter((entry) => entry !== value) })}>#{value} ×</button>)}</div>
          <div className="tag-input-row">
            <input value={tagDraft} onChange={(e)=>setTagDraft(e.target.value)} placeholder="#irish #summer #rare" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setForm({ ...form, tags: parseTagInput([...tags, tagDraft].join(" ")) }); setTagDraft(""); } }}/>
            <button type="button" className="secondary" disabled={!tagDraft.trim()} onClick={() => { setForm({ ...form, tags: parseTagInput([...tags, tagDraft].join(" ")) }); setTagDraft(""); }}>Add tags</button>
          </div>
        </label>;
      }
      if (field.type === "tasting") {
        return <label className="full" key={field.key}><span>{field.label}</span><textarea value={String(form[field.key]??"")} onChange={(e)=>setForm({...form,[field.key]:e.target.value})} placeholder="Peat, orange oil, a long dry finish…"/></label>;
      }
      if (field.type === "wineSweetness") {
        return <div className="full field-block" key={field.key}><span>{field.label}</span>
          <WineSweetnessScale
            type={String(form.type ?? "Red")}
            style={String(form.style ?? "")}
            value={migrateWineSweetnessValue(form.sweetness, String(form.type ?? ""), String(form.style ?? ""))}
            onChange={(sweetness) => setForm({ ...form, sweetness })}
          />
        </div>;
      }
      if (field.type === "brewStatus") {
        return <div className="full field-block" key={field.key}><span>{field.label}</span>
          <BrewStatusScale value={normalizeBrewStatus(form.status)} onChange={(status) => setForm({ ...form, status })}/>
        </div>;
      }
      if (field.type === "gravity") {
        return <label key={field.key}><span>{field.label}</span>
          <input
            inputMode="decimal"
            placeholder="1.054"
            value={form[field.key] == null ? "" : String(form[field.key])}
            onChange={(e) => setGravityField(field.key, e.target.value)}
            onBlur={(e) => setGravityField(field.key, e.target.value, true)}
          />
        </label>;
      }
      if (field.type === "brewAbv") {
        const computed = brewAbv(form);
        const display = computed != null ? formatAbv(computed) || "0" : String(form.calculated_abv ?? "");
        return <label key={field.key}><span>{field.label}</span>
          {computed != null
            ? <input readOnly value={display} aria-label="Calculated ABV"/>
            : <input type="number" step="0.1" value={display} onChange={(e) => setForm({ ...form, calculated_abv: e.target.value === "" ? "" : Number(e.target.value) })}/>}
          <small className="field-hint">{computed != null ? "From measured gravity, or target if you have not measured yet. (OG − FG) × 131.25" : "Enter gravity to calculate, or type ABV yourself."}</small>
        </label>;
      }
      if (field.type === "tapNumber") {
        return <label key={field.key}><span>{field.label}</span>
          <select value={String(form.tap_number ?? 1)} disabled={existing} onChange={(e) => setForm({ ...form, tap_number: Number(e.target.value) })}>
            {Array.from({ length: TAP_COUNT }, (_, index) => index + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>;
      }
      if (field.type === "kegSize") {
        const current = Number(form.keg_size_l || DEFAULT_KEG_L);
        const options = KEG_SIZES.some((size) => Math.abs(size.liters - current) < 0.05)
          ? KEG_SIZES
          : [...KEG_SIZES, { label: `${current} L`, liters: current }];
        return <label key={field.key}><span>{field.label}</span>
          <select value={String(current)} onChange={(e) => setKegSize(Number(e.target.value))}>
            {options.map((size) => <option key={size.liters} value={size.liters}>{size.label} · {size.liters} L</option>)}
          </select>
        </label>;
      }
      if (field.type === "kegRemaining") {
        const size = Number(form.keg_size_l || DEFAULT_KEG_L);
        const remaining = Number(form.remaining_l ?? size);
        const active = nearestKegStop(remaining, size);
        const pints = pintsRemaining(remaining);
        return <div className="full field-block" key={field.key}><span>{field.label}</span>
          <div className="chip-row">
            {KEG_REMAINING_STOPS.map((stop) => (
              <button type="button" key={stop.percent} className={stop.percent === active ? "chip active" : "chip"} onClick={() => setForm({ ...form, remaining_l: remainingFromPercent(size, stop.percent) })}>{stop.label}</button>
            ))}
          </div>
          <small className="field-hint">{remaining <= 0 ? "Kicked" : `${pints} pint${pints === 1 ? "" : "s"} left`}</small>
        </div>;
      }
      if (field.type === "packagedCount") {
        const n = packagedCount(form.count);
        return <div className="full field-block" key={field.key}><span>{field.label}</span>
          <div className="count-stepper">
            <button type="button" className="icon-button" aria-label="Remove one" onClick={() => setForm({ ...form, count: Math.max(0, n - 1) })}>−</button>
            <strong>{n}</strong>
            <button type="button" className="icon-button" aria-label="Add one" onClick={() => setForm({ ...form, count: n + 1 })}>+</button>
          </div>
          <div className="chip-row">
            {PACK_COUNT_STOPS.map((stop) => (
              <button type="button" key={stop.count} className={stop.count === n ? "chip active" : "chip"} onClick={() => setForm({ ...form, count: stop.count })}>{stop.label}</button>
            ))}
          </div>
          <small className="field-hint">{packagedStockLabel(n, form.vessel)}</small>
        </div>;
      }
      if (field.type === "fillLevel") {
        return <div className="full field-block" key={field.key}><span>{field.label}</span>
          <FillLevelScale value={form.fill_level} onChange={(fill) => setForm({ ...form, fill_level: fill })}/>
        </div>;
      }
      if (field.type === "spiritStock") {
        const n = spiritStock(form.stock_count);
        return <div className="full field-block" key={field.key}><span>{field.label}</span>
          <div className="count-stepper">
            <button type="button" className="icon-button" aria-label="Remove one bottle" onClick={() => setForm({ ...form, stock_count: Math.max(0, n - 1) })}>−</button>
            <strong>{n}</strong>
            <button type="button" className="icon-button" aria-label="Add one bottle" onClick={() => setForm({ ...form, stock_count: n + 1 })}>+</button>
          </div>
          <small className="field-hint">{spiritStockLabel(n)}</small>
        </div>;
      }
      if (module.id === "wines" && field.key === "style" && String(form.type) !== "Sparkling" && !String(form.style ?? "").trim()) {
        return null;
      }
      const current = String(form[field.key] ?? "");
      const options = typeOptions(field);
      const optionList = options.length ? Array.from(new Set([...options, ...(current && !options.includes(current) ? [current] : [])])) : undefined;
      const optionalSelect = field.key === "sub_category" || field.key === "base_ingredient" || field.key === "style";
      const percentSelect = field.type === "percent";
      const nameSuggest = field.key === module.primary && !optionList && field.type !== "textarea" && field.type !== "number" && field.type !== "percent";
      if (nameSuggest) {
        return <div className="full field-block" key={field.key}><span>{field.label}</span>
          {module.id === "taps" && <div className="chip-row">
            <button type="button" className={isTapEmpty(form) ? "chip active" : "chip"} onClick={() => {
              setSuggestLock("");
              setForm((currentForm) => ({
                ...currentForm,
                ...emptyTapBeerFields(),
                tap_number: currentForm.tap_number,
                keg_size_l: currentForm.keg_size_l,
                flavors: [],
                tags: []
              }));
            }}>None</button>
          </div>}
          <div className="suggest-wrap">
            <input
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={current}
              placeholder={module.id === "taps" ? "None — or start typing a beer…" : existing ? undefined : "Start typing a name…"}
              onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Escape") setSuggestLock(current); }}
            />
            <BottleSuggest
              moduleId={module.id}
              query={current}
              locked={suggestLock}
              onPick={async (hit) => {
                try {
                  const values = await resolveSuggestion(module, hit);
                  setSuggestLock(String(values[module.primary] ?? current));
                  setForm((currentForm) => ({
                    ...currentForm,
                    ...values,
                    tap_number: currentForm.tap_number,
                    keg_size_l: currentForm.keg_size_l ?? values.keg_size_l,
                    remaining_l: values.remaining_l ?? currentForm.keg_size_l ?? DEFAULT_KEG_L,
                    flavors: module.id === "taps" ? parseList(values.flavors ?? currentForm.flavors) : currentForm.flavors,
                    hops: module.id === "brews" ? (existing ? currentForm.hops : parseList(values.hops ?? currentForm.hops)) : currentForm.hops,
                    tags: module.id === "taps" ? parseList(values.tags ?? currentForm.tags) : currentForm.tags,
                    status: module.id === "brews" && existing ? currentForm.status : (values.status ?? currentForm.status)
                  }));
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Could not load bottle details");
                }
              }}
            />
          </div>
          {!existing ? <small className="field-hint">{module.id === "brews" ? "Matches from packaged beer and COLA fill the rest of the form." : "Matches from your vault and COLA fill the rest of the form."}</small> : null}
          {module.id === "taps" ? <small className="field-hint">None leaves this handle empty. Find a house brew or packaged beer to put it on.</small> : null}
        </div>;
      }
      return <label className={field.type==="textarea"?"full":""} key={field.key}><span>{field.label}</span>
      {optionList ? <select value={current} onChange={(e)=>{
        const next = percentSelect ? Number(e.target.value) : e.target.value;
        if (module.id === "wines" && field.key === "type") { setWineFamily(String(next)); return; }
        if (module.id === "wines" && field.key === "style") { setWineStyle(String(next)); return; }
        setForm({...form,[field.key]:next});
      }}>{optionalSelect && <option value="">Select…</option>}{optionList.map((v)=><option key={v} value={v}>{percentSelect ? (v === "100" ? "Full (100%)" : v === "0" ? "Empty (0%)" : `${v}%`) : v}</option>)}</select> :
      field.type==="textarea" ? <textarea value={String(form[field.key]??"")} onChange={(e)=>setForm({...form,[field.key]:e.target.value})}/> :
      field.type?.startsWith("range") ? <div className="range-wrap"><input type="range" min={field.type==="range5"?1:0} max={field.type==="range5"?5:100} value={Number(form[field.key]??(field.type==="range5"?3:100))} onChange={(e)=>setForm({...form,[field.key]:Number(e.target.value)})}/><b>{String(form[field.key]??(field.type==="range5"?3:100))}</b></div> :
      <input type={field.type??"text"} step={field.type==="number"?"any":undefined} value={String(form[field.key]??"")} onChange={(e)=>setForm({...form,[field.key]:field.type==="number"?Number(e.target.value):e.target.value})}/>}</label>;
    })}</div>
    {error && <p className="error">{error}</p>}<footer className="modal-footer"><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary">Save to vault</button></footer></form></div>;
}

type IngredientLine = { text: string; state: "have" | "pantry" | "substitute" | "missing"; using?: string };
type CocktailDrink = Item & {
  ingredients: string[];
  lines?: IngredientLine[];
  missing: string[];
  readiness: string;
  season: string;
  garnish: string;
  method: string;
  glassware: string;
  collection: string;
  notes?: string;
  image_url?: string;
  source_url?: string;
  bartender_fav?: number;
};
type CocktailTicket = {
  id: number;
  cocktail_id: number | null;
  name: string;
  guest_name: string;
  notes: string;
  source_url: string;
  image_url: string;
  status: string;
};
type ImportedRecipe = {
  name: string;
  ingredients: string[];
  method: string;
  glassware: string;
  garnish: string;
  season: string;
  notes: string;
  image_url: string;
  source_url: string;
};

const GUEST_NAME_KEY = "smokey-reviewer";

function readinessLabel(readiness: string) {
  return readiness === "ready" ? "READY TO POUR" : readiness === "almost" ? "ONE ITEM AWAY" : "BUILD THE SHELF";
}

function cocktailLines(drink: CocktailDrink): IngredientLine[] {
  if (drink.lines?.length) return drink.lines;
  return (drink.ingredients ?? []).map((text) => ({
    text,
    state: drink.missing?.includes(text) ? "missing" : "have"
  }));
}

function Cocktails({ admin, sharedUrl, onSharedConsumed }: { admin: boolean; sharedUrl?: string; onSharedConsumed?: () => void }) {
  const [drinks, setDrinks] = useState<CocktailDrink[]>([]);
  const [tickets, setTickets] = useState<CocktailTicket[]>([]);
  const [filter, setFilter] = useState("ready");
  const [season, setSeason] = useState("All");
  const [collection, setCollection] = useState("All");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<CocktailDrink>();
  const [importer, setImporter] = useState(Boolean(sharedUrl));
  const [loadError, setLoadError] = useState("");
  const nowSeason = currentSeason();
  function load() {
    api<CocktailDrink[]>("/cocktails/match")
      .then((rows) => setDrinks([...rows].sort(compareCocktails)))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Could not load cocktail matches."));
    api<CocktailTicket[]>("/cocktails/tickets")
      .then(setTickets)
      .catch(() => setTickets([]));
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (sharedUrl) setImporter(true);
  }, [sharedUrl]);
  function closeImporter() {
    setImporter(false);
    onSharedConsumed?.();
  }
  const queried = drinks.filter((drink) => {
    if (season !== "All" && drink.season !== season) return false;
    if (collection !== "All" && collectionGroup(drink.collection) !== collection) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [drink.name, drink.method, drink.glassware, drink.collection, ...(drink.ingredients ?? [])]
      .join(" ").toLowerCase().includes(q);
  });
  const shown = queried.filter((drink) => filter === "all" || drink.readiness === filter);
  const ready = queried.filter((drink) => drink.readiness === "ready");
  const almost = queried.filter((drink) => drink.readiness === "almost");
  const favorites = drinks.filter((drink) => Number(drink.bartender_fav) > 0);
  function surprise() {
    if (!ready.length) return;
    setSelected(ready[Math.floor(Math.random() * ready.length)]);
  }
  return <>
    <PageTitle
      eyebrow="THE RECIPE INDEX"
      title="What can I make?"
      subtitle={`${ready.length} ready to pour · ${almost.length} one bottle away. Paste a recipe link on any phone, share it into the vault on Android, star Nick’s favorites, or put a drink on the ticket.`}
    />
    {loadError && <div className="ai-error load-error"><CircleAlert/><div><strong>Could not load recipes</strong><span>{loadError}</span></div></div>}
    <div className="cocktail-toolbar">
      <div className="segmented cocktail-filters">
        {[["ready", "Ready now"], ["almost", "Missing one"], ["all", "All recipes"]].map(([id, label]) => (
          <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>
      <div className="toolbar-actions">
        <button className="secondary" onClick={() => setImporter(true)}><Link size={17}/> Add from a link</button>
        <button className="primary surprise-button" disabled={!ready.length} onClick={surprise}><Shuffle size={18}/> Surprise me</button>
      </div>
    </div>
    <label className="search cocktail-search"><Search/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Negroni, mezcal, coupe…"/></label>
    {tickets.length > 0 && <section className="ticket-board">
      <div className="section-heading"><div><span className="eyebrow">ON THE TICKET</span><h2>Make for someone</h2></div><span className="guest-badge">{tickets.length}</span></div>
      <div className="ticket-row">
        {tickets.map((ticket) => (
          <article className="ticket-card" key={ticket.id}>
            {ticket.image_url ? <img src={ticket.image_url} alt=""/> : null}
            <div>
              <span className="eyebrow">FOR {ticket.guest_name.toUpperCase()}</span>
              <h3>{ticket.name}</h3>
              {ticket.notes ? <p>{ticket.notes}</p> : null}
            </div>
            <div className="ticket-actions">
              {admin && <button type="button" className="primary" onClick={async () => {
                await api(`/cocktails/tickets/${ticket.id}/pour`, { method: "POST" });
                load();
              }}>Poured</button>}
              {admin && <button type="button" className="icon-button danger" aria-label="Remove ticket" onClick={async () => {
                await api(`/cocktails/tickets/${ticket.id}`, { method: "DELETE" });
                load();
              }}><Trash2 size={16}/></button>}
            </div>
          </article>
        ))}
      </div>
    </section>}
    {favorites.length > 0 && <section className="favorite-board">
      <div className="section-heading"><div><span className="eyebrow">BEHIND THE STICK</span><h2>Bartender favorites</h2></div></div>
      <div className="favorite-row">
        {favorites.map((drink) => (
          <button type="button" className="favorite-card" key={drink.id} onClick={() => setSelected(drink)}>
            <div className="card-icon">{drink.image_url ? <img src={String(drink.image_url)} alt=""/> : <Star/>}</div>
            <div>
              <span className="eyebrow">{readinessLabel(drink.readiness)}</span>
              <strong>{drink.name}</strong>
              <small>{drink.method} · {drink.glassware}</small>
            </div>
          </button>
        ))}
      </div>
    </section>}
    <section className="season-section">
      <span className="eyebrow">SEASON</span>
      <div className="season-filters">
        {SEASONS.map((value) => (
          <button key={value} className={season === value ? "active" : ""} onClick={() => setSeason(value)}>
            {value === "All" ? "All seasons" : value === nowSeason ? `${value} · now` : value}
          </button>
        ))}
      </div>
    </section>
    <section className="season-section">
      <span className="eyebrow">COLLECTION</span>
      <div className="season-filters">
        {[["All", "All books"], ["Classics", "Classics"], ["Seasonal", "Seasonal"], ["Custom", "Custom"]].map(([id, label]) => (
          <button key={id} className={collection === id ? "active" : ""} onClick={() => setCollection(id)}>{label}</button>
        ))}
      </div>
    </section>
    {!shown.length ? <Empty icon={Wine} title="No matching cocktails" text={search.trim() ? "Nothing matches that search." : season === "All" ? "Stock a few more bottles and check back." : `No ${season.toLowerCase()} recipes match this filter.`}/> :
      <div className="recipe-grid">{shown.map((drink) => {
        const lines = cocktailLines(drink);
        const preview = lines.slice(0, 3);
        return (
          <button className="recipe-card" key={drink.id} onClick={() => setSelected(drink)}>
            {drink.image_url ? <img className="recipe-thumb" src={String(drink.image_url)} alt=""/> : null}
            <span className={`status ${drink.readiness}`}>{readinessLabel(drink.readiness)}</span>
            {Number(drink.bartender_fav) > 0 && <span className="fav-tag">Favorite</span>}
            {drink.season !== "All" && <span className="season-tag">{drink.season}</span>}
            <h3>{drink.name}</h3>
            <p>{drink.method} · {drink.glassware}</p>
            <ul className="ingredient-preview">{preview.map((line) => <li key={line.text} className={line.state}>{line.text}</li>)}</ul>
            {lines.length > 3 ? <small>+{lines.length - 3} more</small> : null}
            {drink.missing.length > 0 && <small>Missing: {drink.missing.join(", ")}</small>}
          </button>
        );
      })}</div>}
    {selected && <RecipeModal
      drink={selected}
      admin={admin}
      close={() => setSelected(undefined)}
      onChanged={() => { load(); }}
      onDeleted={() => { setSelected(undefined); load(); }}
    />}
    {importer && <RecipeImportModal admin={admin} initialUrl={sharedUrl} close={closeImporter} saved={() => { closeImporter(); load(); }}/>}
  </>;
}

function RecipeModal({ drink, admin, close, onChanged, onDeleted }:{
  drink: CocktailDrink; admin: boolean; close: () => void; onChanged: () => void; onDeleted: () => void;
}) {
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const [guestName, setGuestName] = useState(() => localStorage.getItem(GUEST_NAME_KEY) ?? "");
  const [ticketNote, setTicketNote] = useState("");
  const [ticketed, setTicketed] = useState(false);
  const [fav, setFav] = useState(Number(drink.bartender_fav) > 0);
  const lines = cocktailLines(drink);
  const custom = drink.collection === "Custom Cocktails";
  async function remove() {
    if (!custom || !admin || !confirm("Remove this custom recipe?")) return;
    setRemoving(true);
    setError("");
    try {
      await api(`/cocktails/${drink.id}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove recipe");
      setRemoving(false);
    }
  }
  async function toggleFav() {
    if (!admin) return;
    try {
      const next = await api<CocktailDrink>(`/cocktails/${drink.id}`, {
        method: "PUT",
        body: JSON.stringify({ bartender_fav: !fav })
      });
      setFav(Number(next.bartender_fav) > 0);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update favorite");
    }
  }
  async function addToTicket() {
    setError("");
    try {
      await api("/cocktails/tickets", {
        method: "POST",
        body: JSON.stringify({
          cocktail_id: drink.id,
          name: drink.name,
          guest_name: guestName,
          notes: ticketNote,
          image_url: drink.image_url,
          source_url: drink.source_url
        })
      });
      localStorage.setItem(GUEST_NAME_KEY, guestName.trim());
      setTicketed(true);
      setTicketNote("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add to the ticket");
    }
  }
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`${drink.name} recipe`}>
      <section className="modal recipe-modal">
        <header className="modal-header">
          <div>
            <span className="eyebrow">{drink.collection}{drink.season !== "All" ? ` · ${drink.season}` : ""}{fav ? " · FAVORITE" : ""}</span>
            <h2>{drink.name}</h2>
            <p>{drink.method} · {drink.glassware}</p>
          </div>
          <button className="icon-button" onClick={close} aria-label="Close recipe"><X/></button>
        </header>
        {drink.image_url ? <img className="recipe-hero" src={String(drink.image_url)} alt=""/> : null}
        <div className="recipe-modal-body">
          <div>
            <span className="eyebrow">INGREDIENTS</span>
            <ul className="ingredient-list">
              {lines.map((line) => (
                <li key={line.text} className={line.state}>
                  <span className="mark" aria-hidden="true">{line.state === "missing" ? "○" : line.state === "substitute" ? "◐" : "●"}</span>
                  <span>
                    {line.text}
                    {line.state === "substitute" && line.using ? <small> using {line.using}</small> : null}
                    {line.state === "have" && line.using ? <small> · {line.using}</small> : null}
                    {line.state === "pantry" ? <small> · pantry</small> : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="recipe-details">
            <div><span>METHOD</span><strong>{drink.method}</strong></div>
            <div><span>GLASS</span><strong>{drink.glassware}</strong></div>
            <div><span>GARNISH</span><strong>{drink.garnish || "None"}</strong></div>
            {drink.source_url ? <div><span>SOURCE</span><a href={String(drink.source_url)} target="_blank" rel="noreferrer">{String(drink.source_url).replace(/^https?:\/\//, "")}</a></div> : null}
          </div>
        </div>
        {drink.notes ? <article className="bottle-notes"><span className="eyebrow">NOTES</span><p>{drink.notes}</p></article> : null}
        {drink.missing.length > 0 && <p className="recipe-warning">Missing from your vault: {drink.missing.join(", ")}</p>}
        <form className="ticket-form" onSubmit={(e) => { e.preventDefault(); void addToTicket(); }}>
          <span className="eyebrow">MAKE FOR SOMEONE</span>
          <label><span>Who is it for?</span><input value={guestName} onChange={(e) => setGuestName(e.target.value)} maxLength={40} placeholder="Sam, Dad, the table in the back…"/></label>
          <label className="full"><span>Note (optional)</span><input value={ticketNote} onChange={(e) => setTicketNote(e.target.value)} maxLength={240} placeholder="Up, extra lime, no egg white…"/></label>
          <button className="secondary" disabled={!guestName.trim() || ticketed}>{ticketed ? "On the ticket" : "Put it on the ticket"}</button>
        </form>
        {error ? <p className="error">{error}</p> : null}
        <footer className="modal-footer">
          {admin && <button type="button" className={fav ? "primary" : "secondary"} onClick={toggleFav}><Star size={16}/> {fav ? "Bartender favorite" : "Mark favorite"}</button>}
          {admin && custom && <button type="button" className="secondary danger" disabled={removing} onClick={remove}><Trash2 size={16}/> Remove</button>}
          <button className="primary" onClick={close}>Cheers</button>
        </footer>
      </section>
    </div>
  );
}

function RecipeImportModal({ admin, close, saved, initialUrl }:{
  admin: boolean; close: () => void; saved: () => void; initialUrl?: string;
}) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [recipe, setRecipe] = useState<ImportedRecipe>();
  const [source, setSource] = useState("");
  const [guestName, setGuestName] = useState(() => localStorage.getItem(GUEST_NAME_KEY) ?? "");
  const [ticketNote, setTicketNote] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [status, setStatus] = useState("");
  const autoRead = useRef(Boolean(initialUrl));
  async function parse(raw = url) {
    const link = raw.trim();
    if (!link) return;
    setLoading(true);
    setError("");
    setRecipe(undefined);
    setStatus("");
    try {
      const data = await api<{ recipe: ImportedRecipe; source: string }>("/cocktails/import", {
        method: "POST",
        body: JSON.stringify({ url: link })
      });
      setRecipe(data.recipe);
      setSource(data.source);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that link");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (!autoRead.current || !initialUrl) return;
    autoRead.current = false;
    void parse(initialUrl);
  }, [initialUrl]);
  async function useCopiedLink() {
    setError("");
    try {
      const text = await navigator.clipboard.readText();
      const found = extractSharedRecipeUrl({ text, url: text });
      if (!found) {
        setError("No recipe link on the clipboard. Paste one in the box.");
        return;
      }
      setUrl(found);
      await parse(found);
    } catch {
      setError("Paste the link in the box — this browser will not read the clipboard.");
    }
  }
  function takePastedLink(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    const found = extractSharedRecipeUrl({ text, url: text });
    if (!found) return;
    event.preventDefault();
    setUrl(found);
  }
  async function saveBook() {
    if (!recipe || !admin) return;
    setError("");
    try {
      await api("/cocktails/custom", {
        method: "POST",
        body: JSON.stringify({ ...recipe, bartender_fav: favorite })
      });
      saved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save recipe");
    }
  }
  async function saveTicket() {
    if (!recipe) return;
    setError("");
    try {
      await api("/cocktails/tickets", {
        method: "POST",
        body: JSON.stringify({
          name: recipe.name,
          guest_name: guestName,
          notes: ticketNote,
          source_url: recipe.source_url,
          image_url: recipe.image_url
        })
      });
      localStorage.setItem(GUEST_NAME_KEY, guestName.trim());
      setStatus(`On the ticket for ${guestName.trim()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add to the ticket");
    }
  }
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal recipe-modal">
        <header className="modal-header">
          <div>
            <span className="eyebrow">ADD FROM A LINK</span>
            <h2>Import a recipe</h2>
            <p>Paste a URL from Punch, Liquor.com, a blog, or anywhere that publishes a recipe. On Android you can also Share to The Smokey Vault. The vault reads the page and grabs a photo when it can.</p>
          </div>
          <button type="button" className="icon-button" onClick={close}><X/></button>
        </header>
        <label className="search finder-search"><Link/><input value={url} onChange={(e) => setUrl(e.target.value)} onPaste={takePastedLink} placeholder="https://…/paper-plane" autoFocus/></label>
        <div className="import-actions">
          <button type="button" className="secondary" disabled={loading} onClick={() => void useCopiedLink()}><ClipboardPaste size={16}/> Use copied link</button>
          <button type="button" className="primary" disabled={loading || !url.trim()} onClick={() => void parse()}>{loading ? "Reading the page…" : "Read recipe"}</button>
        </div>
        {recipe && <div className="import-preview">
          {recipe.image_url ? <img src={recipe.image_url} alt=""/> : null}
          <div>
            <span className="eyebrow">{source === "ai" ? "READ WITH AI" : "FROM THE PAGE"}</span>
            <h3>{recipe.name}</h3>
            <p>{recipe.method}</p>
            <ul>{recipe.ingredients.map((line) => <li key={line}>{line}</li>)}</ul>
          </div>
        </div>}
        {recipe && <form className="ticket-form" onSubmit={(e) => { e.preventDefault(); void saveTicket(); }}>
          <span className="eyebrow">MAKE FOR SOMEONE</span>
          <label><span>Who is it for?</span><input value={guestName} onChange={(e) => setGuestName(e.target.value)} maxLength={40} placeholder="Nick, Sam…"/></label>
          <label className="full"><span>Note (optional)</span><input value={ticketNote} onChange={(e) => setTicketNote(e.target.value)} maxLength={240}/></label>
          <button className="secondary" disabled={!guestName.trim()}>Put it on the ticket</button>
        </form>}
        {recipe && admin && <label className="fav-check"><input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)}/> Save as a bartender favorite</label>}
        {status ? <small>{status}</small> : null}
        {error ? <p className="error">{error}</p> : null}
        <footer className="modal-footer">
          <button type="button" className="secondary" onClick={close}>Close</button>
          {recipe && admin && <button type="button" className="primary" onClick={saveBook}><Save size={16}/> Save to Custom Cocktails</button>}
          {recipe && !admin && <small>Unlock admin to save this to the recipe book.</small>}
        </footer>
      </section>
    </div>
  );
}

type GeneratedRecipe = { name:string; ingredients:string[]; method:string; glassware:string; garnish:string; season:string; notes:string };

function Mixologist({admin,goSettings}:{admin:boolean;goSettings:()=>void}) {
  const [prompt,setPrompt] = useState(""); const [recipe,setRecipe] = useState<GeneratedRecipe>(); const [loading,setLoading] = useState(false); const [error,setError] = useState(""); const [saved,setSaved] = useState(false);
  async function ask(request=prompt){setLoading(true);setRecipe(undefined);setError("");setSaved(false);try{const data=await api<{recipe:GeneratedRecipe}>("/ai/mixologist",{method:"POST",body:JSON.stringify({prompt:request})});setRecipe(data.recipe);}catch(e){setError(e instanceof Error?e.message:"The AI service could not generate a recipe.");}finally{setLoading(false);}}
  async function save(){if(!recipe)return;if(!admin){setError("Unlock Admin Mode to save this recipe to Custom Cocktails.");return;}try{await api("/cocktails/custom",{method:"POST",body:JSON.stringify(recipe)});setSaved(true);setError("");}catch(e){setError(e instanceof Error?e.message:"Could not save the recipe.");}}
  return <><PageTitle eyebrow="YOUR PERSONAL BARTENDER" title="Make it memorable." subtitle="Describe a mood or a bottle. The mixologist only sees what is actually on the shelf, plus pantry staples."/>
    <div className="mixologist"><Sparkles size={44}/><div className="prompt-chips">{["Smoky and contemplative","Bright summer highball","Use my amaro","A low-ABV nightcap","Something with what I already have"].map((p)=><button key={p} onClick={()=>setPrompt(p)}>{p}</button>)}</div><textarea value={prompt} onChange={(e)=>setPrompt(e.target.value)} placeholder="Tonight I want something spirit-forward, smoky, and not too sweet…"/><div className="mixologist-actions"><button className="primary" disabled={loading||!prompt} onClick={()=>ask()}>{loading?<LoaderCircle className="spinner"/>:<Sparkles/>} {loading?"Crafting your recipe…":"Create my cocktail"}</button><button className="secondary" disabled={loading} onClick={()=>ask("Recommend the single best cocktail I can make from bottles currently on the shelf. Name those bottles. Favor ingredients I already own and explain the choice briefly in the notes.")}><Shuffle/> Recommend from my vault</button></div>
    {loading&&<div className="ai-loading"><LoaderCircle className="spinner"/><div><strong>The mixologist is measuring…</strong><span>Balancing your inventory, flavors, and request.</span></div></div>}
    {error&&<div className="ai-error"><CircleAlert/><div><strong>Could not complete that request</strong><span>{error}</span></div>{admin&&/Settings|API key|provider/i.test(error)&&<button className="secondary" onClick={goSettings}>Open Settings</button>}</div>}
    {recipe&&<article className="generated-recipe"><div className="generated-heading"><div><span className="eyebrow">CUSTOM CREATION · {recipe.season.toUpperCase()}</span><h2>{recipe.name}</h2><p>{recipe.notes}</p></div><Sparkles/></div><div className="recipe-modal-body"><div><span className="eyebrow">INGREDIENTS</span><ul>{recipe.ingredients.map((ingredient)=><li key={ingredient}>{ingredient}</li>)}</ul></div><div className="recipe-details"><div><span>METHOD</span><strong>{recipe.method}</strong></div><div><span>GLASS</span><strong>{recipe.glassware}</strong></div><div><span>GARNISH</span><strong>{recipe.garnish}</strong></div></div></div><div className="generated-actions"><button className="primary" onClick={save}><Save/> {saved?"Saved to Custom Cocktails":"Add to Custom Cocktails"}</button>{!admin&&<small>Admin unlock required to save.</small>}</div></article>}</div>
  </>;
}

function SettingsPage({theme,setTheme}:{theme:string;setTheme:(v:string)=>void}) {
  const [settings,setSettings] = useState<Record<string,string>>({}); const [message,setMessage]=useState(""); const [themeText,setThemeText]=useState("");
  const [quota,setQuota] = useState<{
    configured?: boolean; message?: string; source?: string; tier?: string;
    detail_views_remaining?: string | null; detail_views_limit?: string | null;
    list_records_remaining?: string | null; list_records_limit?: string | null; quota_reset?: string | null;
  } | null>(null);
  const [quotaError,setQuotaError] = useState("");
  useEffect(()=>{
    api<Record<string,string>>("/settings").then(setSettings).catch((err)=>setMessage(err instanceof Error?err.message:"Could not load settings"));
    api<NonNullable<typeof quota>>("/cola/quota").then((data)=>{setQuota(data);setQuotaError("");}).catch((err)=>setQuotaError(err instanceof Error?err.message:"Unable to read COLA Cloud quota"));
  },[]);
  async function save(){try{await api("/settings",{method:"PUT",body:JSON.stringify(settings)});setMessage("Settings saved");}catch(err){setMessage(err instanceof Error?err.message:"Could not save settings");}}
  async function saveRestock(partial: Partial<RestockThresholds>) {
    const current = parseRestockThresholds(settings);
    const next = {
      ...settings,
      restockPackagedBelow: String(partial.packagedBelow ?? current.packagedBelow),
      restockSpiritFill: String(partial.spiritFill ?? current.spiritFill),
      restockWineBelow: String(partial.wineBelow ?? current.wineBelow)
    };
    setSettings(next);
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify(next) });
      setMessage("Restock rules saved");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save restock rules");
    }
  }
  function applyThemeJson(text:string){try{const raw=JSON.parse(text);const flat=raw.schemes?.dark??raw.dark??raw;const tokens:Record<string,string>={"--accent":flat.primary,"--bg":flat.background,"--surface":flat.surface,"--text":flat.onSurface,"--line":flat.outlineVariant};Object.keys(tokens).forEach((k)=>!tokens[k]&&delete tokens[k]);applyTheme("custom",tokens);setSettings((current)=>({...current,themeTokens:JSON.stringify(tokens)}));setMessage("Material tokens applied — save to persist.");}catch{setMessage("That content is not valid Material theme JSON.");}}
  function importTheme(file:File){const reader=new FileReader();reader.onload=()=>applyThemeJson(String(reader.result));reader.readAsText(file);}
  const download=(format:"db"|"json")=>{downloadExport(format).catch(()=>setMessage("Export failed"));};
  const restockRules = parseRestockThresholds(settings);
  return <><PageTitle eyebrow="VAULT ADMINISTRATION" title="Settings & maintenance" subtitle="Security, appearance, AI providers, and durable backups."/>
    <div className="settings-grid"><section className="settings-card"><h3>Appearance</h3><p>Choose a contrast profile for every display.</p><div className="theme-grid">{["light","dark","oled"].map((t)=><button key={t} className={theme===t?"active":""} onClick={()=>setTheme(t)}><span className={`theme-swatch ${t}`}/>{t==="oled"?"OLED Black":t[0].toUpperCase()+t.slice(1)}</button>)}</div><label className="secondary file-button"><Upload/> Import Material theme<input type="file" accept=".json,application/json" onChange={(e)=>e.target.files?.[0]&&importTheme(e.target.files[0])}/></label><textarea value={themeText} onChange={(e)=>setThemeText(e.target.value)} placeholder="Or paste theme.json / tokens.json here"/><button className="secondary" disabled={!themeText} onClick={()=>applyThemeJson(themeText)}>Apply pasted tokens</button></section>
      <section className="settings-card"><h3>Restock list</h3><p>Live snapshot of what is low right now — not a pour history. Tap a cutoff; it saves immediately. Bottles with a spare stay off the list so you can Open next instead of buying.</p>
        <label><span>Cans &amp; bottles — flag when below</span><div className="chip-row restock-stops">{RESTOCK_PACKAGED_STOPS.map((count) => <button type="button" key={count} className={`chip${restockRules.packagedBelow === count ? " active" : ""}`} onClick={() => void saveRestock({ packagedBelow: count })}>{count}</button>)}</div></label>
        <label><span>Spirits — flag at or below</span><div className="chip-row restock-stops">{FILL_STOPS.filter((stop) => stop.percent <= 75).map((stop) => <button type="button" key={stop.percent} className={`chip${restockRules.spiritFill === stop.percent ? " active" : ""}`} onClick={() => void saveRestock({ spiritFill: stop.percent })}>{stop.label}</button>)}</div></label>
        <label><span>Wine — flag when below</span><div className="chip-row restock-stops">{RESTOCK_WINE_STOPS.map((count) => <button type="button" key={count} className={`chip${restockRules.wineBelow === count ? " active" : ""}`} onClick={() => void saveRestock({ wineBelow: count })}>{count}</button>)}</div></label>
      </section>
      <section className="settings-card"><h3>COLA Cloud lookup</h3><p>Barcode and name search use your vault first, then COLA Cloud when a key is configured on the server.</p>
        {quotaError && <div className="ai-error"><CircleAlert/><div><strong>Quota unavailable</strong><span>{quotaError}</span></div></div>}
        {quota && quota.configured === false && <p>{quota.message ?? "Set COLA_API_KEY to enable COLA Cloud lookups."}</p>}
        {quota && quota.configured !== false && !quotaError && <div className="stack">
          {quota?.tier && <span className="environment-badge">{quota.tier} tier</span>}
          <div className="quota-stat"><span>Detail views</span><strong>{quota?.detail_views_remaining ?? "—"}{quota?.detail_views_limit ? ` / ${quota.detail_views_limit}` : ""}</strong></div>
          <div className="quota-stat"><span>List records</span><strong>{quota?.list_records_remaining ?? "—"}{quota?.list_records_limit ? ` / ${quota.list_records_limit}` : ""}</strong></div>
          {quota?.quota_reset && <small>Resets {quota.quota_reset}</small>}
          {quota?.detail_views_remaining === "0" && <p className="error">Detail quota is exhausted. Lookups will use cache and Open Food Facts until it resets.</p>}
        </div>}
      </section>
      <section className="settings-card"><div className="ai-settings-heading"><h3>AI provider</h3>{settings.aiConfiguredViaEnvironment==="true"&&<span className="environment-badge">Configured via Server Environment</span>}</div><p>{settings.aiConfiguredViaEnvironment==="true"?`Using ${settings.aiEnvironmentProvider} · ${settings.aiEnvironmentModel}. Server environment values take precedence over fields below.`:"Keys saved here stay in your own SQLite database."}</p><label><span>Provider</span><select value={settings.aiProvider??"ollama"} onChange={(e)=>setSettings({...settings,aiProvider:e.target.value})}>{["ollama","openai","anthropic","openrouter"].map((x)=><option key={x}>{x}</option>)}</select></label><label><span>Model</span><input value={settings.aiModel??""} onChange={(e)=>setSettings({...settings,aiModel:e.target.value})}/></label><label><span>API key</span><input type="password" value={settings.aiApiKey??""} onChange={(e)=>setSettings({...settings,aiApiKey:e.target.value})}/></label><label><span>Base URL (optional)</span><input value={settings.aiBaseUrl??""} onChange={(e)=>setSettings({...settings,aiBaseUrl:e.target.value})}/></label><button className="primary" onClick={save}>Save AI settings</button></section>
      <section className="settings-card"><h3>Data maintenance</h3><p>Daily snapshots are retained in <code>/data/backups</code>. Download a portable copy anytime.</p><div className="stack"><button className="secondary" onClick={()=>download("db")}><Database/> Download SQLite</button><button className="secondary" onClick={()=>download("json")}><Download/> Download JSON</button><button className="secondary" onClick={()=>api("/backups/snapshot",{method:"POST"}).then(()=>setMessage("Snapshot created"))}><Database/> Snapshot now</button></div></section>
      <section className="settings-card"><h3>Spreadsheet import</h3><p>CSV headers should match the field names shown in the API docs.</p><CsvImport/></section>
      <section className="settings-card"><h3>Master PIN</h3><p>Use 4–12 digits. Changing it does not end your current session.</p><PinChange onMessage={setMessage}/></section>
    </div>{message&&<div className="toast">{message}</div>}</>;
}

function CsvImport(){const [table,setTable]=useState("spirits");const [file,setFile]=useState<File>();const [status,setStatus]=useState("");const [error,setError]=useState("");async function run(){if(!file)return;setError("");try{const csv=await file.text();const result=await api<{imported:number}>(`/import/${table}`,{method:"POST",body:JSON.stringify({csv})});setStatus(`${result.imported} rows imported`);}catch(err){setError(err instanceof Error?err.message:"Import failed");}}return <div className="stack"><select value={table} onChange={(e)=>setTable(e.target.value)}>{modules.map((m)=><option key={m.id} value={m.id}>{m.label}</option>)}</select><label className="secondary file-button"><Upload/> Choose CSV<input type="file" accept=".csv,text/csv" onChange={(e)=>setFile(e.target.files?.[0])}/></label><button className="primary" disabled={!file} onClick={run}>Import spreadsheet</button>{status&&<small>{status}</small>}{error&&<p className="error">{error}</p>}</div>}

function PinChange({onMessage}:{onMessage:(value:string)=>void}){const [currentPin,setCurrentPin]=useState("");const [newPin,setNewPin]=useState("");async function change(){try{await api("/auth/pin",{method:"POST",body:JSON.stringify({currentPin,newPin})});setCurrentPin("");setNewPin("");onMessage("Master PIN updated");}catch(error){onMessage(error instanceof Error?error.message:"Could not update PIN");}}return <div className="stack"><input type="password" inputMode="numeric" placeholder="Current PIN" value={currentPin} onChange={(e)=>setCurrentPin(e.target.value)}/><input type="password" inputMode="numeric" placeholder="New PIN" value={newPin} onChange={(e)=>setNewPin(e.target.value)}/><button className="primary" disabled={!currentPin||!/^\d{4,12}$/.test(newPin)} onClick={change}>Update master PIN</button></div>}

function GuestAddPrompt({ draft, onUnlock, onClose }: { draft: ScanDraft; onUnlock: () => void; onClose: () => void }) {
  const name = String(draft.values.name ?? draft.values.product_name ?? "").trim();
  const brand = String(draft.values.brand ?? draft.values.brewery ?? draft.values.producer ?? "").trim();
  const upc = String(draft.values.upc ?? "").trim();
  const titled = Boolean(name && name.toLowerCase() !== "unknown");
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal unlock-modal">
        <button type="button" className="icon-button close" onClick={onClose} aria-label="Dismiss"><X/></button>
        <div className="lock-seal"><Search/></div>
        <span className="eyebrow">NOT IN THE VAULT</span>
        <h2>{titled ? name : "No match in your collection"}</h2>
        <p>{titled
          ? `${brand ? `${brand}. ` : ""}Guests can browse bottles already on the shelf. Unlock admin mode to add this one.`
          : `${upc ? `UPC ${upc} is not on the shelf. ` : ""}Unlock admin mode to add it.`}</p>
        <button className="primary wide" onClick={onUnlock}><LockOpen/> Unlock to add</button>
        <button type="button" className="secondary wide" onClick={onClose}>Keep browsing</button>
      </section>
    </div>
  );
}

function Unlock({onClose,onSuccess}:{onClose:()=>void;onSuccess:()=>void}) {
  const [pin,setPinValue]=useState("");const [error,setError]=useState("");
  async function submit(e:React.FormEvent){e.preventDefault();try{const data=await api<{token:string}>("/auth/unlock",{method:"POST",body:JSON.stringify({pin})});setToken(data.token);onSuccess();}catch{setError("That PIN did not open the vault.");}}
  return <div className="modal-backdrop"><form className="modal unlock-modal" onSubmit={submit}><button type="button" className="icon-button close" onClick={onClose}><X/></button><div className="lock-seal"><Lock/></div><span className="eyebrow">ADMIN ACCESS</span><h2>Unlock the vault</h2><p>Enter your master PIN to manage the collection.</p><input autoFocus inputMode="numeric" pattern="\d*" maxLength={12} type="password" value={pin} onChange={(e)=>setPinValue(e.target.value)} placeholder="••••"/>{error&&<p className="error">{error}</p>}<button className="primary wide">Unlock</button><small>First launch default: 1234</small></form></div>;
}

function uniqueValues(items: Item[], key: string) {
  return [...new Set(items.map((item) => String(item[key] ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
function uniqueWineKinds(items: Item[]) {
  const values = new Set<string>();
  for (const item of items) {
    const type = String(item.type ?? "").trim();
    const style = String(item.style ?? "").trim();
    if (type) values.add(type);
    if (style) values.add(style);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}
function FillLevelScale({ value, onChange }:{
  value: unknown; onChange?: (percent: number) => void;
}) {
  const current = nearestFillStop(value);
  const index = Math.max(0, FILL_STOPS.findIndex((stop) => stop.percent === current));
  const pct = FILL_STOPS.length > 1 ? (index / (FILL_STOPS.length - 1)) * 100 : 0;
  const readOnly = !onChange;
  return (
    <div className={`wine-scale fill-scale${readOnly ? " read-only" : ""}`}>
      <div className="wine-scale-track" aria-hidden="true">
        <span className="wine-scale-marker" style={{ left: `${pct}%` }}/>
      </div>
      <div className="wine-scale-stops" role={readOnly ? "list" : "radiogroup"} aria-label="Fill">
        {FILL_STOPS.map((stop) => readOnly ? (
          <span role="listitem" key={stop.percent} className={stop.percent === current ? "wine-scale-stop active" : "wine-scale-stop"}>{stop.label}</span>
        ) : (
          <button type="button" key={stop.percent} className={stop.percent === current ? "wine-scale-stop active" : "wine-scale-stop"} aria-pressed={stop.percent === current} onClick={() => onChange(stop.percent)}>{stop.label}</button>
        ))}
      </div>
    </div>
  );
}
function WineSweetnessScale({ type, style, value, onChange }:{
  type: string; style: string; value: string; onChange?: (value: string) => void;
}) {
  const stops = wineSweetnessStops(type, style);
  const all = value && !stops.includes(value) ? [...stops, value] : stops;
  const index = Math.max(0, all.indexOf(value));
  const pct = all.length > 1 ? (index / (all.length - 1)) * 100 : 0;
  const readOnly = !onChange;
  return (
    <div className={`wine-scale${readOnly ? " read-only" : ""}`}>
      <div className="wine-scale-track" aria-hidden="true">
        {value ? <span className="wine-scale-marker" style={{ left: `${pct}%` }}/> : null}
      </div>
      <div className="wine-scale-stops" role={readOnly ? "list" : "radiogroup"} aria-label="Sweetness">
        {all.map((stop) => readOnly ? (
          <span role="listitem" key={stop} className={stop === value ? "wine-scale-stop active" : "wine-scale-stop"}>{stop}</span>
        ) : (
          <button type="button" key={stop} className={stop === value ? "wine-scale-stop active" : "wine-scale-stop"} aria-pressed={stop === value} onClick={() => onChange(stop)}>{stop}</button>
        ))}
      </div>
    </div>
  );
}
function BrewStatusScale({ value, onChange, abv, onTap }:{
  value: string; onChange?: (value: string) => void; abv?: string; onTap?: string;
}) {
  const current = normalizeBrewStatus(value);
  const index = Math.max(0, BREW_STATUSES.indexOf(current));
  const pct = BREW_STATUSES.length > 1 ? (index / (BREW_STATUSES.length - 1)) * 100 : 0;
  const readOnly = !onChange;
  const hint = [abv ? `${abv}% ABV` : "", onTap].filter(Boolean).join(" · ");
  return (
    <div className={`wine-scale brew-scale${readOnly ? " read-only" : ""}`}>
      <div className="wine-scale-track" aria-hidden="true">
        <span className="wine-scale-marker" style={{ left: `${pct}%` }}/>
      </div>
      <div className="wine-scale-stops" role={readOnly ? "list" : "radiogroup"} aria-label="Brew status">
        {BREW_STATUSES.map((stop) => readOnly ? (
          <span role="listitem" key={stop} className={stop === current ? "wine-scale-stop active" : "wine-scale-stop"}>{stop}</span>
        ) : (
          <button type="button" key={stop} className={stop === current ? "wine-scale-stop active" : "wine-scale-stop"} aria-pressed={stop === current} onClick={() => onChange(stop)}>{stop}</button>
        ))}
      </div>
      {hint ? <small className="field-hint">{hint}</small> : null}
    </div>
  );
}
function BrewPipeline({ status }:{ status: string }) {
  const current = normalizeBrewStatus(status);
  const index = BREW_STATUSES.indexOf(current);
  return (
    <div className="brew-pipeline" aria-hidden="true">
      {BREW_STATUSES.map((stop, stopIndex) => (
        <span key={stop} className={stopIndex < index ? "done" : stopIndex === index ? "current" : ""}/>
      ))}
    </div>
  );
}
function uniqueItemLists(items: Item[], key: string) {
  return [...new Set(items.flatMap((item) => parseList(item[key])))].sort((a, b) => a.localeCompare(b));
}
function PageTitle({eyebrow,title,subtitle}:{eyebrow:string;title:string;subtitle:string}){return <div className="page-title"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{subtitle}</p></div>}
function Empty({icon:Icon,title,text,actions}:{icon:typeof Bottle;title:string;text:string;actions?:ReactNode}){return <div className="empty"><Icon/><h3>{title}</h3><p>{text}</p>{actions ? <div className="empty-actions">{actions}</div> : null}</div>}
