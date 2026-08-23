import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Mail, MailOpen, Trash2 } from "lucide-react";
import { api } from "./api";
import { type GuestMessage } from "./catalog";

function receivedLabel(raw: string) {
  const stamp = Date.parse(raw.replace(" ", "T") + "Z");
  if (!Number.isFinite(stamp)) return raw;
  const minutes = Math.floor((Date.now() - stamp) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes === 1) return "A minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(stamp).toLocaleString();
}

export function MessagesInbox({ onUnreadChange }: { onUnreadChange?: (unread: number) => void }) {
  const [messages, setMessages] = useState<GuestMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ messages: GuestMessage[]; unread: number }>("/messages")
      .then((data) => {
        setMessages(data.messages ?? []);
        setUnread(data.unread ?? 0);
        onUnreadChange?.(data.unread ?? 0);
        setError("");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the inbox."));
  }, [onUnreadChange]);
  useEffect(() => { load(); }, [load]);

  async function toggleRead(message: GuestMessage) {
    try {
      await api(`/messages/${message.id}/read`, { method: "PUT", body: JSON.stringify({ is_read: !message.is_read }) });
      load();
    } catch {
      setError("Could not update that message.");
    }
  }

  async function remove(message: GuestMessage) {
    if (!confirm(`Delete the message from ${message.sender_name}?`)) return;
    try {
      await api(`/messages/${message.id}`, { method: "DELETE" });
      load();
    } catch {
      setError("Could not delete that message.");
    }
  }

  return <>
    <div className="page-title">
      <span className="eyebrow">THE VAULT DOOR</span>
      <h1>Guest inquiries.</h1>
      <p>{unread ? `${unread} unread. Anything still unread after five minutes gets announced on Discord.` : "All caught up."}</p>
    </div>

    {error && <div className="ai-error load-error"><CircleAlert/><div><strong>Inbox trouble</strong><span>{error}</span></div><button className="secondary" onClick={load}>Retry</button></div>}

    {!messages.length ? <div className="empty-state"><Mail size={38}/><h3>No messages yet</h3><p>Guest questions from the footer contact form land here.</p></div> :
      <ul className="message-list">{messages.map((message) => (
        <li key={message.id} className={message.is_read ? "message-read" : "message-unread"}>
          <div className="message-head">
            <div>
              <strong>{message.sender_name}</strong>
              <small>{message.contact_info}</small>
            </div>
            <div className="message-meta">
              <span>{receivedLabel(message.created_at)}</span>
              {!message.is_read && message.discord_notified ? <span className="discord-flag">Announced on Discord</span> : null}
            </div>
          </div>
          <p>{message.body}</p>
          <div className="card-actions">
            <button type="button" className="icon-button" aria-label={message.is_read ? "Mark unread" : "Mark read"} onClick={() => void toggleRead(message)}>
              {message.is_read ? <Mail size={17}/> : <MailOpen size={17}/>}
            </button>
            <button type="button" className="icon-button danger" aria-label="Delete message" onClick={() => void remove(message)}><Trash2 size={17}/></button>
          </div>
        </li>
      ))}</ul>}
  </>;
}
