import { useEffect, useState } from "react";
import { api } from "./api";
import { ENRICHMENT_MODULES, textChild, type BottleEnrichmentView } from "./EnrichmentPanel";

/**
 * Patron-facing enriched content only — no provenance, confidence, jobs, or review UI.
 * Uses the existing enrichment read API but renders polished bottle-page notes.
 */
export function BottlePublicContent({
  table,
  itemId,
  hasPersonalNotes,
  hasShelfImage
}: {
  table: string;
  itemId: number;
  hasPersonalNotes: boolean;
  hasShelfImage: boolean;
}) {
  const [view, setView] = useState<BottleEnrichmentView | null>(null);

  useEffect(() => {
    if (!ENRICHMENT_MODULES.has(table) || !itemId) return;
    let cancelled = false;
    api<BottleEnrichmentView>(`/inventory/${table}/${itemId}/enrichment`)
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch(() => {
        if (!cancelled) setView(null);
      });
    return () => {
      cancelled = true;
    };
  }, [table, itemId]);

  if (!view) return null;

  const official = textChild(view.tastingNotes?.official).trim();
  const house = textChild(view.tastingNotes?.houseProfile).trim();
  const displayUrl = textChild(view.image?.displayUrl).trim();
  const showImage = Boolean(displayUrl) && !hasShelfImage && !view.image?.userPreferred;

  if (!official && !house && !showImage) return null;

  return (
    <div className="bottle-public-content">
      {official && !hasPersonalNotes ? (
        <article className="bottle-notes">
          <span className="eyebrow">TASTING NOTES</span>
          <p>{official}</p>
        </article>
      ) : null}
      {official && hasPersonalNotes ? (
        <article className="bottle-notes">
          <span className="eyebrow">PRODUCER NOTES</span>
          <p>{official}</p>
        </article>
      ) : null}
      {house ? (
        <article className="bottle-notes bottle-notes-house">
          <span className="eyebrow">HOUSE PROFILE</span>
          <p className="enrichment-ai-label">Generated house profile — not producer copy</p>
          <p>{house}</p>
        </article>
      ) : null}
      {showImage ? (
        <div className="bottle-public-image">
          <img src={displayUrl} alt="" />
        </div>
      ) : null}
    </div>
  );
}
