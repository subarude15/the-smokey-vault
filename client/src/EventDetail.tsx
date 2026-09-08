import { ArrowLeft, CalendarDays, Copy, Link2, Pencil, Share2 } from "lucide-react";
import type { HouseEvent } from "./catalog";

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

export function EventDetail({
  event,
  admin,
  shareBusy = false,
  fallbackUrl = "",
  onBack,
  onEdit,
  onShare,
  onCopyLink
}: {
  event: HouseEvent;
  admin: boolean;
  shareBusy?: boolean;
  fallbackUrl?: string;
  onBack: () => void;
  onEdit?: () => void;
  onShare: () => void;
  onCopyLink: () => void;
}) {
  const published = Boolean(event.is_published);

  return (
    <section className="event-detail">
      <button type="button" className="secondary back-button" onClick={onBack}>
        <ArrowLeft size={16}/> Back to events
      </button>

      <div className="event-detail-hero">
        {event.image_url ? (
          <div className="event-detail-image">
            <img src={event.image_url} alt=""/>
          </div>
        ) : null}
        <div>
          <span className="eyebrow">
            <CalendarDays size={14}/> {eventDateLabel(event.event_date)}
          </span>
          <h1>{event.title}</h1>
          {!published ? <p className="event-draft-badge">Draft — not visible to guests</p> : null}
          {event.description ? <p className="event-detail-body">{event.description}</p> : null}

          <div className="event-detail-actions">
            {published ? (
              <>
                <button type="button" className="primary" disabled={shareBusy} onClick={onShare}>
                  <Share2 size={17}/> Share
                </button>
                <button type="button" className="secondary" disabled={shareBusy} onClick={onCopyLink}>
                  <Copy size={17}/> Copy link
                </button>
              </>
            ) : (
              <button type="button" className="secondary" disabled title="Publish this event to share a guest link">
                <Link2 size={17}/> Share unavailable
              </button>
            )}
            {admin && onEdit ? (
              <button type="button" className="secondary" onClick={onEdit}>
                <Pencil size={17}/> Edit event
              </button>
            ) : null}
          </div>

          {fallbackUrl ? (
            <label className="event-share-fallback">
              <span>Link</span>
              <input readOnly value={fallbackUrl} onFocus={(e) => e.currentTarget.select()}/>
            </label>
          ) : null}
        </div>
      </div>
    </section>
  );
}
