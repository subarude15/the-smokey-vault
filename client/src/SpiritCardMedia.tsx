import { useState } from "react";
import { SbMark } from "./SbMark";

/** Prefer the server-derived display URL, then the stored Keeper image_url. */
export function spiritCardImageUrl(item: {
  display_image_url?: unknown;
  image_url?: unknown;
}): string {
  return String(item.display_image_url ?? item.image_url ?? "").trim();
}

function spiritMediaAlt(item: { name?: unknown; brand?: unknown }): string {
  const name = String(item.name ?? "").trim();
  if (name) return name;
  const brand = String(item.brand ?? "").trim();
  if (brand) return brand;
  return "Bottle";
}

/** Branded Bottle Library placeholder — same frame weight as a product photo, not a tiny Lucide icon. */
function SpiritMediaPlaceholder() {
  return (
    <div className="spirit-card-media-placeholder" aria-hidden="true">
      <svg
        className="spirit-card-media-silhouette"
        viewBox="0 0 48 72"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M18 8c0-2.2 1.8-4 4-4h4c2.2 0 4 1.8 4 4v6.5c0 1.5.6 2.9 1.7 3.9L36 27v37c0 2.2-1.8 4-4 4H16c-2.2 0-4-1.8-4-4V27l4.3-8.6c1.1-1 1.7-2.4 1.7-3.9V8Z"
          fill="currentColor"
          opacity="0.22"
        />
        <path
          d="M18 8c0-2.2 1.8-4 4-4h4c2.2 0 4 1.8 4 4v6.5c0 1.5.6 2.9 1.7 3.9L36 27v37c0 2.2-1.8 4-4 4H16c-2.2 0-4-1.8-4-4V27l4.3-8.6c1.1-1 1.7-2.4 1.7-3.9V8Z"
          stroke="currentColor"
          strokeWidth="1.5"
          opacity="0.55"
        />
        <path d="M20 4h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.45"/>
      </svg>
      <SbMark className="spirit-card-media-mark" size={26}/>
    </div>
  );
}

/**
 * Stable Bottle Library media frame (PR151).
 * valid image → product photo; missing or broken URL → same branded placeholder.
 * Never mutates stored image_url / display_image_url.
 */
export function SpiritCardMedia({
  item
}: {
  item: { display_image_url?: unknown; image_url?: unknown; name?: unknown; brand?: unknown };
}) {
  const src = spiritCardImageUrl(item);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const broken = Boolean(src) && failedSrc === src;
  const showImage = Boolean(src) && !broken;

  return (
    <div className={`domain-card-media spirit-card-media${showImage ? " has-image" : " is-placeholder"}`}>
      {showImage ? (
        <img
          src={src}
          alt={spiritMediaAlt(item)}
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <SpiritMediaPlaceholder/>
      )}
    </div>
  );
}
