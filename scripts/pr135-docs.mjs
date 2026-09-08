import { readFileSync, writeFileSync, rmSync } from "node:fs";

function replaceOnce(path, label, before, after) {
  let text = readFileSync(path, "utf8");
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`${path} ${label}: anchor not found`);
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`${path} ${label}: anchor is not unique`);
  text = text.replace(before, after);
  writeFileSync(path, text);
}

replaceOnce(
  "ROADMAP.md",
  "current state",
  "- PR #134 reorganized the App shell into phone bottom navigation and tablet/desktop left rail with a clear Guest/Keeper Operations partition, without changing page behavior or branding.\n",
  "- PR #134 reorganized the App shell into phone bottom navigation and tablet/desktop left rail with a clear Guest/Keeper Operations partition, without changing page behavior or branding.\n- PR #135 gives Taps and Spirits purpose-built collection cards with Guest-safe availability hierarchy and layered inline Keeper actions, while preserving BottleDetail and existing mutation semantics.\n"
);

replaceOnce(
  "ROADMAP.md",
  "completed foundation",
  "- PR134 — Responsive App Shell & Navigation Structure: phone bottom nav (≈4 primary + More, safe-area), landscape tablet/desktop left rail, Guest/Keeper Operations partition, dynamic tab visibility/order preserved; structure only (no branding).\n",
  "- PR134 — Responsive App Shell & Navigation Structure: phone bottom nav (≈4 primary + More, safe-area), landscape tablet/desktop left rail, Guest/Keeper Operations partition, dynamic tab visibility/order preserved; structure only (no branding).\n- PR135 — Taps & Spirits Card / Interaction Ergonomics: purpose-built Tap/Spirit collection cards, Guest-safe coarse availability, explicit Homebrew → Brewery Lab affordance, and inline Keeper pour/edit/stock/block/clear actions reusing existing inventory semantics.\n"
);

replaceOnce(
  "ROADMAP.md",
  "track c",
  "1. **Taps & Spirits card / interaction ergonomics** (next UX PR after shell structure)\n   - Improve Tap and Spirit card readability and interaction without redesigning branding.\n   - Preserve Guest availability gauges and Keeper-only operational quantities.\n2. **Brewery Lab follow-up only if live use proves a specific usability gap.**\n",
  "1. **PR136 — Cocktail cards + responsive Keeper workspace refinements** (next UX PR)\n   - Improve recipe-card readiness hierarchy, ingredient/missing-state scanning, and contextual Keeper actions.\n   - Refine tablet/landscape Keeper ergonomics without creating a separate admin application.\n2. **PR137 — Visual system / Smokey Barrel branding polish**\n   - Final typography, color, surface, and brand expression after interaction patterns are stable.\n   - Reconcile any useful direction from deferred draft PR121; keep Light/Dark as the supported appearance model.\n3. **Brewery Lab follow-up only if live use proves a specific usability gap.**\n"
);

replaceOnce(
  "ROADMAP.md",
  "relevant code",
  "- `client/src/shell-nav.ts` — pure shell navigation helpers (primary/More selection, Guest/Keeper partition, tab visibility/order).\n",
  "- `client/src/shell-nav.ts` — pure shell navigation helpers (primary/More selection, Guest/Keeper partition, tab visibility/order).\n- `client/src/TapSpiritInventoryCard.tsx` / `client/src/tap-spirit-card.css` — PR135 Tap/Spirit card hierarchy and layered Keeper controls; Guest availability stays on the coarse helper path.\n"
);

replaceOnce(
  ".spec/CURRENT_TASK.md",
  "current task",
  "PR134 complete — Responsive App Shell & Navigation Structure (phone bottom nav + More, landscape/desktop rail, Guest/Keeper Operations partition; helpers in `client/src/shell-nav.ts`).\n\nNext planned code work: **Taps & Spirits card / interaction ergonomics** (structure already landed; branding remains deferred).\n",
  "PR135 complete — Taps & Spirits Card / Interaction Ergonomics (Guest-safe card hierarchy plus layered Keeper controls; BottleDetail and existing mutation semantics preserved).\n\nNext planned code work: **PR136 — Cocktail cards + responsive Keeper workspace refinements**. Final visual/branding polish remains deferred to PR137.\n"
);

rmSync("scripts/pr135-docs.mjs", { force: true });
rmSync(".github/workflows/pr135-docs.yml", { force: true });
