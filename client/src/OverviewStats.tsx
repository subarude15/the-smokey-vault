import { Beer, BottleWine as Bottle, ChevronRight, FlaskConical, Grape, Wine } from "lucide-react";
import type { ComponentType } from "react";
import type { OverviewSnapshot } from "./catalog";
import { overviewStatDefs, OVERVIEW_STAT_COUNT } from "./overview-stats";

/**
 * At-a-glance Overview stat grid (PR150). Number-first cards driven entirely by
 * the shared Overview snapshot — it never fetches its own data and never invents
 * zero counts. States:
 *  - loading (no snapshot yet, no error): neutral skeleton, no numbers.
 *  - error (no snapshot, not loading): renders nothing so the caller's error
 *    banner is the only signal — a failed load never masquerades as zeroes.
 *  - loaded: real values, including genuine zeroes.
 */
const STAT_ICONS: Record<string, ComponentType<{ size?: number }>> = {
  spirits: Bottle,
  taps: Beer,
  brewery: FlaskConical,
  packaged_beer: Beer,
  wines: Grape,
  cocktails: Wine
};

export function OverviewStats({
  snapshot,
  admin,
  loading,
  onNavigate
}: {
  snapshot: OverviewSnapshot | undefined;
  admin: boolean;
  loading: boolean;
  onNavigate: (page: string) => void;
}) {
  const gridClass = `stat-grid${admin ? "" : " guest-stats"}`;

  if (!snapshot) {
    if (!loading) return null;
    return (
      <div className={gridClass} aria-busy="true" aria-label="Loading the bar snapshot">
        {Array.from({ length: OVERVIEW_STAT_COUNT }, (_, i) => (
          <div key={i} className="stat-card is-skeleton" aria-hidden="true">
            <span className="stat-skeleton-value"/>
            <span className="stat-skeleton-label"/>
          </div>
        ))}
      </div>
    );
  }

  const defs = overviewStatDefs(snapshot, admin);
  return (
    <div className={gridClass}>
      {defs.map((stat) => {
        const Icon = STAT_ICONS[stat.id] ?? Wine;
        return (
          <button
            className="stat-card"
            key={stat.id}
            onClick={() => onNavigate(stat.id)}
            aria-label={`${stat.value} ${stat.label} — ${stat.hint}`}
          >
            <Icon/>
            <span>{stat.value}</span>
            <small>{stat.label}</small>
            <b className="stat-hint">{stat.hint}</b>
            <ChevronRight/>
          </button>
        );
      })}
    </div>
  );
}
