import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, CircleAlert, Eye, EyeOff, PartyPopper, Pencil, Plus, Share2, Trash2 } from "lucide-react";
import { api } from "./api";
import { MAX_CONTACT_INFO, MAX_PATRON_NAME, type EventSubscriber, type HouseEvent } from "./catalog";
import { EventDetail } from "./EventDetail";
import { emptyEventDraft, EventEditor, eventToEditorValues, type EventEditorValues } from "./EventEditor";
import { EventSubscriberList } from "./EventSubscriberList";
import {
  buildEventDeepLink,
  parseEventIdFromSearch,
  syncEventDeepLinkUrl
} from "./event-deep-link";
import { buildEventSharePayload, shareOrCopyEventLink } from "./event-share";

function eventDateLabel(raw: string) {
  const stamp = Date.parse(raw);
  if (!Number.isFinite(stamp)) return raw;
  return new Date(stamp).toLocaleDateString(undefined, {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

function isUpcoming(raw: string) {
  const stamp = Date.parse(raw);
  return !Number.isFinite(stamp) || stamp >= Date.now() - 86_400_000;
}

export function EventsPage({ admin, keeperName }: { admin: boolean; keeperName: string }) {
  const [events, setEvents] = useState<HouseEvent[]>([]);
  const [subscribers, setSubscribers] = useState<EventSubscriber[]>([]);
  const [subscriberLoading, setSubscriberLoading] = useState(false);
  const [subscriberError, setSubscriberError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rsvp, setRsvp] = useState({ name: "", contact_info: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(() =>
    parseEventIdFromSearch(typeof window !== "undefined" ? window.location.search : "")
  );
  const [selectedEvent, setSelectedEvent] = useState<HouseEvent | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [mode, setMode] = useState<"list" | "detail" | "create" | "edit">("list");
  const [editorError, setEditorError] = useState("");
  const [shareFallbackUrl, setShareFallbackUrl] = useState("");
  const [shareBusy, setShareBusy] = useState(false);

  useEffect(() => {
    // Guest signup toasts should not linger after unlocking Keeper Mode (and vice versa).
    setNotice("");
  }, [admin]);

  const loadSubscribers = useCallback(() => {
    if (!admin) {
      setSubscribers([]);
      setSubscriberLoading(false);
      setSubscriberError("");
      return;
    }
    setSubscriberLoading(true);
    setSubscriberError("");
    api<EventSubscriber[]>("/event-subscribers")
      .then((rows) => {
        setSubscribers(rows);
        setSubscriberError("");
      })
      .catch((err) => {
        setSubscribers([]);
        setSubscriberError(err instanceof Error ? err.message : "Could not load the invite list.");
      })
      .finally(() => setSubscriberLoading(false));
  }, [admin]);

  const load = useCallback(() => {
    api<HouseEvent[]>("/events")
      .then((rows) => { setEvents(rows); setError(""); })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load events."));
    loadSubscribers();
  }, [loadSubscribers]);

  useEffect(() => { load(); }, [load]);

  const openDetail = useCallback((eventId: number, historyMode: "replace" | "push" = "push") => {
    setSelectedId(eventId);
    setMode("detail");
    setShareFallbackUrl("");
    setEditorError("");
    syncEventDeepLinkUrl(window.location, window.history, eventId, historyMode);
  }, []);

  const closeDetail = useCallback((historyMode: "replace" | "push" = "replace") => {
    setSelectedId(null);
    setSelectedEvent(null);
    setDetailError("");
    setMode("list");
    setShareFallbackUrl("");
    setEditorError("");
    syncEventDeepLinkUrl(window.location, window.history, null, historyMode);
  }, []);

  // Open deep-linked event on first paint / when URL already carries ?event=
  useEffect(() => {
    const fromUrl = parseEventIdFromSearch(window.location.search);
    if (fromUrl == null) return;
    setSelectedId(fromUrl);
    setMode("detail");
  }, []);

  // Load the focused event (guest-safe GET; Keeper may see drafts)
  useEffect(() => {
    if (selectedId == null || (mode !== "detail" && mode !== "edit")) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError("");
    api<HouseEvent>(`/events/${selectedId}`)
      .then((event) => {
        if (cancelled) return;
        setSelectedEvent(event);
        setEvents((current) => {
          const idx = current.findIndex((row) => row.id === event.id);
          if (idx < 0) return current;
          const next = current.slice();
          next[idx] = event;
          return next;
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setSelectedEvent(null);
        setDetailError(err instanceof Error ? err.message : "Event not found");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedId, mode, admin]);

  // Browser Back from a deep link should return to the Events list
  useEffect(() => {
    function onPopState() {
      const fromUrl = parseEventIdFromSearch(window.location.search);
      if (fromUrl == null) {
        setSelectedId(null);
        setSelectedEvent(null);
        setMode("list");
        setShareFallbackUrl("");
        return;
      }
      setSelectedId(fromUrl);
      setMode("detail");
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const editingInitial = useMemo(() => {
    if (mode === "edit" && selectedEvent) return eventToEditorValues(selectedEvent);
    return emptyEventDraft();
  }, [mode, selectedEvent]);

  async function saveCreate(values: EventEditorValues) {
    setBusy(true);
    setEditorError("");
    try {
      const created = await api<HouseEvent>("/events", {
        method: "POST",
        body: JSON.stringify({
          title: values.title,
          event_date: values.event_date,
          description: values.description,
          image_url: values.image_url,
          is_published: values.is_published ? 1 : 0
        })
      });
      setNotice("Event added");
      load();
      openDetail(created.id, "replace");
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : "Could not save that event");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(values: EventEditorValues) {
    if (!selectedEvent) return;
    setBusy(true);
    setEditorError("");
    try {
      const updated = await api<HouseEvent>(`/events/${selectedEvent.id}`, {
        method: "PUT",
        body: JSON.stringify({
          title: values.title,
          event_date: values.event_date,
          description: values.description,
          image_url: values.image_url,
          is_published: values.is_published ? 1 : 0
        })
      });
      setSelectedEvent(updated);
      setNotice("Event updated");
      load();
      setMode("detail");
      setShareFallbackUrl("");
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : "Could not update that event");
    } finally {
      setBusy(false);
    }
  }

  async function togglePublished(event: HouseEvent) {
    try {
      await api(`/events/${event.id}`, {
        method: "PUT",
        body: JSON.stringify({ is_published: event.is_published ? 0 : 1 })
      });
      load();
      if (selectedId === event.id) {
        const next = await api<HouseEvent>(`/events/${event.id}`).catch(() => null);
        if (next) setSelectedEvent(next);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not update that event");
    }
  }

  async function removeEvent(event: HouseEvent) {
    if (!confirm(`Remove “${event.title}”?`)) return;
    try {
      await api(`/events/${event.id}`, { method: "DELETE" });
      if (selectedId === event.id) closeDetail();
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not remove that event");
    }
  }

  function eventShareUrl(eventId: number) {
    return buildEventDeepLink(window.location.origin, window.location.pathname || "/", eventId);
  }

  async function shareEvent(event: HouseEvent, preferCopy = false) {
    if (!event.is_published) {
      setNotice("Publish this event before sharing a guest link");
      return;
    }
    setShareBusy(true);
    setShareFallbackUrl("");
    const url = eventShareUrl(event.id);
    const payload = buildEventSharePayload(event, url);
    try {
      if (preferCopy) {
        const result = await shareOrCopyEventLink(payload, {
          canShare: false,
          share: undefined
        });
        if (result === "copied") setNotice("Link copied");
        else {
          setShareFallbackUrl(url);
          setNotice("Copy the link below");
        }
        return;
      }
      const result = await shareOrCopyEventLink(payload);
      if (result === "shared") setNotice("Shared");
      else if (result === "copied") setNotice("Link copied");
      else if (result === "fallback") {
        setShareFallbackUrl(url);
        setNotice("Copy the link below");
      }
    } finally {
      setShareBusy(false);
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
    return (
      <article
        className={`event-card${event.is_published ? "" : " event-unpublished"}`}
        key={event.id}
      >
        <button type="button" className="event-card-open" onClick={() => openDetail(event.id)}>
          {event.image_url ? <img src={event.image_url} alt=""/> : null}
          <div>
            <span className="eyebrow"><CalendarDays size={14}/> {eventDateLabel(event.event_date)}</span>
            <h3>{event.title}</h3>
            {event.description ? <p>{event.description}</p> : null}
          </div>
        </button>
        <div className="card-actions">
          {event.is_published ? (
            <button
              type="button"
              className="icon-button"
              aria-label="Share event"
              onClick={() => void shareEvent(event)}
            >
              <Share2 size={17}/>
            </button>
          ) : null}
          {admin ? (
            <>
              <button
                type="button"
                className="icon-button"
                aria-label="Edit event"
                onClick={() => {
                  openDetail(event.id, "replace");
                  setMode("edit");
                }}
              >
                <Pencil size={17}/>
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={event.is_published ? "Hide from guests" : "Publish to guests"}
                onClick={() => void togglePublished(event)}
              >
                {event.is_published ? <Eye size={17}/> : <EyeOff size={17}/>}
              </button>
              <button
                type="button"
                className="icon-button danger"
                aria-label="Remove event"
                onClick={() => void removeEvent(event)}
              >
                <Trash2 size={17}/>
              </button>
            </>
          ) : null}
        </div>
      </article>
    );
  }

  if (mode === "create" && admin) {
    return (
      <>
        <EventEditor
          mode="create"
          initial={emptyEventDraft()}
          busy={busy}
          error={editorError}
          onCancel={() => { setMode("list"); setEditorError(""); }}
          onSave={saveCreate}
        />
        {notice && <div className="toast">{notice}</div>}
      </>
    );
  }

  if ((mode === "detail" || mode === "edit") && selectedId != null) {
    if (mode === "edit" && admin && selectedEvent) {
      return (
        <>
          <EventEditor
            mode="edit"
            initial={editingInitial}
            busy={busy}
            error={editorError}
            onCancel={() => { setMode("detail"); setEditorError(""); }}
            onSave={saveEdit}
          />
          {notice && <div className="toast">{notice}</div>}
        </>
      );
    }

    if (detailLoading && !selectedEvent) {
      return <div className="empty-state"><PartyPopper size={38}/><h3>Loading event…</h3></div>;
    }

    if (detailError || !selectedEvent) {
      return (
        <section className="event-detail">
          <button type="button" className="secondary back-button" onClick={() => closeDetail()}>
            Back to events
          </button>
          <div className="ai-error load-error">
            <CircleAlert/>
            <div>
              <strong>Event not found</strong>
              <span>{detailError || "That event is unavailable."}</span>
            </div>
          </div>
        </section>
      );
    }

    return (
      <>
        <EventDetail
          event={selectedEvent}
          admin={admin}
          shareBusy={shareBusy}
          fallbackUrl={shareFallbackUrl}
          onBack={() => closeDetail()}
          onEdit={admin ? () => { setMode("edit"); setEditorError(""); } : undefined}
          onShare={() => void shareEvent(selectedEvent)}
          onCopyLink={() => void shareEvent(selectedEvent, true)}
        />
        {notice && <div className="toast">{notice}</div>}
      </>
    );
  }

  return <>
    <div className="page-title">
      <span className="eyebrow">THE CALENDAR</span>
      <h1>Parties, bashes, and tastings.</h1>
      <p>
        {admin
          ? "Publish an event and it shows up on every guest device."
          : `Join the list and ${keeperName} will send you the address and details.`}
      </p>
    </div>

    {error && (
      <div className="ai-error load-error">
        <CircleAlert/>
        <div><strong>Could not load events</strong><span>{error}</span></div>
        <button className="secondary" onClick={load}>Retry</button>
      </div>
    )}

    {admin && (
      <div className="toolbar">
        <button type="button" className="primary" onClick={() => { setMode("create"); setEditorError(""); }}>
          <Plus size={17}/> Add event
        </button>
      </div>
    )}

    {!events.length ? (
      <div className="empty-state">
        <PartyPopper size={38}/>
        <h3>Nothing on the calendar</h3>
        <p>{admin ? "Add the first party." : "Check back soon, or join the invite list below."}</p>
      </div>
    ) : (
      <>
        {upcoming.length > 0 && (
          <section>
            <div className="section-heading">
              <div><span className="eyebrow">COMING UP</span><h2>Next at the bar</h2></div>
            </div>
            <div className="event-grid">{upcoming.map(eventCard)}</div>
          </section>
        )}
        {past.length > 0 && (
          <details className="archive-block">
            <summary>Past events ({past.length})</summary>
            <div className="event-grid">{past.map(eventCard)}</div>
          </details>
        )}
      </>
    )}

    {!admin && (
      <section className="settings-card rsvp-card">
        <span className="eyebrow">PARTY LIST</span>
        <h3>Get the invite</h3>
        <p>We will text or email you the address and the plan for the next bash.</p>
        <label>
          <span>Name</span>
          <input
            value={rsvp.name}
            maxLength={MAX_PATRON_NAME}
            onChange={(e) => setRsvp({ ...rsvp, name: e.target.value })}
          />
        </label>
        <label>
          <span>Phone or email</span>
          <input
            value={rsvp.contact_info}
            maxLength={MAX_CONTACT_INFO}
            onChange={(e) => setRsvp({ ...rsvp, contact_info: e.target.value })}
          />
        </label>
        <label>
          <span>Anything we should know?</span>
          <textarea
            value={rsvp.notes}
            onChange={(e) => setRsvp({ ...rsvp, notes: e.target.value })}
            placeholder="Plus one, dietary notes, favorite pour…"
          />
        </label>
        <button
          type="button"
          className="primary"
          disabled={busy || !rsvp.name.trim() || !rsvp.contact_info.trim()}
          onClick={() => void subscribe()}
        >
          Add me to the list
        </button>
      </section>
    )}

    {admin ? (
      <EventSubscriberList
        subscribers={subscribers}
        loading={subscriberLoading}
        error={subscriberError}
        onRetry={loadSubscribers}
        onRemoved={(id) => setSubscribers((rows) => rows.filter((row) => row.id !== id))}
        onNotice={setNotice}
      />
    ) : null}

    {notice && <div className="toast">{notice}</div>}
  </>;
}
