import { useMemo, useState } from "react";
import { CircleAlert, Copy, Download, Search, Trash2, Users } from "lucide-react";
import { api } from "./api";
import type { EventSubscriber } from "./catalog";
import {
  copySubscriberContacts,
  downloadSubscribersCsv,
  filterEventSubscribers,
  formatSubscriberJoined,
  subscriberContactHref
} from "./event-subscribers";

type Props = {
  subscribers: EventSubscriber[];
  loading: boolean;
  error: string;
  onRetry: () => void;
  onRemoved: (id: number) => void;
  onNotice: (message: string) => void;
};

export function EventSubscriberList({
  subscribers,
  loading,
  error,
  onRetry,
  onRemoved,
  onNotice
}: Props) {
  const [query, setQuery] = useState("");
  const [removingId, setRemovingId] = useState<number | null>(null);

  const filtered = useMemo(
    () => filterEventSubscribers(subscribers, query),
    [subscribers, query]
  );

  async function removeSubscriber(subscriber: EventSubscriber) {
    if (!confirm(`Remove “${subscriber.name}” from the invite list?`)) return;
    setRemovingId(subscriber.id);
    try {
      await api(`/event-subscribers/${subscriber.id}`, { method: "DELETE" });
      onRemoved(subscriber.id);
      onNotice(`Removed ${subscriber.name} from the invite list`);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Could not remove that person");
    } finally {
      setRemovingId(null);
    }
  }

  async function copyContacts() {
    if (!subscribers.length) {
      onNotice("Nobody on the invite list to copy yet");
      return;
    }
    const result = await copySubscriberContacts(subscribers);
    if (result === "copied") onNotice("Contacts copied");
    else onNotice("Could not copy contacts in this browser — try Export CSV instead");
  }

  function exportCsv() {
    if (!subscribers.length) {
      onNotice("Nobody on the invite list to export yet");
      return;
    }
    downloadSubscribersCsv(subscribers);
    onNotice("Invite list CSV downloaded");
  }

  return (
    <section className="subscriber-panel" aria-labelledby="invite-list-heading">
      <div className="section-heading">
        <div>
          <span className="eyebrow">INVITE LIST</span>
          <h2 id="invite-list-heading">
            {subscribers.length === 1
              ? "1 person on the list"
              : `${subscribers.length} people on the list`}
          </h2>
          <p className="subscriber-panel-lede">
            Guests who asked for party and event updates. Separate from inbox messages.
          </p>
        </div>
      </div>

      {error ? (
        <div className="ai-error load-error" role="alert">
          <CircleAlert/>
          <div>
            <strong>Could not load the invite list</strong>
            <span>{error}</span>
          </div>
          <button type="button" className="secondary" onClick={onRetry}>Retry</button>
        </div>
      ) : null}

      {loading && !subscribers.length && !error ? (
        <div className="empty-state subscriber-empty">
          <Users size={34}/>
          <h3>Loading the invite list…</h3>
        </div>
      ) : null}

      {!loading && !error && !subscribers.length ? (
        <div className="empty-state subscriber-empty">
          <Users size={34}/>
          <h3>Nobody has joined the invite list yet.</h3>
          <p>When a guest signs up from Events, they will show up here.</p>
        </div>
      ) : null}

      {subscribers.length > 0 ? (
        <>
          <div className="subscriber-toolbar">
            <label className="subscriber-search">
              <span className="sr-only">Search invite list</span>
              <Search size={16} aria-hidden="true"/>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, phone, email, or notes"
                autoComplete="off"
              />
            </label>
            <div className="subscriber-toolbar-actions">
              <button type="button" className="secondary" onClick={() => void copyContacts()}>
                <Copy size={16}/> Copy contacts
              </button>
              <button
                type="button"
                className="secondary"
                onClick={exportCsv}
                title="Downloads everyone on the invite list (not just the search results)"
              >
                <Download size={16}/> Export CSV
              </button>
            </div>
          </div>
          <p className="subscriber-export-hint">
            Search filters this view. Export CSV and Copy contacts use the full invite list.
          </p>

          {!filtered.length ? (
            <div className="empty-state subscriber-empty">
              <Search size={28}/>
              <h3>No matches</h3>
              <p>Try another name, phone, email, or note.</p>
            </div>
          ) : (
            <ul className="subscriber-list">
              {filtered.map((subscriber) => {
                const href = subscriberContactHref(subscriber.contact_info);
                return (
                  <li key={subscriber.id}>
                    <div className="subscriber-main">
                      <strong>{subscriber.name}</strong>
                      {href ? (
                        <a className="subscriber-contact" href={href}>{subscriber.contact_info}</a>
                      ) : (
                        <span className="subscriber-contact">{subscriber.contact_info}</span>
                      )}
                      <small className="subscriber-joined">
                        Joined {formatSubscriberJoined(subscriber.created_at)}
                      </small>
                      {subscriber.notes ? (
                        <p className="subscriber-notes">Notes: {subscriber.notes}</p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="secondary danger"
                      disabled={removingId === subscriber.id}
                      aria-label={`Remove ${subscriber.name} from the invite list`}
                      onClick={() => void removeSubscriber(subscriber)}
                    >
                      <Trash2 size={16}/> Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
