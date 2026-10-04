import { useState } from "react";
import { CheckCircle2, PartyPopper } from "lucide-react";
import { api } from "./api";
import {
  MAX_CONTACT_INFO,
  MAX_MESSAGE_BODY,
  MAX_PATRON_NAME,
  MAX_RSVP_PARTY_SIZE,
  type HouseEvent,
  type RsvpStatus
} from "./catalog";
import { isUpcomingEventDate } from "./event-date";
import { rsvpStatusLabel } from "./event-rsvps";

const STATUS_OPTIONS: Array<{ value: RsvpStatus; hint: string }> = [
  { value: "going", hint: "Count me in" },
  { value: "maybe", hint: "Hoping to make it" },
  { value: "declined", hint: "Can't make it" }
];

function successCopy(status: RsvpStatus, title: string): { heading: string; body: string } {
  switch (status) {
    case "going":
      return {
        heading: "You're on the list",
        body: `We'll look for you at ${title}.`
      };
    case "maybe":
      return {
        heading: "Maybe saved",
        body: `Thanks — we noted you as a maybe for ${title}.`
      };
    case "declined":
      return {
        heading: "Thanks for letting us know",
        body: `Sorry we'll miss you at ${title}.`
      };
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function EventRsvpForm({ event }: { event: HouseEvent }) {
  const published = Boolean(event.is_published);
  const upcoming = isUpcomingEventDate(event.event_date);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [status, setStatus] = useState<RsvpStatus>("going");
  const [partySize, setPartySize] = useState("1");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<RsvpStatus | null>(null);

  if (!published) return null;

  if (!upcoming) {
    return (
      <section className="settings-card rsvp-card event-rsvp-card" aria-labelledby="event-rsvp-heading">
        <span className="eyebrow">RSVP</span>
        <h3 id="event-rsvp-heading">This night has already passed</h3>
        <p>RSVPs are closed. You can still join the invite list on Events for future parties.</p>
      </section>
    );
  }

  if (done) {
    const copy = successCopy(done, event.title);
    return (
      <section className="settings-card rsvp-card event-rsvp-card event-rsvp-success" aria-live="polite">
        <span className="eyebrow">RSVP</span>
        <CheckCircle2 size={28} aria-hidden="true"/>
        <h3>{copy.heading}</h3>
        <p>{copy.body}</p>
        <p className="event-rsvp-success-status">{rsvpStatusLabel(done)}</p>
      </section>
    );
  }

  const declined = status === "declined";

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await api(`/events/${event.id}/rsvps`, {
        method: "POST",
        body: JSON.stringify({
          name,
          contact_info: contact,
          status,
          party_size: declined ? 0 : Number(partySize) || 1,
          notes
        })
      });
      setDone(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that RSVP");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card rsvp-card event-rsvp-card" aria-labelledby="event-rsvp-heading">
      <span className="eyebrow">RSVP</span>
      <h3 id="event-rsvp-heading">Are you coming?</h3>
      <p>Let Josh and Nick know for this night. Want updates on every party? Use Get the invite on the Events page.</p>

      <fieldset className="event-rsvp-status">
        <legend>Your reply</legend>
        {STATUS_OPTIONS.map((option) => (
          <label key={option.value} className={status === option.value ? "is-selected" : ""}>
            <input
              type="radio"
              name={`event-rsvp-status-${event.id}`}
              value={option.value}
              checked={status === option.value}
              onChange={() => {
                setStatus(option.value);
                if (option.value === "declined") setPartySize("0");
                else if (partySize === "0") setPartySize("1");
              }}
            />
            <span>
              <strong>{rsvpStatusLabel(option.value)}</strong>
              <small>{option.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>

      <label>
        <span>Name</span>
        <input
          value={name}
          maxLength={MAX_PATRON_NAME}
          autoComplete="name"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        <span>Phone or email <em>(optional)</em></span>
        <input
          value={contact}
          maxLength={MAX_CONTACT_INFO}
          autoComplete="off"
          onChange={(e) => setContact(e.target.value)}
        />
      </label>
      <label>
        <span>Total guests attending</span>
        <input
          type="number"
          min={declined ? 0 : 1}
          max={declined ? 0 : MAX_RSVP_PARTY_SIZE}
          step={1}
          disabled={declined}
          value={declined ? "0" : partySize}
          onChange={(e) => setPartySize(e.target.value)}
        />
      </label>
      <label>
        <span>Notes <em>(optional)</em></span>
        <textarea
          value={notes}
          maxLength={MAX_MESSAGE_BODY}
          placeholder="Dietary notes, plus-one name…"
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>

      {error ? <p className="event-rsvp-error" role="alert">{error}</p> : null}

      <button
        type="button"
        className="primary"
        disabled={busy || !name.trim()}
        onClick={() => void submit()}
      >
        <PartyPopper size={17}/> Send RSVP
      </button>
    </section>
  );
}
