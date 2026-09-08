import { useEffect, useState } from "react";
import { ImageField } from "./ImageField";

export type EventEditorValues = {
  title: string;
  event_date: string;
  description: string;
  image_url: string;
  is_published: boolean;
};

export function emptyEventDraft(): EventEditorValues {
  return { title: "", event_date: "", description: "", image_url: "", is_published: true };
}

export function eventToEditorValues(event: {
  title: string;
  event_date: string;
  description: string;
  image_url: string;
  is_published: 0 | 1 | boolean;
}): EventEditorValues {
  return {
    title: event.title ?? "",
    event_date: (event.event_date ?? "").slice(0, 10),
    description: event.description ?? "",
    image_url: event.image_url ?? "",
    is_published: Boolean(event.is_published)
  };
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

  useEffect(() => {
    setDraft(initial);
  }, [initial.title, initial.event_date, initial.description, initial.image_url, initial.is_published]);

  const canSave = draft.title.trim().length > 0 && draft.event_date.trim().length > 0;

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
          onChange={(image_url) => setDraft({ ...draft, image_url })}
        />
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
    </section>
  );
}
