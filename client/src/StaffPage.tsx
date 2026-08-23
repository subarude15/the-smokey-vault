import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, CircleAlert, Pencil, Plus, Save, Trash2, Users, X } from "lucide-react";
import { api } from "./api";
import { ImageField } from "./ImageField";
import { MAX_STAFF_BIO, MAX_STAFF_NAME, MAX_STAFF_ROLE, STAFF_ROLE_SUGGESTIONS, type StaffMember } from "./catalog";

type Draft = { name: string; role: string; bio: string; image_url: string };

const EMPTY_DRAFT: Draft = { name: "", role: "", bio: "", image_url: "" };

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

export function StaffPage({ admin, keeperName }: { admin: boolean; keeperName: string }) {
  const [crew, setCrew] = useState<StaffMember[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);

  const load = useCallback(() => {
    api<{ staff: StaffMember[] }>("/staff")
      .then((data) => { setCrew(data.staff ?? []); setError(""); })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the crew."));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function addMember() {
    setBusy(true);
    try {
      await api("/staff", { method: "POST", body: JSON.stringify(draft) });
      setDraft(EMPTY_DRAFT);
      setAdding(false);
      setNotice("Crew member added");
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not save that crew member");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(member: StaffMember) {
    setEditingId(member.id);
    setEditDraft({ name: member.name, role: member.role, bio: member.bio, image_url: member.image_url });
  }

  async function saveEdit(id: number) {
    setBusy(true);
    try {
      await api(`/staff/${id}`, { method: "PUT", body: JSON.stringify(editDraft) });
      setEditingId(null);
      setNotice("Saved");
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not update that crew member");
    } finally {
      setBusy(false);
    }
  }

  async function move(member: StaffMember, direction: "up" | "down") {
    try {
      const data = await api<{ staff: StaffMember[] }>(`/staff/${member.id}/move/${direction}`, { method: "POST" });
      setCrew(data.staff ?? []);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not reorder the crew");
    }
  }

  async function removeMember(member: StaffMember) {
    if (!confirm(`Remove ${member.name} from the crew?`)) return;
    try {
      await api(`/staff/${member.id}`, { method: "DELETE" });
      setNotice(`${member.name} removed`);
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not remove that crew member");
    }
  }

  function draftFields(current: Draft, set: (next: Draft) => void) {
    return <>
      <label><span>Name</span>
        <input value={current.name} maxLength={MAX_STAFF_NAME} onChange={(e) => set({ ...current, name: e.target.value })} placeholder="Roo"/>
      </label>
      <label><span>Role</span>
        <input list="staff-roles" autoComplete="off" value={current.role} maxLength={MAX_STAFF_ROLE} onChange={(e) => set({ ...current, role: e.target.value })} placeholder="Chief Welcome Officer"/>
        <datalist id="staff-roles">{STAFF_ROLE_SUGGESTIONS.map((role) => <option key={role} value={role}/>)}</datalist>
      </label>
      <label><span>Bio</span>
        <textarea value={current.bio} maxLength={MAX_STAFF_BIO} onChange={(e) => set({ ...current, bio: e.target.value })} placeholder="Greets every patron at the door. Works for treats."/>
      </label>
      <label className="full"><span>Photo</span></label>
      <ImageField value={current.image_url} onChange={(url) => set({ ...current, image_url: url })}/>
    </>;
  }

  return <>
    <div className="page-title">
      <span className="eyebrow">BEHIND THE BAR</span>
      <h1>Meet the crew.</h1>
      <p>{admin
        ? "The people and pets who keep the vault running. Reorder with the arrows — the top card leads the page."
        : `The regulars behind the bar at ${keeperName}'s place. Pets included, because they earned it.`}</p>
    </div>

    {error && <div className="ai-error load-error"><CircleAlert/><div><strong>Could not load the crew</strong><span>{error}</span></div><button className="secondary" onClick={load}>Retry</button></div>}

    {admin && <section className="settings-card">
      <span className="eyebrow">NEW FACE</span>
      <div className="ai-settings-heading">
        <h3>Add a crew member</h3>
        <button type="button" className="secondary" onClick={() => { setAdding(!adding); setDraft(EMPTY_DRAFT); }}>
          {adding ? <><X size={16}/> Cancel</> : <><Plus size={16}/> New</>}
        </button>
      </div>
      {adding && <>
        <div className="form-grid">{draftFields(draft, setDraft)}</div>
        <button type="button" className="primary" disabled={busy || !draft.name.trim()} onClick={() => void addMember()}>
          <Plus size={17}/> Add to the crew
        </button>
      </>}
    </section>}

    {!crew.length ? <div className="empty-state"><Users size={38}/><h3>No crew yet</h3><p>{admin ? "Add the first face above." : "The crew list is still being written."}</p></div> :
      <div className="crew-grid">{crew.map((member, index) => (
        <article className="crew-card" key={member.id}>
          {editingId === member.id ? <div className="crew-edit">
            <div className="form-grid">{draftFields(editDraft, setEditDraft)}</div>
            <div className="card-actions">
              <button type="button" className="primary" disabled={busy || !editDraft.name.trim()} onClick={() => void saveEdit(member.id)}><Save size={16}/> Save</button>
              <button type="button" className="secondary" onClick={() => setEditingId(null)}>Cancel</button>
            </div>
          </div> : <>
            <div className="crew-portrait">
              {member.image_url ? <img src={member.image_url} alt={member.name}/> : <span className="crew-initials">{initials(member.name)}</span>}
            </div>
            <div className="crew-body">
              <h3>{member.name}</h3>
              {member.role ? <span className="crew-role">{member.role}</span> : null}
              {member.bio ? <p>{member.bio}</p> : null}
            </div>
            {admin && <div className="card-actions crew-actions">
              <button type="button" className="icon-button" aria-label="Move up" disabled={index === 0} onClick={() => void move(member, "up")}><ChevronUp size={17}/></button>
              <button type="button" className="icon-button" aria-label="Move down" disabled={index === crew.length - 1} onClick={() => void move(member, "down")}><ChevronDown size={17}/></button>
              <button type="button" className="icon-button" aria-label={`Edit ${member.name}`} onClick={() => startEdit(member)}><Pencil size={17}/></button>
              <button type="button" className="icon-button danger" aria-label={`Remove ${member.name}`} onClick={() => void removeMember(member)}><Trash2 size={17}/></button>
            </div>}
          </>}
        </article>
      ))}</div>}

    {notice && <div className="toast" onAnimationEnd={() => setNotice("")}>{notice}</div>}
  </>;
}
