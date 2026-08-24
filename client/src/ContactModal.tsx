import { useEffect, useState } from "react";
import { MapPin, Send, X } from "lucide-react";
import { api } from "./api";
import { DEFAULT_BAR_LOCATION_TEXT, MAX_CONTACT_INFO, MAX_MESSAGE_BODY, MAX_PATRON_NAME, type Patron } from "./catalog";

export function GuestFooter({ locationText, onContact }: { locationText: string; onContact: () => void }) {
  const location = locationText.trim() || DEFAULT_BAR_LOCATION_TEXT;
  return (
    <footer className="guest-footer">
      <button type="button" onClick={onContact}>
        <MapPin size={16}/>
        <span>{`\u{1F4CD} ${location} · Message us for full address & party details`}</span>
      </button>
    </footer>
  );
}

export function ContactModal({ close, keeperName }: { close: () => void; keeperName: string }) {
  const [names, setNames] = useState<string[]>([]);
  const [form, setForm] = useState({ sender_name: "", contact_info: "", body: "" });
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ patrons: Patron[] }>("/patrons")
      .then((data) => setNames((data.patrons ?? []).map((patron) => patron.name)))
      .catch(() => setNames([]));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/messages", { method: "POST", body: JSON.stringify(form) });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send that message");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Message sent">
      <section className="modal contact-modal">
        <header className="modal-header">
          <div><span className="eyebrow">MESSAGE SENT</span><h2>We got it.</h2></div>
          <button type="button" className="icon-button" onClick={close} aria-label="Close"><X/></button>
        </header>
        <p>{keeperName} will get back to you with the address and the details. If we take longer than five minutes, our Discord starts nagging us.</p>
        <footer className="modal-footer"><button type="button" className="primary" onClick={close}>Cheers</button></footer>
      </section>
    </div>;
  }

  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Message the bar">
    <form className="modal contact-modal" onSubmit={submit}>
      <header className="modal-header">
        <div><span className="eyebrow">FIND THE DOOR</span><h2>Message the bar</h2><p>Ask for the full address, party details, or anything else.</p></div>
        <button type="button" className="icon-button" onClick={close} aria-label="Close"><X/></button>
      </header>
      <label>
        <span>Your name</span>
        <input
          list="patron-names"
          autoComplete="off"
          value={form.sender_name}
          maxLength={MAX_PATRON_NAME}
          onChange={(event) => setForm({ ...form, sender_name: event.target.value })}
          placeholder="Regulars: start typing"
        />
        <datalist id="patron-names">{names.map((name) => <option key={name} value={name}/>)}</datalist>
      </label>
      <label>
        <span>Phone or email</span>
        <input
          value={form.contact_info}
          maxLength={MAX_CONTACT_INFO}
          onChange={(event) => setForm({ ...form, contact_info: event.target.value })}
          placeholder="So we can reply"
        />
      </label>
      <label>
        <span>Message</span>
        <textarea
          value={form.body}
          maxLength={MAX_MESSAGE_BODY}
          onChange={(event) => setForm({ ...form, body: event.target.value })}
          placeholder="Where exactly are you and what should I bring?"
        />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <footer className="modal-footer">
        <button type="button" className="secondary" onClick={close}>Cancel</button>
        <button className="primary" disabled={busy || !form.sender_name.trim() || !form.contact_info.trim() || !form.body.trim()}>
          <Send size={16}/> {busy ? "Sending…" : "Send message"}
        </button>
      </footer>
    </form>
  </div>;
}
