# Angel's Share — a new theme for the basement floor

**Design read:** a private, phone-first bar menu for guests standing at the foot of the stairs, in a dim room,
holding a drink in one hand. Not a marketing site. Availability is the product; everything else is chrome.

> *Angel's share*: the part of a barrel that evaporates while it ages. The whole theme is about what is
> **left in the barrel** — so the interface leads with level, count, and pourability instead of prose.

---

## 1. What I designed against

1. **95% phones, more so than iPads.** Touch targets, thumb reach, no hover dependency, no iOS focus-zoom.
2. **"What does the bar have right now?"** — availability, at a glance, without asking Nick.
3. **"Easily find drinks."** — the shortest path from a mood/ingredient to a recipe the shelf can actually make.

## 2. Audit of the current build (what was already good, what cost the guest)

Held onto, deliberately:

- The warm speakeasy identity, the `themePresets` token layer, and the fact that **theme is tokens, not forks**.
- Guest tab switches (`enabledTabs`) — the design has to respect a keeper turning a room off.
- The compact-nav model: 3 quick tabs + More sheet, safe-area aware, already solved for portrait/landscape.
- Real availability data: `fill_level`, `remaining_l`, `readiness` (ready / almost / missing) already exist server-side.

Where the guest lost time:

| Problem | Where | Cost |
| --- | --- | --- |
| A marketing hero (wordmark + orbit dial + lede) owns the first screenful | `Dashboard` | The one screen guests open most answers "what's the vibe", not "what's in the glass" |
| Fill levels, keg percentages and pints-remaining are gated behind `admin &&` | `Inventory` cards, `Dashboard` tap rail, `BottleDetail` | Guests literally cannot see how much is left — the core question of the app |
| "Off the menu" is a sideways card rail with no filter at the top | `Dashboard` → `Cocktails` | Two taps + a scroll to get from "tonight" to "mine" |
| Cocktail filters are four `<select>`s at 40px, in a row that wraps | `filter-row` | Fiddly on a phone, invisible in a bright room |
| Every surface uses the same serif at the same weight | `styles.css` | Hierarchy is carried by size alone, so a list of bottles reads flat |
| `min-height:42px` controls, `font-size` inherited into inputs | forms | Under the 44px floor, and iOS zooms the page when a text input focuses under 16px |

## 3. The idea

**Availability is the interface.** One warm lamp over charred oak, and three rules:

1. **Names in a label serif, facts in mono.** Fraunces (soft + wonk axes on) for anything you *read*; IBM Plex
   Mono for anything you *check* — ABV, pints, tags, statuses, counts. Two voices, no ambiguity about which
   one is data.
2. **Everything that can run out gets a gauge.** A brass dipstick in a notched trough: bottle fill, keg
   remaining, wine bottle count, substitute availability. Same component everywhere, so one glance pattern
   serves every shelf. **Guests see it too** — that is the entire point of the app.
3. **Brass means available, ember means running short.** Two accents. Red stays reserved for destructive
   actions, so the room never turns into a traffic light.

### Guest home, before → after

```
 BEFORE                                  AFTER  (Angel's Share)
 ┌──────────────────────┐                ┌──────────────────────┐
 │        ⌄ More        │                │ ● Tonight     ⚙  ☾  │  lit dot = the bar is open
 ├──────────────────────┤                ├──────────────────────┤
 │ GOOD MORNING · PATRON│                │ The Smokey Barrel    │   ⬤ 88
 │   The Smokey Barrel  │                │ Pull up a stool.     │   bottles on the shelf
 │  Pull up a stool.    │                ├──────────────────────┤
 │        ( 88 )        │                │ [ Find a drink     ] │  56px brass cap, one thumb
 │   lede paragraph…    │                │ [ Ask mixologist   ] │
 ├──────────────────────┤                │ [ Browse the shelf   ] │
 │ 6 stat cards, 2 rows │                ├──────────────────────┤
 ├──────────────────────┤                │ POURING RIGHT NOW →   │
 │ What's pouring       │                │ ┌────┐┌────┐┌────┐   │  every handle, with keg level
 │ tap cards (no level) │                │ │TAP1││TAP2││TAP3│   │  + pints left, for guests
 │                      │                │ │▓▓▓▓││▓▓░░││ OPEN │  │
 ├──────────────────────┤                │ └────┘└────┘└────┘   │
 │ Off the menu         │                │ AT A GLANCE →         │  swipe rail, not a grid
 │ Off the menu         │                │ ┌────┬────┬────┐     │
 │ Off the menu         │                └─┴────┴────┴────┴─────┘
 ├──────────────────────┤
 │ In the pipeline      │                [ Home | On Tap | Drinks | More ]  floating rail
 └──────────────────────┘
```

## 4. Design system

### Color (tokens in `themePresets.angels`, `client/src/App.tsx`)

| Token | Value | Role | Measured contrast |
| --- | --- | --- | --- |
| `--bg` | `#121311` | the room (ash-charcoal, slightly cool so it reads *smoke*, not *brown*) | — |
| `--surface` | `#191b19` | card plate | text `#edeae0` **14.4:1** |
| `--surface-2` | `#222522` | wells, inputs | — |
| `--text` | `#edeae0` | label paper | **6.7:1** on `--muted` pairings |
| `--muted` | `#9da398` | secondary copy | **7.2:1** on `--bg` |
| `--line` | `#3a3f39` | hairlines, card edges | lifted ~10% vs. the old theme so cards separate at arm's length in the dark |
| `--accent` | `#c6a15b` | aged brass — primary actions, gauges, active states | ink `#181508` on brass **7.5:1** (worst stop of the gradient **5.6:1**) |
| `--accent-2` | `#e3c686` | lit brass — labels, active text | **11.4:1** on `--surface` |
| `--brass-deep` | `#7d6023` | gauge trough shadow, gradient end | — |
| `--ember` | `#c9713a` | running short: `almost` readiness, low fill, badges | `#eab88e` on surface **9.7:1** |
| `--char` | `#0c0d0b` | bottle plates, gauge troughs | — |

Derived tokens (`client/src/theme-angels.css`): `--rule` (brass-flecked hairline for section edges), `--plate` /
`--plate-lit` (the lit-from-above card face), `--edge` (1px top highlight), `--lift` (one shadow, used everywhere).

### Type

| Use | Face | Specs |
| --- | --- | --- |
| Names, headings, big counts | Fraunces (`--display`) | 500, `font-variation-settings:"SOFT" 45,"WONK" 1`, tracking −.015em, `text-wrap:balance` |
| UI copy, notes, buttons | Instrument Sans (`--body`) | 15.5px base, 16px inside text inputs |
| Facts: eyebrow, meta chips, statuses, gauge labels | IBM Plex Mono (`--mono`) | 9–11.5px, `.08–.17em` tracking, uppercase, tabular figures |
| Page title / wordmark | Fraunces | `clamp(30px,7vw,44px)` / `clamp(29px,7.6vw,46px)` |
| Section heading | Fraunces | `clamp(20px,5.4vw,26px)` on a brass rule |

Both families are variable and loaded once from Google Fonts; if the network is down the stack falls back to
Playfair/Outfit already in the app, so nothing reflows badly.

### Radius, edge, depth

`--radius:12px` cards · `--radius-sm:9px` controls · `--radius-pill:999px` chips/gauges · one shadow recipe
(`--edge` inset highlight + `--lift`), no glassmorphism except the two floating chrome plates (topbar, dock).
Cards carry a **brass spine** (`border-left:2px`) that turns ember when a bottle is empty or blocked — a
second, non-color-dependent signal is the fill gauge right below it.

### Motion (intensity: dimmer, not disco)

- `angels-rise` 0.34–0.5s on section/card entry, staggered 40ms, only the first 6 cards animate.
- Gauge `width` transitions 0.6s `--ease-out` — after a pour, the level visibly drains.
- Press feedback: `translateY(1px) scale(.99)`; dock icons lift 2px.
- One living element per screen: the "bar is open" dot breathes at 3.6s.
- `prefers-reduced-motion: reduce` kills all animation and transitions; `prefers-contrast: more`
  lifts `--line`, `--muted`, `--brass`.

## 5. The availability model

| Surface | What a guest now sees | Source |
| --- | --- | --- |
| Bottle card (spirits) | fill gauge + `Full / ¾ / Half / ¼` | `nearestFillStop(fill_level)` |
| Tap card (home rail + On Tap) | keg gauge + `N pints left` | `remaining_l` → `pintsRemaining` |
| Bottle detail | one brass **availability line**: `POURING NOW · 13 pints left · ¾` / `ON THE SHELF · Half` | read-only; no keeper controls exposed |
| Tonight board | 6-glance swipe rail (pouring / off the menu / on the shelf / cellar / brewing / cold room) | existing `/overview` snapshot, no new endpoint |

Keeper-only data stays keeper-only: stock counts, UPCs, prices, restock list, enrichment plumbing.
The three lines that changed are the `admin &&` gates on the fill/keg gauges and the tap rail, so if you want
levels to stay behind the stick, revert those and nothing else moves.

## 6. Finding a drink

- **One obvious next step** above the fold on the guest home: `Find a drink` (brass cap), plus
  `Ask the mixologist` only when `aiConfigured`, plus `Browse the shelf` only when the cellar tab is on.
- On the recipe index, the toolbar (Off the menu / Missing one / All) and the search field **stick under the
  top bar** while the list scrolls — the tool never leaves the thumb.
- Filters become 42px pill chips (mono, uppercase); the four `<select>`s scroll sideways instead of wrapping,
  so a filter is always one tap and never a tiny target.
- Ingredient lists carry a dot per line: filled brass = shelf has it, hollow ember = missing, half-filled =
  pantry. Color is never the only signal, so it survives sunlight, color-blindness, and a black-and-white print.
- `Surprise me` is the loudest button on the page and only enabled when something is actually ready.

## 7. Mobile ergonomics

- Dock becomes a floating **bar rail**: inset 8px, 56px targets, mono labels, an active tab lit with a brass
  underline; the page gets 104px of bottom padding so nothing hides under it; safe-area respected on both sides.
- More-sheet lifts above the rail, gets a brass drag handle, 50px rows, hairline separators.
- Inputs are 46px tall at 16px type (no iOS zoom-on-focus); textareas 15px; buttons 44–56px.
- `.page` padding drops to 15px side / 16px top on ≤700px, and the guest home to 16px top: less gutter, more shelf.
- One-column card list on phones; the multi-column grid returns at ≥701px for iPads, in both orientations.
- Horizontal rails hide their scrollbars and use `scroll-snap-type:x proximity` with `overscroll-behavior-x:contain`,
  so a swipe inside a rail never fights the page.

## 8. Implementation notes

| File | Change |
| --- | --- |
| `client/src/theme-angels.css` *(new, ~860 lines)* | The whole theme: derived tokens, type, chrome, dock, sheet, gauges, cards, chips, forms, unlock pad, responsive + a11y blocks |
| `client/src/App.tsx` | 5 surgical edits: `themePresets.angels`; `?theme=` override in `storedTheme()`; `cycleTheme`/`themeLabel`; `data-page`/`data-mode` on `.app-shell`; guest availability (2 gauge gates, 1 tap rail gate, 1 read-only detail line, 1 `tonight-cta` block) |
| `client/src/styles.css` | Base rules for `.tonight-cta` only — so the CTA works in every theme |
| `client/src/main.tsx` | Import the theme layer after `styles.css` |
| `client/index.html` | Two font families + a preconnect |
| `client/vite.config.ts` | `server.allowedHosts` so a proxied/tunneled dev server (phone testing) isn't blocked |

Deliberate constraints:

- **Scoped, never invasive.** Every rule is `html[data-theme="angels"] …` (guest layout additionally
  `[data-mode="guest"]`), so Light/Dark/Punk render exactly as before. No `!important`, no new dependencies,
  no new endpoints, no schema change.
- **Layout via attributes, not forks.** `data-page` + `data-mode` let CSS scope the Tonight board, sticky
  toolbars, and rail behavior to the surfaces that need them — the alternative was a parallel guest component,
  which is the thing that rots.
- Verified: `npm run build:client` ✓ · `npm test` 894 pass / 0 fail ✓ · every guest screen mounted in a DOM
  harness and **129 of 199 theme selectors matched live** (the rest are keeper/modal-only states, checked
  separately); palette contrast measured, not asserted.

## 9. If this wins: next cut

1. **Split the guest landing into a real "Tonight" page** (`/api/overview` already has every number) and let
   keepers order the guest tabs independently of the keeper nav.
2. **Find a drink by taste, not by name** — search across `flavors`/`tasting_notes` with the same chip UI
   (`smoky`, `citrus`, `after dinner`), since that's how people actually ask at a home bar.
3. **A "Daylight" sibling** of this theme: same type, gauge, and layout rules; paper plates + brass-on-ink
   tokens, for the iPad in a sunlit room. It is a token block only, because the layout is theme-agnostic.
4. **Gauge visibility as a house setting** (`guest_shows_levels`) so this stays a preference, not a policy.
5. Tap rail gains a *kicked* state (ember, dashed) and "put my batch on tap" for the brewery log.

## 10. Try it

```
?theme=angels            # jumps a phone straight in, then persists
moon icon × 3            # dark → punk → angels, top bar on any screen
Settings → Appearance    # fourth swatch
```
