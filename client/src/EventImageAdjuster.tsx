import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  DEFAULT_EVENT_IMAGE_FRAMING,
  EVENT_IMAGE_ZOOM_MAX,
  EVENT_IMAGE_ZOOM_MIN,
  framingFromPointerDrag,
  normalizeEventImageFraming,
  nudgeEventFocal,
  type EventImageFraming
} from "./event-image-framing";
import { EventImageMedia } from "./EventImageMedia";

/**
 * Event-only photo positioning sheet. Draft-local: Done updates the editor draft;
 * Cancel discards adjuster-local changes. Does not persist until the event is saved.
 */
export function EventImageAdjuster({
  imageUrl,
  initial,
  onCancel,
  onApply
}: {
  imageUrl: string;
  initial: EventImageFraming;
  onCancel: () => void;
  onApply: (framing: EventImageFraming) => void;
}) {
  const [draft, setDraft] = useState(() => normalizeEventImageFraming(initial));
  const stageRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef(draft);
  const dragRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
  } | null>(null);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    const next = normalizeEventImageFraming(initial);
    setDraft(next);
    draftRef.current = next;
  }, [initial.image_focal_x, initial.image_focal_y, initial.image_zoom, imageUrl]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const next = framingFromPointerDrag(
      draftRef.current,
      event.clientX - drag.lastX,
      event.clientY - drag.lastY,
      rect.width,
      rect.height
    );
    dragRef.current = {
      pointerId: drag.pointerId,
      lastX: event.clientX,
      lastY: event.clientY
    };
    draftRef.current = next;
    setDraft(next);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer may already be released.
    }
  }

  return (
    <div
      className="modal-backdrop event-image-adjuster-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Adjust event photo"
    >
      <section className="modal event-image-adjuster">
        <header className="modal-header">
          <div>
            <span className="eyebrow">EVENT PHOTO</span>
            <h2>Adjust photo</h2>
            <p className="event-image-adjuster-hint">
              Drag to reposition. Use zoom or the nudge buttons for fine control.
            </p>
          </div>
          <button type="button" className="icon-button" aria-label="Close without saving framing" onClick={onCancel}>
            <X size={18} />
          </button>
        </header>

        <div
          ref={stageRef}
          className="event-image-adjuster-stage"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <EventImageMedia
            src={imageUrl}
            framing={draft}
            className="event-image-well event-image-adjuster-preview"
            alt=""
          />
        </div>

        <div className="event-image-adjuster-previews" aria-hidden="true">
          <div>
            <span>Card</span>
            <EventImageMedia
              src={imageUrl}
              framing={draft}
              className="event-image-well event-image-preview-card"
            />
          </div>
          <div>
            <span>Detail</span>
            <EventImageMedia
              src={imageUrl}
              framing={draft}
              className="event-image-well event-image-preview-detail"
            />
          </div>
        </div>

        <label className="event-image-zoom-control">
          <span>
            <ZoomOut size={16} aria-hidden="true" /> Zoom <ZoomIn size={16} aria-hidden="true" />
          </span>
          <input
            type="range"
            min={EVENT_IMAGE_ZOOM_MIN}
            max={EVENT_IMAGE_ZOOM_MAX}
            step={0.05}
            value={draft.image_zoom}
            aria-valuemin={EVENT_IMAGE_ZOOM_MIN}
            aria-valuemax={EVENT_IMAGE_ZOOM_MAX}
            aria-valuenow={draft.image_zoom}
            aria-label="Zoom"
            onChange={(e) =>
              setDraft(normalizeEventImageFraming({
                ...draft,
                image_zoom: Number(e.target.value)
              }))
            }
          />
        </label>

        <div className="event-image-nudge-row" role="group" aria-label="Reposition photo">
          <button
            type="button"
            className="secondary"
            onClick={() => setDraft(nudgeEventFocal(draft, "y", -5))}
          >
            Up
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setDraft(nudgeEventFocal(draft, "y", 5))}
          >
            Down
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setDraft(nudgeEventFocal(draft, "x", -5))}
          >
            Left
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setDraft(nudgeEventFocal(draft, "x", 5))}
          >
            Right
          </button>
        </div>

        <footer className="modal-footer event-image-adjuster-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => setDraft({ ...DEFAULT_EVENT_IMAGE_FRAMING })}
          >
            <RotateCcw size={16} /> Reset
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onApply(normalizeEventImageFraming(draft))}
          >
            <Check size={16} /> Done
          </button>
        </footer>
      </section>
    </div>
  );
}
