import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Copy, Download, Pencil, Plus, Trash2, Users } from "lucide-react";
import { api } from "./api";
import {
  MAX_CONTACT_INFO,
  MAX_MESSAGE_BODY,
  MAX_PATRON_NAME,
  MAX_RSVP_PARTY_SIZE,
  RSVP_SOURCES,
  type EventRsvp,
  type EventRsvpSummary,
  type HouseEvent,
  type RsvpSource,
  type RsvpStatus
} from "./catalog";
import { subscriberContactHref } from "./event-subscribers";
import {
  copyRsvpContact,
  downloadRsvpsCsv,
  emptyRsvpSummary,
  formatRsvpStamp,
  formatRsvpSummary,
  rsvpSourceLabel,
  rsvpStatusLabel
} from "./event-rsvps";

type Draft = {
  name: string;
  contact_info: string;
  status: RsvpStatus;
  party_size: string;
  notes: string;
  source: RsvpSource;
};

const emptyDraft = (): Draft => ({
  name: "",
  contact_info: "",
  status: "going",
  party_size: "1",
  notes: "",
  source: "facebook"
});

function draftFromRsvp(row: EventRsvp): Draft {
  return {
    name: row.name,
    contact_info: row.contact_info,
    status: row.status,
    party_size: String(row.party_size),
    notes: row.notes,
    source: row.source
  };
}

function payloadFromDraft(draft: Draft) {
  const declined = draft.status === "declined";
  return {
    name: draft.name,
    contact_info: draft.contact_info,
    status: draft.status,
    party_size: declined ? 0 : Number(draft.party_size) || 1,
    notes: draft.notes,
    source: draft.source
  };
}

function RsvpFields({
  draft,
  onChange,
  idPrefix
}: {
  draft: Draft;
  onChange: (next: Draft) => void;
  idPrefix: string;
}) {
  const declined = draft.status === "declined";
  return (
    <div className="event-rsvp-keeper-fields">
      <label>
        <span>Name</span>
        <input
          id={`${idPrefix}-name`}
          value={draft.name}
          maxLength={MAX_PATRON_NAME}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </label>
      <label>
        <span>Status</span>
        <select
          value={draft.status}
          onChange={(e) => {
            const status = e.target.value as RsvpStatus;
            onChange({
              ...draft,
              status,
              party_size: status === "declined" ? "0" : draft.party_size === "0" ? "1" : draft.party_size
            });
          }}
        >
          <option value="going">Going</option>
          <option value="maybe">Maybe</option>
          <option value="declined">Can't make it</option>
        </select>
      </label>
      <label>
        <span>Party size</span>
        <input
          type="number"
          min={declined ? 0 : 1}
          max={declined ? 0 : MAX_RSVP_PARTY_SIZE}
          disabled={declined}
          value={declined ? "0" : draft.party_size}
          onChange={(e) => onChange({ ...draft, party_size: e.target.value })}
        />
      </label>
      <label>
        <span>Source</span>
        <select
          value={draft.source}
          onChange={(e) => onChange({ ...draft, source: e.target.value as RsvpSource })}
        >
          {RSVP_SOURCES.map((source) => (
            <option key={source} value={source}>{rsvpSourceLabel(source)}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Phone or email</span>
        <input
          value={draft.contact_info}
          maxLength={MAX_CONTACT_INFO}
          onChange={(e) => onChange({ ...draft, contact_info: e.target.value })}
        />
      </label>
      <label className="event-rsvp-keeper-notes">
        <span>Notes</span>
        <textarea
          value={draft.notes}
          maxLength={MAX_MESSAGE_BODY}
          onChange={(e) => onChange({ ...draft, notes: e.target.value })}
        />
      </label>
    </div>
  );
}

export function EventRsvpKeeper({
  event,
  onNotice
}: {
  event: HouseEvent;
  onNotice: (message: string) => void;
}) {
  const [rsvps, setRsvps] = useState<EventRsvp[]>([]);
  const [summary, setSummary] = useState<EventRsvpSummary>(emptyRsvpSummary);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    api<{ rsvps: EventRsvp[]; summary: EventRsvpSummary }>(`/events/${event.id}/rsvps`)
      .then((payload) => {
        setRsvps(payload.rsvps);
        setSummary(payload.summary);
      })
      .catch((err) => {
        setRsvps([]);
        setSummary(emptyRsvpSummary());
        setError(err instanceof Error ? err.message : "Could not load RSVPs.");
      })
      .finally(() => setLoading(false));
  }, [event.id]);

  useEffect(() => { load(); }, [load]);

  async function addRsvp() {
    setBusy(true);
    try {
      await api(`/events/${event.id}/rsvps`, {
        method: "POST",
        body: JSON.stringify(payloadFromDraft(addDraft))
      });
      setAddDraft(emptyDraft());
      setAdding(false);
      onNotice("RSVP added");
      load();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Could not add that RSVP");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: number) {
    setBusy(true);
    try {
      await api(`/events/${event.id}/rsvps/${id}`, {
        method: "PUT",
        body: JSON.stringify(payloadFromDraft(editDraft))
      });
      setEditingId(null);
      onNotice("RSVP updated");
      load();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Could not update that RSVP");
    } finally {
      setBusy(false);
    }
  }

  async function removeRsvp(row: EventRsvp) {
    if (!confirm(`Remove “${row.name}” from this RSVP list?`)) return;
    setBusy(true);
    try {
      await api(`/events/${event.id}/rsvps/${row.id}`, { method: "DELETE" });
      onNotice(`Removed ${row.name}`);
      load();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Could not remove that RSVP");
    } finally {
      setBusy(false);
    }
  }

  async function copyContact(row: EventRsvp) {
    const result = await copyRsvpContact(row.contact_info);
    if (result === "copied") onNotice("Contact copied");
    else if (result === "empty") onNotice("No contact listed");
    else onNotice("Could not copy in this browser");
  }

  return (
    <section className="subscriber-panel event-rsvp-keeper" aria-labelledby="event-rsvp-keeper-heading">
      <div className="section-heading">
        <div>
          <span className="eyebrow">RSVP LIST</span>
          <h2 id="event-rsvp-keeper-heading">Who's coming</h2>
          <p className="subscriber-panel-lede">{formatRsvpSummary(summary)}</p>
          <p className="subscriber-panel-lede">
            Master guest list for this event — website, Facebook, text, or phone. Separate from the Events invite list.
          </p>
        </div>
      </div>

      {error ? (
        <div className="ai-error load-error" role="alert">
          <CircleAlert/>
          <div>
            <strong>Could not load RSVPs</strong>
            <span>{error}</span>
          </div>
          <button type="button" className="secondary" onClick={load}>Retry</button>
        </div>
      ) : null}

      <div className="subscriber-toolbar">
        <div className="subscriber-toolbar-actions">
          <button
            type="button"
            className="primary"
            onClick={() => { setAdding(true); setAddDraft(emptyDraft()); }}
          >
            <Plus size={16}/> Add RSVP
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!rsvps.length}
            onClick={() => {
              downloadRsvpsCsv(event.title, rsvps);
              onNotice("RSVP CSV downloaded");
            }}
          >
            <Download size={16}/> Export CSV
          </button>
        </div>
      </div>

      {adding ? (
        <div className="event-rsvp-keeper-editor">
          <h3>Add a response</h3>
          <RsvpFields draft={addDraft} onChange={setAddDraft} idPrefix="add-rsvp"/>
          <div className="event-editor-actions">
            <button type="button" className="primary" disabled={busy || !addDraft.name.trim()} onClick={() => void addRsvp()}>
              Save RSVP
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : null}

      {loading && !rsvps.length && !error ? (
        <div className="empty-state subscriber-empty">
          <Users size={34}/>
          <h3>Loading RSVPs…</h3>
        </div>
      ) : null}

      {!loading && !error && !rsvps.length ? (
        <div className="empty-state subscriber-empty">
          <Users size={34}/>
          <h3>No RSVPs yet</h3>
          <p>Guests can reply on this page. Add Facebook, text, or phone responses here so this list stays complete.</p>
        </div>
      ) : null}

      {rsvps.length > 0 ? (
        <ul className="subscriber-list">
          {rsvps.map((row) => {
            const href = subscriberContactHref(row.contact_info);
            const editing = editingId === row.id;
            return (
              <li key={row.id}>
                {editing ? (
                  <div className="event-rsvp-keeper-editor">
                    <RsvpFields draft={editDraft} onChange={setEditDraft} idPrefix={`edit-rsvp-${row.id}`}/>
                    <div className="event-editor-actions">
                      <button type="button" className="primary" disabled={busy || !editDraft.name.trim()} onClick={() => void saveEdit(row.id)}>
                        Save
                      </button>
                      <button type="button" className="secondary" disabled={busy} onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="subscriber-main">
                      <strong>{row.name}</strong>
                      <span className="event-rsvp-meta">
                        {rsvpStatusLabel(row.status)} · {row.party_size} {row.party_size === 1 ? "guest" : "guests"} · {rsvpSourceLabel(row.source)}
                      </span>
                      {row.contact_info ? (
                        href ? (
                          <a className="subscriber-contact" href={href}>{row.contact_info}</a>
                        ) : (
                          <span className="subscriber-contact">{row.contact_info}</span>
                        )
                      ) : (
                        <span className="subscriber-contact">No contact listed</span>
                      )}
                      {row.notes ? <p className="subscriber-notes">Notes: {row.notes}</p> : null}
                      <small className="subscriber-joined">
                        Added {formatRsvpStamp(row.created_at)}
                        {row.updated_at && row.updated_at !== row.created_at
                          ? ` · Updated ${formatRsvpStamp(row.updated_at)}`
                          : ""}
                      </small>
                    </div>
                    <div className="event-rsvp-row-actions">
                      {row.contact_info ? (
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`Copy contact for ${row.name}`}
                          onClick={() => void copyContact(row)}
                        >
                          <Copy size={16}/> Copy
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="secondary"
                        aria-label={`Edit RSVP for ${row.name}`}
                        onClick={() => { setEditingId(row.id); setEditDraft(draftFromRsvp(row)); }}
                      >
                        <Pencil size={16}/> Edit
                      </button>
                      <button
                        type="button"
                        className="secondary danger"
                        disabled={busy}
                        aria-label={`Remove ${row.name} from this RSVP list`}
                        onClick={() => void removeRsvp(row)}
                      >
                        <Trash2 size={16}/> Remove
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
