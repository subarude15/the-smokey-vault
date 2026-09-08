import type { CSSProperties } from "react";
import {
  eventImageFramingStyle,
  normalizeEventImageFraming,
  type EventImageFraming
} from "./event-image-framing";

/**
 * Shared event photo well for cards and detail. Applies Keeper framing via CSS
 * (object-position + scale) without altering the source file.
 */
export function EventImageMedia({
  src,
  framing,
  className = "event-image-well",
  alt = ""
}: {
  src: string;
  framing?: Partial<EventImageFraming> | null;
  className?: string;
  alt?: string;
}) {
  const style = eventImageFramingStyle(normalizeEventImageFraming(framing)) as CSSProperties;
  return (
    <div className={className}>
      <img src={src} alt={alt} style={style} draggable={false} />
    </div>
  );
}
