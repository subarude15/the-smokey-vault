import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Crown, Minus, Plus, Trash2, Users } from "lucide-react";
import { api } from "./api";
import { MAX_PATRON_NAME, MAX_PATRON_NICKNAME, TOP_PATRON_BANNER, type Patron } from "./catalog";

export function usePatrons(): { patrons: Patron[]; reload: () => void; error: string } {
  const [patrons, setPatrons] = useState<Patron[]>([]);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    api<{ patrons: Patron[] }>("/patrons")
      .then((data) => { setPatrons(data.patrons ?? []); setError(""); })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the leaderboard."));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { patrons, reload, error };
}

function visitLabel(count: number) {
  return `${count} visit${count === 1 ? "" : "s"}`;
}

export function PatronsPage({ admin, keeperName }: { admin: boolean; keeperName: string }) {
  const { patrons, reload, error } = usePatrons();
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function addPatron() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api("/patrons", { method: "POST", body: JSON.stringify({ name, nickname }) });
      setName("");
      setNickname("");
      setNotice("Added to the leaderboard");
      reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not add that patron");
    } finally {
      setBusy(false);
    }
  }

  async function adjust(patron: Patron, direction: "increment" | "decrement") {
    try {
      await api(`/patrons/${patron.id}/${direction}`, { method: "POST" });
      reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not update that visit count");
    }
  }

  async function remove(patron: Patron) {
    if (!confirm(`Remove ${patron.name} from the leaderboard?`)) return;
    try {
      await api(`/patrons/${patron.id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not remove that patron");
    }
  }

  const [champion, ...rest] = patrons;

  return <>
    <div className="page-title">
      <span className="eyebrow">THE REGULARS</span>
      <h1>Who keeps this bar alive.</h1>
      <p>{admin
        ? "Log a visit every time a regular walks in. The top of this board is the house hall of fame."
        : `The most loyal patrons of The Smoky Barrel Bar. Say hello to ${keeperName} and get yourself on the board.`}</p>
    </div>

    {error && <div className="ai-error load-error"><CircleAlert/><div><strong>Could not load the leaderboard</strong><span>{error}</span></div><button className="secondary" onClick={reload}>Retry</button></div>}

    {admin && <div className="patron-add">
      <label><span>Name</span><input value={name} maxLength={MAX_PATRON_NAME} onChange={(e) => setName(e.target.value)} placeholder="Who just walked in?"/></label>
      <label><span>Nickname</span><input value={nickname} maxLength={MAX_PATRON_NICKNAME} onChange={(e) => setNickname(e.target.value)} placeholder="Optional"/></label>
      <button type="button" className="primary" disabled={busy || !name.trim()} onClick={() => void addPatron()}><Plus size={17}/> Add regular</button>
    </div>}

    {!patrons.length ? <div className="empty-state"><Users size={38}/><h3>No regulars yet</h3><p>{admin ? "Add the first name to start the hall of fame." : "The board is still being written."}</p></div> : <>
      {champion && <section className="legend-banner">
        <Crown size={44}/>
        <div>
          <span className="eyebrow">{TOP_PATRON_BANNER}</span>
          <h2>{champion.name}</h2>
          <p>{champion.nickname ? `“${champion.nickname}” · ` : ""}{visitLabel(champion.visit_count)} and counting.</p>
        </div>
        {admin && <div className="legend-actions">
          <button type="button" className="icon-button" aria-label={`Log a visit for ${champion.name}`} onClick={() => void adjust(champion, "increment")}><Plus size={18}/></button>
          <button type="button" className="icon-button" aria-label={`Remove a visit for ${champion.name}`} onClick={() => void adjust(champion, "decrement")}><Minus size={18}/></button>
        </div>}
      </section>}

      <ol className="patron-board">
        {rest.map((patron, index) => (
          <li key={patron.id} className="patron-row">
            <span className="patron-rank">#{index + 2}</span>
            <div className="patron-identity">
              <strong>{patron.name}</strong>
              {patron.nickname ? <small>“{patron.nickname}”</small> : null}
            </div>
            <span className="patron-visits">{visitLabel(patron.visit_count)}</span>
            {admin && <div className="patron-actions">
              <button type="button" className="icon-button" aria-label={`Log a visit for ${patron.name}`} onClick={() => void adjust(patron, "increment")}><Plus size={16}/></button>
              <button type="button" className="icon-button" aria-label={`Remove a visit for ${patron.name}`} onClick={() => void adjust(patron, "decrement")}><Minus size={16}/></button>
              <button type="button" className="icon-button danger" aria-label={`Remove ${patron.name}`} onClick={() => void remove(patron)}><Trash2 size={16}/></button>
            </div>}
          </li>
        ))}
      </ol>
      {!admin && patrons.length >= 15 && <p className="board-footnote">Top 15 shown. Keep showing up.</p>}
    </>}

    {notice && <div className="toast">{notice}</div>}
  </>;
}
