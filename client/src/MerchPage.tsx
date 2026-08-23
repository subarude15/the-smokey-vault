import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Eye, EyeOff, Plus, Shirt, Trash2 } from "lucide-react";
import { api } from "./api";
import { type MerchItem } from "./catalog";

export function MerchPage({ admin, keeperName }: { admin: boolean; keeperName: string }) {
  const [items, setItems] = useState<MerchItem[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ name: "", description: "", suggested_donation: "", image_url: "" });

  const load = useCallback(() => {
    api<MerchItem[]>("/merch")
      .then((rows) => { setItems(rows); setError(""); })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load merch."));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function addItem() {
    setBusy(true);
    try {
      await api("/merch", { method: "POST", body: JSON.stringify(draft) });
      setDraft({ name: "", description: "", suggested_donation: "", image_url: "" });
      setNotice("Merch added");
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not save that item");
    } finally {
      setBusy(false);
    }
  }

  async function toggleAvailable(item: MerchItem) {
    try {
      await api(`/merch/${item.id}`, { method: "PUT", body: JSON.stringify({ is_available: item.is_available ? 0 : 1 }) });
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not update that item");
    }
  }

  async function removeItem(item: MerchItem) {
    if (!confirm(`Remove “${item.name}”?`)) return;
    try {
      await api(`/merch/${item.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not remove that item");
    }
  }

  return <>
    <div className="page-title">
      <span className="eyebrow">THE MERCH SHELF</span>
      <h1>Take the bar home.</h1>
      <p>{admin ? "Anything listed here shows on guest devices when the Merch tab is enabled." : `Suggested donations only — nothing is for sale. Ask ${keeperName}.`}</p>
    </div>

    {error && <div className="ai-error load-error"><CircleAlert/><div><strong>Could not load merch</strong><span>{error}</span></div><button className="secondary" onClick={load}>Retry</button></div>}

    {admin && <section className="settings-card">
      <span className="eyebrow">NEW ITEM</span>
      <h3>Add merch</h3>
      <label><span>Name</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Smoky Barrel pint glass"/></label>
      <label><span>Description</span><textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })}/></label>
      <label><span>Suggested donation</span><input value={draft.suggested_donation} onChange={(e) => setDraft({ ...draft, suggested_donation: e.target.value })} placeholder="$15"/></label>
      <label><span>Image URL</span><input value={draft.image_url} onChange={(e) => setDraft({ ...draft, image_url: e.target.value })} placeholder="Optional"/></label>
      <button type="button" className="primary" disabled={busy || !draft.name.trim()} onClick={() => void addItem()}><Plus size={17}/> Add item</button>
    </section>}

    {!items.length ? <div className="empty-state"><Shirt size={38}/><h3>Nothing on the shelf</h3><p>{admin ? "Add the first item." : "No merch listed right now."}</p></div> :
      <div className="merch-grid">{items.map((item) => (
        <article className={`merch-card${item.is_available ? "" : " merch-unavailable"}`} key={item.id}>
          <div className="merch-thumb">{item.image_url ? <img src={item.image_url} alt=""/> : <Shirt size={30}/>}</div>
          <div>
            <h3>{item.name}</h3>
            {item.suggested_donation ? <span className="merch-price">{item.suggested_donation}</span> : null}
            {item.description ? <p>{item.description}</p> : null}
            {!item.is_available ? <small>Currently unavailable</small> : null}
          </div>
          {admin && <div className="card-actions">
            <button type="button" className="icon-button" aria-label={item.is_available ? "Mark unavailable" : "Mark available"} onClick={() => void toggleAvailable(item)}>
              {item.is_available ? <Eye size={17}/> : <EyeOff size={17}/>}
            </button>
            <button type="button" className="icon-button danger" aria-label="Remove item" onClick={() => void removeItem(item)}><Trash2 size={17}/></button>
          </div>}
        </article>
      ))}</div>}

    {notice && <div className="toast">{notice}</div>}
  </>;
}
