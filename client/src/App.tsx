import { useCallback, useEffect, useState } from "react";
import {
  Beer, BottleWine as Bottle, ChevronRight, Database, Download, FlaskConical, Grape, LayoutDashboard,
  Lock, LockOpen, Menu, Moon, Plus, Search, Settings, Shuffle, Sparkles, Sun, Trash2, Upload, Wine, X
} from "lucide-react";
import { api, clearToken, downloadExport, Item, setToken, tokenExists } from "./api";
import { Scanner } from "./Scanner";

type Field = { key: string; label: string; type?: string; options?: string[] };
type Module = { id: string; label: string; singular: string; icon: typeof Bottle; title: string; subtitle: string; fields: Field[]; primary: string; secondary: string };

const modules: Module[] = [
  { id: "spirits", label: "Spirits & Mixers", singular: "Bottle", icon: Bottle, title: "The Bottle Library", subtitle: "Spirits, liqueurs, bitters, and every essential mixer.", primary: "name", secondary: "brand", fields: [
    { key:"name",label:"Name" },{ key:"brand",label:"Brand" },{ key:"category",label:"Category",options:["Bourbon","Rye","Scotch","Irish","Gin","Tequila","Mezcal","Rum","Amaro","Liqueur","Bitters","Mixer","Vodka","Cognac"] },
    { key:"sub_category",label:"Sub-category" },{ key:"abv",label:"ABV %",type:"number" },{ key:"volume_ml",label:"Volume (ml)",type:"number" },{ key:"fill_level",label:"Fill level %",type:"range" },
    { key:"purchase_date",label:"Purchase date",type:"date" },{ key:"opened_date",label:"Date opened",type:"date" },{ key:"shelf_location",label:"Shelf location" },{ key:"upc",label:"UPC" },
    { key:"image_url",label:"Image URL",type:"url" },{ key:"notes",label:"Notes",type:"textarea" }
  ]},
  { id: "taps", label: "Draft Taps", singular: "Tap", icon: Beer, title: "On Tap", subtitle: "Live pours and keg levels at a glance.", primary: "brewery_batch", secondary: "style", fields: [
    {key:"tap_number",label:"Tap #",type:"number"},{key:"keg_size_l",label:"Keg size (L)",type:"number"},{key:"source_type",label:"Source",options:["Commercial","Homebrew"]},{key:"brewery_batch",label:"Brewery / Batch"},
    {key:"style",label:"Style"},{key:"abv",label:"ABV %",type:"number"},{key:"ibu",label:"IBU",type:"number"},{key:"tapped_date",label:"Date tapped",type:"date"},{key:"remaining_l",label:"Remaining (L)",type:"number"}
  ]},
  { id: "brews", label: "Brewery", singular: "Batch", icon: FlaskConical, title: "Brewery Lab", subtitle: "Plan batches and follow fermentation through the cellar.", primary: "batch_name", secondary: "style", fields: [
    {key:"batch_name",label:"Batch name"},{key:"style",label:"Style"},{key:"brew_date",label:"Brew date",type:"date"},{key:"target_og",label:"Target OG",type:"number"},{key:"target_fg",label:"Target FG",type:"number"},
    {key:"measured_og",label:"Measured OG",type:"number"},{key:"measured_fg",label:"Measured FG",type:"number"},{key:"calculated_abv",label:"Calculated ABV %",type:"number"},
    {key:"schedule",label:"Dry hop / adjunct schedule",type:"textarea"},{key:"status",label:"Status",options:["Planned","Fermenting","Conditioning","Ready to Keg","Archived"]},{key:"notes",label:"Brew notes",type:"textarea"}
  ]},
  { id: "packaged_beer", label: "Packaged Beer", singular: "Beer", icon: Beer, title: "Packaged Beer", subtitle: "The cold-room count for cans and bottles.", primary: "name", secondary: "brewery", fields: [
    {key:"brewery",label:"Brewery"},{key:"name",label:"Name"},{key:"style",label:"Style"},{key:"count",label:"Can / bottle count",type:"number"},{key:"pack_date",label:"Pack date",type:"date"},{key:"abv",label:"ABV %",type:"number"}
  ]},
  { id: "wines", label: "Wine Cellar", singular: "Wine", icon: Grape, title: "The Wine Cellar", subtitle: "Track bottles, vintages, pairings, and ideal drinking windows.", primary: "name", secondary: "producer", fields: [
    {key:"producer",label:"Producer / Winery"},{key:"name",label:"Wine name"},{key:"varietal",label:"Varietal"},{key:"vintage",label:"Vintage",type:"number"},{key:"type",label:"Type",options:["Red","White","Rosé","Sparkling","Dessert","Fortified"]},
    {key:"region",label:"Region"},{key:"sweetness",label:"Sweetness (1–5)",type:"range5"},{key:"body",label:"Body (1–5)",type:"range5"},{key:"bottle_count",label:"Bottle count",type:"number"},
    {key:"drink_by_date",label:"Drink-by date",type:"date"},{key:"pairings",label:"Pairings"},{key:"notes",label:"Notes",type:"textarea"}
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

export default function App() {
  const [page, setPage] = useState("dashboard");
  const [admin, setAdmin] = useState(tokenExists());
  const [mobileNav, setMobileNav] = useState(false);
  const [scanner, setScanner] = useState(false);
  const [unlock, setUnlock] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem("smokey-theme") ?? "dark");
  const [counts, setCounts] = useState<Record<string,number>>({});
  const [backupDue, setBackupDue] = useState(false);
  const lock = useCallback(() => { clearToken(); setAdmin(false); }, []);

  useEffect(() => { applyTheme(theme); localStorage.setItem("smokey-theme", theme); }, [theme]);
  useEffect(() => {
    Promise.all(modules.map(async (m) => [m.id, (await api<Item[]>(`/inventory/${m.id}`)).length] as const))
      .then((pairs) => setCounts(Object.fromEntries(pairs))).catch(() => {});
  }, [page]);
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
  const nav = [
    { id:"dashboard",label:"Overview",icon:LayoutDashboard }, ...modules.map((m) => ({ id:m.id,label:m.label,icon:m.icon })),
    { id:"cocktails",label:"Cocktail Book",icon:Wine },{ id:"mixologist",label:"AI Mixologist",icon:Sparkles },{ id:"settings",label:"Settings",icon:Settings,admin:true }
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
          {page === "dashboard" && <Dashboard counts={counts} admin={admin} go={navigate}/>}
          {modules.map((module) => page === module.id && <Inventory key={module.id} module={module} admin={admin}/>)}
          {page === "cocktails" && <Cocktails/>}
          {page === "mixologist" && <Mixologist/>}
          {page === "settings" && admin && <SettingsPage theme={theme} setTheme={setTheme}/>}
        </div>
      </main>
      {mobileNav && <button className="nav-backdrop" onClick={() => setMobileNav(false)} aria-label="Close navigation"/>}
      {scanner && <Scanner onClose={() => setScanner(false)} onProduct={() => { setScanner(false); navigate("spirits"); }}/>}
      {unlock && <Unlock onClose={() => setUnlock(false)} onSuccess={() => { setAdmin(true); setUnlock(false); }}/>}
    </div>
  );
}

function Dashboard({ counts, admin, go }: { counts: Record<string,number>; admin:boolean; go:(page:string)=>void }) {
  return <>
    <div className="hero">
      <div><span className="eyebrow">GOOD EVENING</span><h1>Your private bar,<br/><em>beautifully organized.</em></h1><p>Browse the collection, see what is pouring, and find your next perfect drink.</p></div>
      <div className="hero-orbit"><Wine/><span>{counts.spirits ?? 0}<small>BOTTLES</small></span></div>
    </div>
    <section><div className="section-heading"><div><span className="eyebrow">AT A GLANCE</span><h2>Inside the vault</h2></div>{!admin && <span className="guest-badge"><Lock size={13}/> DIGITAL BAR MENU</span>}</div>
      <div className="stat-grid">
        {modules.slice(0,5).map((m) => <button className="stat-card" key={m.id} onClick={() => go(m.id)}><m.icon/><span>{counts[m.id] ?? 0}</span><small>{m.label.toUpperCase()}</small><ChevronRight/></button>)}
      </div>
    </section>
    <section className="feature-grid">
      <button className="feature-card warm" onClick={() => go("cocktails")}><div><span className="eyebrow">INVENTORY MATCHER</span><h2>What can I make?</h2><p>Instant recipes based on what is on your shelves.</p></div><Wine size={56}/></button>
      <button className="feature-card" onClick={() => go("mixologist")}><div><span className="eyebrow">CUSTOM CREATIONS</span><h2>Ask the Mixologist</h2><p>Describe the mood. Your own AI key powers the pour.</p></div><Sparkles size={56}/></button>
    </section>
  </>;
}

function Inventory({ module, admin }: { module:Module; admin:boolean }) {
  const [items,setItems] = useState<Item[]>([]);
  const [search,setSearch] = useState("");
  const [editing,setEditing] = useState<Item | null | undefined>();
  const load = useCallback(() => api<Item[]>(`/inventory/${module.id}`).then(setItems), [module.id]);
  useEffect(() => { load().catch(() => {}); }, [load]);
  const filtered = items.filter((item) => JSON.stringify(item).toLowerCase().includes(search.toLowerCase()));
  async function remove(id:number) { if (!confirm("Remove this item from the vault?")) return; await api(`/inventory/${module.id}/${id}`,{method:"DELETE"}); load(); }
  return <>
    <PageTitle eyebrow={module.label.toUpperCase()} title={module.title} subtitle={module.subtitle}/>
    <div className="toolbar"><label className="search"><Search/><input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder={`Search ${module.label.toLowerCase()}…`}/></label>{admin && <button className="primary" onClick={() => setEditing(null)}><Plus/> Add {module.singular}</button>}</div>
    {!filtered.length ? <Empty icon={module.icon} title={`No ${module.label.toLowerCase()} yet`} text={admin ? `Add your first ${module.singular.toLowerCase()} to begin.` : "The vault keeper has not stocked this section yet."}/> :
      <div className="inventory-grid">{filtered.map((item) => <article className="inventory-card" key={item.id}>
        <div className="card-icon">{item.image_url ? <img src={String(item.image_url)} alt=""/> : <module.icon/>}</div>
        <div className="card-content"><span className="eyebrow">{String(item[module.secondary] ?? item.style ?? "")}</span><h3>{String(item[module.primary] ?? "Untitled")}</h3>
          <div className="meta">{item.abv ? <span>{item.abv}% ABV</span> : null}{item.status ? <span>{item.status}</span> : null}{item.bottle_count != null ? <span>{item.bottle_count} bottles</span> : null}{item.count != null ? <span>{item.count} packaged</span> : null}</div>
          {module.id === "spirits" && <div className="fill"><span style={{width:`${Number(item.fill_level ?? 0)}%`}}/><small>{item.fill_level}% full</small></div>}
          {module.id === "taps" && <div className="fill"><span style={{width:`${Math.min(100,Number(item.remaining_l)/Number(item.keg_size_l)*100)}%`}}/><small>{item.remaining_l} L remaining · ~{Math.floor(Number(item.remaining_l)*2.1)} pints</small></div>}
        </div>{admin && <div className="card-actions"><button className="icon-button" onClick={() => setEditing(item)}><Settings size={17}/></button><button className="icon-button danger" onClick={() => remove(item.id)}><Trash2 size={17}/></button></div>}
      </article>)}</div>}
    {editing !== undefined && <ItemForm module={module} item={editing} close={() => setEditing(undefined)} saved={() => { setEditing(undefined); load(); }}/>}
  </>;
}

function ItemForm({ module,item,close,saved }:{module:Module;item:Item|null;close:()=>void;saved:()=>void}) {
  const [form,setForm] = useState<Record<string,unknown>>(item ?? {});
  const [error,setError] = useState("");
  async function submit(e:React.FormEvent) { e.preventDefault(); try { await api(`/inventory/${module.id}${item ? `/${item.id}` : ""}`,{method:item?"PUT":"POST",body:JSON.stringify(form)}); saved(); } catch(err){setError(err instanceof Error?err.message:"Could not save");} }
  return <div className="modal-backdrop"><form className="modal form-modal" onSubmit={submit}><header className="modal-header"><div><span className="eyebrow">{item?"EDIT":"NEW"} {module.singular.toUpperCase()}</span><h2>{item ? String(item[module.primary]) : `Add ${module.singular}`}</h2></div><button type="button" className="icon-button" onClick={close}><X/></button></header>
    <div className="form-grid">{module.fields.map((field) => <label className={field.type==="textarea"?"full":""} key={field.key}><span>{field.label}</span>
      {field.options ? <select value={String(form[field.key]??field.options[0])} onChange={(e)=>setForm({...form,[field.key]:e.target.value})}>{field.options.map((v)=><option key={v}>{v}</option>)}</select> :
      field.type==="textarea" ? <textarea value={String(form[field.key]??"")} onChange={(e)=>setForm({...form,[field.key]:e.target.value})}/> :
      field.type?.startsWith("range") ? <div className="range-wrap"><input type="range" min={field.type==="range5"?1:0} max={field.type==="range5"?5:100} value={Number(form[field.key]??(field.type==="range5"?3:100))} onChange={(e)=>setForm({...form,[field.key]:Number(e.target.value)})}/><b>{String(form[field.key]??(field.type==="range5"?3:100))}</b></div> :
      <input type={field.type??"text"} step={field.type==="number"?"any":undefined} value={String(form[field.key]??"")} onChange={(e)=>setForm({...form,[field.key]:field.type==="number"?Number(e.target.value):e.target.value})}/>}</label>)}</div>
    {error && <p className="error">{error}</p>}<footer className="modal-footer"><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary">Save to vault</button></footer></form></div>;
}

type CocktailDrink = Item & { ingredients:string[]; missing:string[]; readiness:string; season:string; garnish:string; method:string; glassware:string; collection:string };

function Cocktails() {
  const [drinks,setDrinks] = useState<CocktailDrink[]>([]);
  const [filter,setFilter] = useState("ready");
  const [season,setSeason] = useState("All");
  const [selected,setSelected] = useState<CocktailDrink>();
  useEffect(()=>{api<typeof drinks>("/cocktails/match").then(setDrinks).catch(()=>{});},[]);
  const inSeason = drinks.filter((drink)=>season==="All"||drink.season===season);
  const shown = inSeason.filter((drink)=>filter==="all"||drink.readiness===filter);
  const ready = inSeason.filter((drink)=>drink.readiness==="ready");
  function surprise(){if(!ready.length)return;setSelected(ready[Math.floor(Math.random()*ready.length)]);}
  return <><PageTitle eyebrow="THE RECIPE INDEX" title="What can I make?" subtitle="Live matches against your shelves, including pantry staples and smart spirit substitutions."/>
    <div className="cocktail-toolbar"><div className="segmented cocktail-filters">{[["ready","Ready now"],["almost","Missing one"],["all","All recipes"]].map(([id,label])=><button key={id} className={filter===id?"active":""} onClick={()=>setFilter(id)}>{label}</button>)}</div><button className="primary surprise-button" disabled={!ready.length} onClick={surprise}><Shuffle size={18}/> Surprise me</button></div>
    <section className="season-section"><span className="eyebrow">SEASONAL COCKTAILS</span><div className="season-filters">{["All","Spring","Summer","Fall","Winter","Holiday"].map((value)=><button key={value} className={season===value?"active":""} onClick={()=>setSeason(value)}>{value==="All"?"All seasons":value}</button>)}</div></section>
    {!shown.length?<Empty icon={Wine} title="No matching cocktails" text={season==="All"?"Stock a few more ingredients and check back.":`No ${season.toLowerCase()} recipes match this readiness filter.`}/>:<div className="recipe-grid">{shown.map((drink)=><button className="recipe-card" key={drink.id} onClick={()=>setSelected(drink)}><span className={`status ${drink.readiness}`}>{drink.readiness==="ready"?"READY TO POUR":drink.readiness==="almost"?"ONE ITEM AWAY":"BUILD THE SHELF"}</span>{drink.season!=="All"&&<span className="season-tag">{drink.season}</span>}<h3>{drink.name}</h3><p>{drink.method} · {drink.glassware}</p><ul>{drink.ingredients.map((i)=><li key={i}>{i}</li>)}</ul>{drink.missing.length>0&&<small>Missing: {drink.missing.join(", ")}</small>}</button>)}</div>}
    {selected&&<RecipeModal drink={selected} close={()=>setSelected(undefined)}/>}
  </>;
}

function RecipeModal({drink,close}:{drink:CocktailDrink;close:()=>void}){
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`${drink.name} recipe`}><section className="modal recipe-modal"><header className="modal-header"><div><span className="eyebrow">{drink.collection}{drink.season!=="All"?` · ${drink.season}`:""}</span><h2>{drink.name}</h2><p>{drink.method} · {drink.glassware}</p></div><button className="icon-button" onClick={close} aria-label="Close recipe"><X/></button></header><div className="recipe-modal-body"><div><span className="eyebrow">INGREDIENTS</span><ul>{drink.ingredients.map((ingredient)=><li key={ingredient}>{ingredient}</li>)}</ul></div><div className="recipe-details"><div><span>METHOD</span><strong>{drink.method}</strong></div><div><span>GLASS</span><strong>{drink.glassware}</strong></div><div><span>GARNISH</span><strong>{drink.garnish||"None"}</strong></div></div></div>{drink.missing.length>0&&<p className="recipe-warning">Missing from your vault: {drink.missing.join(", ")}</p>}<footer className="modal-footer"><button className="primary" onClick={close}>Cheers</button></footer></section></div>
}

function Mixologist() {
  const [prompt,setPrompt] = useState(""); const [result,setResult] = useState(""); const [loading,setLoading] = useState(false);
  async function ask(){setLoading(true);setResult("");try{const data=await api<{result:string}>("/ai/mixologist",{method:"POST",body:JSON.stringify({prompt})});setResult(data.result);}catch(e){setResult(e instanceof Error?e.message:"AI request failed");}finally{setLoading(false);}}
  return <><PageTitle eyebrow="YOUR PERSONAL BARTENDER" title="Make it memorable." subtitle="Tell us a flavor, feeling, occasion, or ingredient. Your inventory shapes every recommendation."/>
    <div className="mixologist"><Sparkles size={44}/><div className="prompt-chips">{["Smoky and contemplative","Bright summer highball","Use my amaro","A low-ABV nightcap"].map((p)=><button key={p} onClick={()=>setPrompt(p)}>{p}</button>)}</div><textarea value={prompt} onChange={(e)=>setPrompt(e.target.value)} placeholder="Tonight I want something spirit-forward, smoky, and not too sweet…"/><button className="primary" disabled={loading||!prompt} onClick={ask}><Sparkles/> {loading?"Thinking…":"Create my cocktail"}</button>{result&&<div className="ai-result">{result}</div>}</div>
  </>;
}

function SettingsPage({theme,setTheme}:{theme:string;setTheme:(v:string)=>void}) {
  const [settings,setSettings] = useState<Record<string,string>>({}); const [message,setMessage]=useState(""); const [themeText,setThemeText]=useState("");
  useEffect(()=>{api<Record<string,string>>("/settings").then(setSettings).catch(()=>{});},[]);
  async function save(){await api("/settings",{method:"PUT",body:JSON.stringify(settings)});setMessage("Settings saved");}
  function applyThemeJson(text:string){try{const raw=JSON.parse(text);const flat=raw.schemes?.dark??raw.dark??raw;const tokens:Record<string,string>={"--accent":flat.primary,"--bg":flat.background,"--surface":flat.surface,"--text":flat.onSurface,"--line":flat.outlineVariant};Object.keys(tokens).forEach((k)=>!tokens[k]&&delete tokens[k]);applyTheme("custom",tokens);setSettings((current)=>({...current,themeTokens:JSON.stringify(tokens)}));setMessage("Material tokens applied — save to persist.");}catch{setMessage("That content is not valid Material theme JSON.");}}
  function importTheme(file:File){const reader=new FileReader();reader.onload=()=>applyThemeJson(String(reader.result));reader.readAsText(file);}
  const download=(format:"db"|"json")=>{downloadExport(format).catch(()=>setMessage("Export failed"));};
  return <><PageTitle eyebrow="VAULT ADMINISTRATION" title="Settings & maintenance" subtitle="Security, appearance, AI providers, and durable backups."/>
    <div className="settings-grid"><section className="settings-card"><h3>Appearance</h3><p>Choose a contrast profile for every display.</p><div className="theme-grid">{["light","dark","oled"].map((t)=><button key={t} className={theme===t?"active":""} onClick={()=>setTheme(t)}><span className={`theme-swatch ${t}`}/>{t==="oled"?"OLED Black":t[0].toUpperCase()+t.slice(1)}</button>)}</div><label className="secondary file-button"><Upload/> Import Material theme<input type="file" accept=".json,application/json" onChange={(e)=>e.target.files?.[0]&&importTheme(e.target.files[0])}/></label><textarea value={themeText} onChange={(e)=>setThemeText(e.target.value)} placeholder="Or paste theme.json / tokens.json here"/><button className="secondary" disabled={!themeText} onClick={()=>applyThemeJson(themeText)}>Apply pasted tokens</button></section>
      <section className="settings-card"><h3>AI provider</h3><p>Keys stay in your own SQLite database.</p><label><span>Provider</span><select value={settings.aiProvider??"ollama"} onChange={(e)=>setSettings({...settings,aiProvider:e.target.value})}>{["ollama","openai","anthropic","openrouter"].map((x)=><option key={x}>{x}</option>)}</select></label><label><span>Model</span><input value={settings.aiModel??""} onChange={(e)=>setSettings({...settings,aiModel:e.target.value})}/></label><label><span>API key</span><input type="password" value={settings.aiApiKey??""} onChange={(e)=>setSettings({...settings,aiApiKey:e.target.value})}/></label><label><span>Base URL (optional)</span><input value={settings.aiBaseUrl??""} onChange={(e)=>setSettings({...settings,aiBaseUrl:e.target.value})}/></label><button className="primary" onClick={save}>Save AI settings</button></section>
      <section className="settings-card"><h3>Data maintenance</h3><p>Daily snapshots are retained in <code>/data/backups</code>. Download a portable copy anytime.</p><div className="stack"><button className="secondary" onClick={()=>download("db")}><Database/> Download SQLite</button><button className="secondary" onClick={()=>download("json")}><Download/> Download JSON</button><button className="secondary" onClick={()=>api("/backups/snapshot",{method:"POST"}).then(()=>setMessage("Snapshot created"))}><Database/> Snapshot now</button></div></section>
      <section className="settings-card"><h3>Spreadsheet import</h3><p>CSV headers should match the field names shown in the API docs.</p><CsvImport/></section>
      <section className="settings-card"><h3>Master PIN</h3><p>Use 4–12 digits. Changing it does not end your current session.</p><PinChange onMessage={setMessage}/></section>
    </div>{message&&<div className="toast">{message}</div>}</>;
}

function CsvImport(){const [table,setTable]=useState("spirits");const [file,setFile]=useState<File>();const [status,setStatus]=useState("");async function run(){if(!file)return;const csv=await file.text();const result=await api<{imported:number}>(`/import/${table}`,{method:"POST",body:JSON.stringify({csv})});setStatus(`${result.imported} rows imported`);}return <div className="stack"><select value={table} onChange={(e)=>setTable(e.target.value)}>{modules.map((m)=><option key={m.id} value={m.id}>{m.label}</option>)}</select><label className="secondary file-button"><Upload/> Choose CSV<input type="file" accept=".csv,text/csv" onChange={(e)=>setFile(e.target.files?.[0])}/></label><button className="primary" disabled={!file} onClick={run}>Import spreadsheet</button>{status&&<small>{status}</small>}</div>}

function PinChange({onMessage}:{onMessage:(value:string)=>void}){const [currentPin,setCurrentPin]=useState("");const [newPin,setNewPin]=useState("");async function change(){try{await api("/auth/pin",{method:"POST",body:JSON.stringify({currentPin,newPin})});setCurrentPin("");setNewPin("");onMessage("Master PIN updated");}catch(error){onMessage(error instanceof Error?error.message:"Could not update PIN");}}return <div className="stack"><input type="password" inputMode="numeric" placeholder="Current PIN" value={currentPin} onChange={(e)=>setCurrentPin(e.target.value)}/><input type="password" inputMode="numeric" placeholder="New PIN" value={newPin} onChange={(e)=>setNewPin(e.target.value)}/><button className="primary" disabled={!currentPin||!/^\d{4,12}$/.test(newPin)} onClick={change}>Update master PIN</button></div>}

function Unlock({onClose,onSuccess}:{onClose:()=>void;onSuccess:()=>void}) {
  const [pin,setPinValue]=useState("");const [error,setError]=useState("");
  async function submit(e:React.FormEvent){e.preventDefault();try{const data=await api<{token:string}>("/auth/unlock",{method:"POST",body:JSON.stringify({pin})});setToken(data.token);onSuccess();}catch{setError("That PIN did not open the vault.");}}
  return <div className="modal-backdrop"><form className="modal unlock-modal" onSubmit={submit}><button type="button" className="icon-button close" onClick={onClose}><X/></button><div className="lock-seal"><Lock/></div><span className="eyebrow">ADMIN ACCESS</span><h2>Unlock the vault</h2><p>Enter your master PIN to manage the collection.</p><input autoFocus inputMode="numeric" pattern="\d*" maxLength={12} type="password" value={pin} onChange={(e)=>setPinValue(e.target.value)} placeholder="••••"/>{error&&<p className="error">{error}</p>}<button className="primary wide">Unlock</button><small>First launch default: 1234</small></form></div>;
}

function PageTitle({eyebrow,title,subtitle}:{eyebrow:string;title:string;subtitle:string}){return <div className="page-title"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{subtitle}</p></div>}
function Empty({icon:Icon,title,text}:{icon:typeof Bottle;title:string;text:string}){return <div className="empty"><Icon/><h3>{title}</h3><p>{text}</p></div>}
