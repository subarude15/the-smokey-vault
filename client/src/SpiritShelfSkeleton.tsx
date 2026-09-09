/** Lightweight Bottle Library loading skeleton (PR151). Hidden from assistive tech; parent exposes aria-busy. */
const SKELETON_COUNT = 6;

export function SpiritShelfSkeleton() {
  return (
    <div
      className="inventory-grid spirit-shelf-skeleton"
      aria-busy="true"
      aria-label="Loading the Bottle Library"
    >
      {Array.from({ length: SKELETON_COUNT }, (_, index) => (
        <div key={index} className="domain-card spirit-card is-skeleton" aria-hidden="true">
          <div className="domain-card-main">
            <div className="domain-card-media spirit-card-media is-placeholder"/>
            <div className="domain-card-copy spirit-skel-copy">
              <span className="spirit-skel-line short"/>
              <span className="spirit-skel-line"/>
              <span className="spirit-skel-line mid"/>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
