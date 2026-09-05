import { useEffect, useState } from "react";
import { api } from "./api";
import { parseTastingProfile, type TastingProfile } from "./catalog";
import { ENRICHMENT_MODULES, textChild, type BottleEnrichmentView } from "./EnrichmentPanel";

/**
 * Guest-facing enriched content only — no provenance, confidence, jobs, or review UI.
 * Uses the existing enrichment read API but renders polished bottle-page tasting profiles.
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
      {official ? <TastingProfileView text={official} /> : null}
      {house ? <TastingProfileView text={house} /> : null}
      {showImage ? (
        <div className="bottle-public-image">
          <img src={displayUrl} alt="" />
        </div>
      ) : null}
    </div>
  );
}

/** Compact Aroma / Palate / Finish block for guest bottle detail. */
export function TastingProfileView({ text }: { text: string }) {
  const profile = parseTastingProfile(text);
  if (!hasTastingContent(profile)) return null;

  return (
    <article className="bottle-notes tasting-profile">
      <span className="eyebrow">TASTING PROFILE</span>
      {profile.aroma ? (
        <div className="tasting-profile-block">
          <span className="tasting-profile-label">Aroma</span>
          <p>{profile.aroma}</p>
        </div>
      ) : null}
      {profile.palate ? (
        <div className="tasting-profile-block">
          <span className="tasting-profile-label">Palate</span>
          <p>{profile.palate}</p>
        </div>
      ) : null}
      {profile.finish ? (
        <div className="tasting-profile-block">
          <span className="tasting-profile-label">Finish</span>
          <p>{profile.finish}</p>
        </div>
      ) : null}
      {!profile.aroma && !profile.palate && !profile.finish && profile.fallback ? (
        <p>{profile.fallback}</p>
      ) : null}
    </article>
  );
}

function hasTastingContent(profile: TastingProfile): boolean {
  return Boolean(profile.aroma || profile.palate || profile.finish || profile.fallback);
}
