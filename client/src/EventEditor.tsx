import { useEffect, useState } from "react";
import { Crop } from "lucide-react";
import { ImageField } from "./ImageField";
import { EventImageAdjuster } from "./EventImageAdjuster";
import {
  DEFAULT_EVENT_IMAGE_FRAMING,
  normalizeEventImageFraming,
  type EventImageFraming
} from "./event-image-framing";

export type EventEditorValues = {
  title: string;
  event_date: string;
  description: string;
  image_url: string;
  image_focal_x: number;
  image_focal_y: number;
  image_zoom: number;
  is_published: boolean;
};

export function emptyEventDraft(): EventEditorValues {
  return {
    title: "",
    event_date: "",
    description: "",
    image_url: "",
    ...DEFAULT_EVENT_IMAGE_FRAMING,
    is_published: true
  };
}

export function eventToEditorValues(event: {
  title: string;
  event_date: string;
  description: string;
  image_url: string;
  image_focal_x?: number;
  image_focal_y?: number;
  image_zoom?: number;
  is_published: 0 | 1 | boolean;
}): EventEditorValues {
  const framing = normalizeEventImageFraming(event);
  return {
    title: event.title ?? "",
    event_date: (event.event_date ?? "").slice(0, 10),
    description: event.description ?? "",
    image_url: event.image_url ?? "",
    image_focal_x: framing.image_focal_x,
    image_focal_y: framing.image_focal_y,
    image_zoom: framing.image_zoom,
    is_published: Boolean(event.is_published)
  };
}

function framingFromDraft(draft: EventEditorValues): EventImageFraming {
  return normalizeEventImageFraming({
    image_focal_x: draft.image_focal_x,
    image_focal_y: draft.image_focal_y,
    image_zoom: draft.image_zoom
  });
}

export function EventEditor({
  mode,
  initial,
  busy = false,
  error = "",
  onCancel,
  onSave
}: {
  mode: "create" | "edit";
  initial: EventEditorValues;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onSave: (values: EventEditorValues) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<EventEditorValues>(initial);
  const [adjusting, setAdjusting] = useState(false);

  useEffect(() => {
    setDraft(initial);
    setAdjusting(false);
  }, [
    initial.title,
    initial.event_date,
    initial.description,
    initial.image_url,
    initial.image_focal_x,
    initial.image_focal_y,
    initial.image_zoom,
    initial.is_published
  ]);

  const canSave = draft.title.trim().length > 0 && draft.event_date.trim().length > 0;
  const framing = framingFromDraft(draft);

  function setImageUrl(image_url: string) {
    if (!image_url) {
      setDraft({
        ...draft,
        image_url: "",
        ...DEFAULT_EVENT_IMAGE_FRAMING
      });
      setAdjusting(false);
      return;
    }
    if (image_url !== draft.image_url) {
      // Replacing the photo clears stale crop settings from the previous image.
      setDraft({
        ...draft,
        image_url,
        ...DEFAULT_EVENT_IMAGE_FRAMING
      });
      return;
    }
    setDraft({ ...draft, image_url });
  }

  return (
    <section className="settings-card event-composer">
      <span className="eyebrow">{mode === "create" ? "NEW EVENT" : "EDIT EVENT"}</span>
      <h3>{mode === "create" ? "Add to the calendar" : "Edit event"}</h3>
      {error ? (
        <div className="ai-error load-error">
          <div><strong>Could not save</strong><span>{error}</span></div>
        </div>
      ) : null}
      <label>
        <span>Title</span>
        <input
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder="Holiday bash"
        />
      </label>
      <label>
        <span>Date</span>
        <input
          type="date"
          value={draft.event_date}
          onChange={(e) => setDraft({ ...draft, event_date: e.target.value })}
        />
      </label>
      <label>
        <span>Details</span>
        <textarea
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="Doors at 7. Bring a bottle for the shelf."
        />
      </label>
      <div className="field-block">
        <span>Image</span>
        <ImageField
          value={draft.image_url}
          onChange={setImageUrl}
        />
        {draft.image_url ? (
          <div className="event-image-framing-panel">
            <button
              type="button"
              className="secondary event-adjust-photo"
              disabled={busy}
              onClick={() => setAdjusting(true)}
            >
              <Crop size={17} /> Adjust photo
            </button>
            <p className="event-image-framing-hint">
              Reposition and zoom how this photo appears on cards and the event page. The original upload stays unchanged.
            </p>
          </div>
        ) : null}
      </div>
      <label className="event-publish-toggle">
        <input
          type="checkbox"
          checked={draft.is_published}
          onChange={(e) => setDraft({ ...draft, is_published: e.target.checked })}
        />
        <span>Published — show to guests</span>
      </label>
      <div className="event-editor-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !canSave}
          onClick={() => void onSave(draft)}
        >
          {mode === "create" ? "Save event" : "Save changes"}
        </button>
      </div>

      {adjusting && draft.image_url ? (
        <EventImageAdjuster
          imageUrl={draft.image_url}
          initial={framing}
          onCancel={() => setAdjusting(false)}
          onApply={(next) => {
            setDraft({
              ...draft,
              image_focal_x: next.image_focal_x,
              image_focal_y: next.image_focal_y,
              image_zoom: next.image_zoom
            });
            setAdjusting(false);
          }}
        />
      ) : null}
    </section>
  );
}
