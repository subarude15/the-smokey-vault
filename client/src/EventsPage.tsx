import { useCallback, useEffect, useState } from "react";
import { CalendarDays, CircleAlert, Eye, EyeOff, PartyPopper, Plus, Trash2 } from "lucide-react";
import { api } from "./api";
import { MAX_CONTACT_INFO, MAX_PATRON_NAME, type EventSubscriber, type HouseEvent } from "./catalog";

function eventDateLabel(raw: string) {
  const stamp = Date.parse(raw);
  if (!Number.isFinite(stamp)) return raw;
  return new Date(stamp).toLocaleDateString(undefined, { weekday: "short", month: "long", day: "numeric", year: "numeric" });
}

function isUpcoming(raw: string) {
  const stamp = Date.parse(raw);
  return !Number.isFinite(stamp) || stamp >= Date.now() - 86_400_000;
}

export function EventsPage({ admin, keeperName }: { admin: boolean; keeperName: string }) {
  const [events, setEvents] = useState<HouseEvent[]>([]);
  const [subscribers, setSubscribers] = useState<EventSubscriber[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState({ title: "", event_date: "", description: "", image_url: "" });
  const [rsvp, setRsvp] = useState({ name: "", contact_info: "", notes: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<HouseEvent[]>("/events")
      .then((rows) => { setEvents(rows); setError(""); })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load events."));
    if (admin) api<EventSubscriber[]>("/event-subscribers").then(setSubscribers).catch(() => setSubscribers([]));
  }, [admin]);
  useEffect(() => { load(); }, [load]);

  async function addEvent() {
    setBusy(true);
    try {
      await api("/events", { method: "POST", body: JSON.stringify(draft) });
      setDraft({ title: "", event_date: "", description: "", image_url: "" });
      setNotice("Event added");
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not save that event");
    } finally {
      setBusy(false);
    }
  }

  async function togglePublished(event: HouseEvent) {
    try {
      await api(`/events/${event.id}`, { method: "PUT", body: JSON.stringify({ is_published: event.is_published ? 0 : 1 }) });
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not update that event");
    }
  }

  async function removeEvent(event: HouseEvent) {
    if (!confirm(`Remove “${event.title}”?`)) return;
    try {
      await api(`/events/${event.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not remove that event");
    }
  }

  async function subscribe() {
    setBusy(true);
    try {
      await api("/event-subscribers", { method: "POST", body: JSON.stringify(rsvp) });
      setRsvp({ name: "", contact_info: "", notes: "" });
      setNotice("You are on the list. Watch for an invite.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not add you to the list");
    } finally {
      setBusy(false);
    }
  }

  const upcoming = events.filter((event) => isUpcoming(event.event_date));
  const past = events.filter((event) => !isUpcoming(event.event_date));

  function eventCard(event: HouseEvent) {
    return <article className={`event-card${event.is_published ? "" : " event-unpublished"}`} key={event.id}>
      {event.image_url ? <img src={event.image_url} alt=""/> : null}
      <div>
        <span className="eyebrow"><CalendarDays size={14}/> {eventDateLabel(event.event_date)}</span>
        <h3>{event.title}</h3>
        {event.description ? <p>{event.description}</p> : null}
      </div>
      {admin && <div className="card-actions">
        <button type="button" className="icon-button" aria-label={event.is_published ? "Hide from guests" : "Publish to guests"} onClick={() => void togglePublished(event)}>
          {event.is_published ? <Eye size={17}/> : <EyeOff size={17}/>}
        </button>
        <button type="button" className="icon-button danger" aria-label="Remove event" onClick={() => void removeEvent(event)}><Trash2 size={17}/></button>
      </div>}
    </article>;
  }

  return <>
    <div className="page-title">
      <span className="eyebrow">THE CALENDAR</span>
      <h1>Parties, bashes, and tastings.</h1>
      <p>{admin ? "Publish an event and it shows up on every guest device." : `Join the list and ${keeperName} will send you the address and details.`}</p>
    </div>

    {error && <div className="ai-error load-error"><CircleAlert/><div><strong>Could not load events</strong><span>{error}</span></div><button className="secondary" onClick={load}>Retry</button></div>}

    {admin && <section className="settings-card event-composer">
      <span className="eyebrow">NEW EVENT</span>
      <h3>Add to the calendar</h3>
      <label><span>Title</span><input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Holiday bash"/></label>
      <label><span>Date</span><input type="date" value={draft.event_date} onChange={(e) => setDraft({ ...draft, event_date: e.target.value })}/></label>
      <label><span>Details</span><textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Doors at 7. Bring a bottle for the shelf."/></label>
      <label><span>Image URL</span><input value={draft.image_url} onChange={(e) => setDraft({ ...draft, image_url: e.target.value })} placeholder="Optional"/></label>
      <button type="button" className="primary" disabled={busy || !draft.title.trim() || !draft.event_date} onClick={() => void addEvent()}><Plus size={17}/> Publish event</button>
    </section>}

    {!events.length ? <div className="empty-state"><PartyPopper size={38}/><h3>Nothing on the calendar</h3><p>{admin ? "Add the first party." : "Check back soon, or join the invite list below."}</p></div> : <>
      {upcoming.length > 0 && <section>
        <div className="section-heading"><div><span className="eyebrow">COMING UP</span><h2>Next at the bar</h2></div></div>
        <div className="event-grid">{upcoming.map(eventCard)}</div>
      </section>}
      {past.length > 0 && <details className="archive-block">
        <summary>Past events ({past.length})</summary>
        <div className="event-grid">{past.map(eventCard)}</div>
      </details>}
    </>}

    {!admin && <section className="settings-card rsvp-card">
      <span className="eyebrow">PARTY LIST</span>
      <h3>Get the invite</h3>
      <p>We will text or email you the address and the plan for the next bash.</p>
      <label><span>Name</span><input value={rsvp.name} maxLength={MAX_PATRON_NAME} onChange={(e) => setRsvp({ ...rsvp, name: e.target.value })}/></label>
      <label><span>Phone or email</span><input value={rsvp.contact_info} maxLength={MAX_CONTACT_INFO} onChange={(e) => setRsvp({ ...rsvp, contact_info: e.target.value })}/></label>
      <label><span>Anything we should know?</span><textarea value={rsvp.notes} onChange={(e) => setRsvp({ ...rsvp, notes: e.target.value })} placeholder="Plus one, dietary notes, favorite pour…"/></label>
      <button type="button" className="primary" disabled={busy || !rsvp.name.trim() || !rsvp.contact_info.trim()} onClick={() => void subscribe()}>Add me to the list</button>
    </section>}

    {admin && subscribers.length > 0 && <section>
      <div className="section-heading"><div><span className="eyebrow">INVITE LIST</span><h2>{subscribers.length} on the list</h2></div></div>
      <ul className="subscriber-list">
        {subscribers.map((subscriber) => (
          <li key={subscriber.id}>
            <div><strong>{subscriber.name}</strong><small>{subscriber.contact_info}</small></div>
            {subscriber.notes ? <p>{subscriber.notes}</p> : null}
            <button type="button" className="icon-button danger" aria-label={`Remove ${subscriber.name}`} onClick={async () => {
              await api(`/event-subscribers/${subscriber.id}`, { method: "DELETE" }).catch(() => {});
              load();
            }}><Trash2 size={16}/></button>
          </li>
        ))}
      </ul>
    </section>}

    {notice && <div className="toast">{notice}</div>}
  </>;
}
