# Design System: The Smokey Vault

**Product:** Private home-bar inventory, guest digital menu, brewery log, cocktail matcher, and AI mixologist  
**Tone:** Warm speakeasy / prohibition hospitality — never corporate SaaS  
**For:** Google Stitch screen generation (`labs.google/stitch`)

---

## Configuration — Style Dials

| Dial | Level | Description |
|------|-------|-------------|
| **Creativity** | `7` | Editorial brand presence with restrained asymmetry — not chaotic collage |
| **Density** | `6` | Daily-app balanced: inventory grids and scan flows stay readable, not cockpit-cramped |
| **Variance** | `6` | Split heroes and uneven feature grids; avoid rigid equal columns |
| **Motion Intent** | `6` | Spring-weighted hover/press plus soft perpetual glow on hero ornaments |

> Paste this file into Stitch as the project design system. Keep one accent family (copper + gold highlight). Do not invent a second brand palette per screen.

---

## 1. Visual Theme & Atmosphere

A dark, smoke-hazed speakeasy interior — oak, copper, and low amber light. Surfaces feel like aged timber and brushed metal, not glassmorphic SaaS chrome. The room reads intimate and private: guests browse a house menu; the keeper unlocks inventory. Density sits at daily-app balance (Level 6): enough structure for bottle cards and scanners without dashboard clutter. Variance is moderate-asymmetric (Level 6): left-weighted heroes, uneven feature tiles, no centered brochure stacks. Motion is fluid but quiet (Level 6): tactile presses, soft orbit glow, staggered list entrance — never neon pulse theater.

Atmosphere keywords: smoky, warm, intimate, copper, oak, prohibition-era hospitality, analog luxury.

Background atmosphere (not flat fills):
- Base canvas **Vault Charcoal** with three soft radial washes of copper and gold at corners
- Fixed film-grain overlay at ~5.5% opacity, `mix-blend-mode: overlay` (decorative only; never covers text)
- Prefer warm radial depth over flat solid black panels

---

## 2. Color Palette & Roles

### Core surfaces
- **Vault Charcoal** (#0E0D0B) — Primary app canvas / page background
- **Oak Surface** (#171511) — Sidebar, cards, modals, elevated panels
- **Ember Panel** (#221F1A) — Nested wells, input fills, hover backgrounds, icon wells
- **Parchment Cream** (#F3EBE0) — Primary text and high-emphasis labels
- **Smoke Muted** (#A09484) — Secondary copy, metadata, helper text, inactive nav
- **Ash Line** (#353028) — 1px borders, dividers, structural rules
- **Warm Shadow** (rgba(58, 36, 20, 0.45) blended into canvas) — Diffused elevation (`0 18px 48px`), never harsh black drop shadows

### Accents (one family — do not add a third brand accent)
- **Copper Ember** (#C27040) — Primary CTA fill, active borders, focus energy, stock fills, inset nav accent bar
- **Candle Gold** (#D9AE6A) — Secondary highlight: eyebrows, brand mark stroke, focus rings, italic emphasis, icon accents

### Semantic (utility only — not brand accents)
- **Ready Leaf** (#80CA8C) — In-stock / ready / connected success chips
- **Almost Honey** (#E4B86E) — Partial / warning / “almost ready” states
- **Ember Coral** (#E9796D / #F08C82) — Danger, downvote active, form errors

### Banned colors
- Purple / violet neon gradients (“AI purple”)
- Pure black `#000000` as a fill (use Vault Charcoal or Oak Surface)
- Cool blue SaaS accents (`#3B82F6` and kin) as primary brand color
- Oversaturated neons above ~80% saturation
- Mixing cool slate grays with this warm ash system in the same screen

---

## 3. Typography Rules

### Families
- **Display / Brand:** `Playfair Display` — Headlines, wordmarks, card titles, modal titles, large numerals. Weight 500–600. Track slightly tight (`-0.01em` to `-0.02em`). Leading compressed (~1.02–1.15). Distinctive modern editorial serif — required for speakeasy character
- **Body / UI:** `Outfit` — Navigation, buttons, chips, body, labels, forms. Weight 400–600. Relaxed leading (~1.55–1.7). Max ~62–65ch for long ledes
- **Mono (optional, sparse):** tabular numerals inside display faces for counts; use a quiet mono only for raw codes / barcodes if needed (`Geist Mono` or `JetBrains Mono`)

### Scale
- Hero wordmark: `clamp(2.125rem, 5.4vw, 4.5rem)`
- Page title: `clamp(2.5rem, 4vw, 3.625rem)`
- Section heading: ~`1.875rem`
- Card title: ~`1.1875rem`–`1.5625rem`
- Body: `1rem`–`1.0625rem` (never below `14px`)
- Eyebrow / nav label: `9px`–`10px`, uppercase, letter-spacing `0.12em`–`0.16em`, Candle Gold or Smoke Muted

### Banned fonts
- `Inter`, Roboto, Arial, system-ui as the hero/display voice
- Generic browser serifs (`Times New Roman`, `Georgia`, `Garamond`, `Palatino`) — Playfair Display only for serif
- Comic / novelty bar fonts, script calligraphy for UI chrome

---

## 4. Component Stylings

* **Primary button:** Copper Ember fill, parchment or white label, 10px radius, min-height 40–44px, soft warm copper shadow. Hover: mix slightly toward Candle Gold. Active: `scale(0.98)`. No outer neon glow
* **Secondary / scan button:** Oak Surface fill, Ash Line border. Hover: Ember Panel + Copper Ember border. Active: tactile scale
* **Icon button:** 40×40, 10px radius, Ash Line border, Oak Surface fill
* **Chips / filters:** Ember Panel base, Smoke Muted text, 8px radius. Active: Copper Ember border + translucent copper wash
* **Cards (inventory, recipes, features):** Oak Surface, Ash Line 1px border, radius 14–18px, inset top highlight (~4–5% white). Hover: lift `-2px` to `-4px` with Warm Shadow and Copper Ember border. Use cards for selectable/interactive items — not decorative wrapping
* **Sidebar:** Sticky Oak Surface rail (~260px), Ash Line right border. Active nav: Ember Panel fill + 3px Copper Ember inset bar on the leading edge
* **Brand mark:** Diamond (45° rotated square), Copper Ember border, Candle Gold glyph inside
* **Inputs:** Label above (11px Smoke Muted). Field: Ember Panel fill, Ash Line border, 8px radius, min-height 42px. Focus ring: 2px Candle Gold, 2px offset. Error text below in Ember Coral. No floating labels
* **Search field:** 44px height, Oak Surface, Ash Line border, 10px radius
* **Modals:** Oak Surface, 18px radius, Ash Line border, deep warm shadow; backdrop blurred dark veil
* **Status pills:** Tiny uppercase tracking. Ready = Ready Leaf wash; Almost = Almost Honey wash; Missing = Ember Panel + Smoke Muted
* **Loaders:** Prefer skeletal shimmer matching card geometry. Spinner allowed only for short AI waits — keep thin, Candle Gold stroke, never rainbow
* **Empty states:** Dashed Ash Line frame, copper icon, Playfair title, muted guidance + one clear CTA — never lone “No data”
* **Hero ornament (“orbit”):** Circular copper/gold radial well with concentric Ash Line rings and a large Playfair numeral — ambient, not a second CTA

---

## 5. Hero Section

Guest home / vault landing first viewport:
- **Brand-first wordmark** in Playfair Display (“The Smokey Vault”) — largest type on screen
- One short greeting or lede in Smoke Muted (optional italic Candle Gold emphasis on a single phrase)
- One primary action maximum (e.g. Browse menu / Scan bottle) — no “Learn more” pair
- Asymmetric split: copy left, orbit ornament right — **centered brochure heroes are banned**
- No floating badges, promo stickers, or info chips overlaid on media
- No filler chrome: “Scroll to explore”, bouncing chevrons, swipe hints — all banned
- No text overlapping images; every element keeps its own spatial zone
- Optional inline typography image only if it sits at type-height between words and does not collide with the orbit

---

## 6. Layout Principles

- App shell: sidebar + main on desktop; sidebar becomes off-canvas drawer below ~1050px
- Content containment: `max-width: 1440px`, horizontal padding `clamp(16px, 5vw, 82px)`
- Full-height regions: `min-height: 100dvh` — never `100vh` alone
- Feature areas: asymmetric grids (e.g. `1.35fr / 1fr` lead tile spanning rows) — **equal 3-column marketing card rows are banned**
- Inventory: auto-fill responsive grid, min track ~300px collapsing to single column on phones
- Bottle detail: image column + copy column; stack on mobile
- Prefer CSS Grid for structure; avoid percentage `calc()` flex hacks
- One job per section: one heading, one short supporting line, then the interactive content
- Divider language: Ash Line hairlines and negative space over nested card-in-card stacks

---

## 7. Responsive Rules

Hard requirement — every screen must hold at `375px`, `390px`, `768px`, `1024px`, and `1440px`.

- **&lt; 1050px:** Sidebar off-canvas; hamburger in topbar; multi-column stats compress
- **&lt; 700px / &lt; 768px:** Single-column stacks; full-width primary buttons; 44px minimum tap targets; page padding ~16px
- **No horizontal page scroll** (intentional horizontal carousels for taps/tickets may use peeking rows with padding)
- Headlines scale via `clamp()`; body never below 14px
- Hero orbit shrinks beside copy, then stays secondary — never covers the wordmark
- Inline headline images (if used) stack under the headline on mobile

---

## 8. Motion & Interaction (Code-Phase Intent)

> Stitch outputs static frames. Encode this motion so implementation agents match the live vault.

- Easing: spring-like curves — `--ease-out: cubic-bezier(.22, 1, .36, 1)`, `--ease-spring: cubic-bezier(.32, .72, 0, 1)`
- Spring defaults for choreography libs: `stiffness: 100`, `damping: 20`
- Buttons/cards: hover lift + border copperize; active `scale(0.98)` / slight settle
- Hero orbit: slow infinite soft glow (~5.5s ease-in-out) — ambient only
- Lists/grids: staggered entrance (`~100ms` cascade), rise-in opacity/transform
- Animate **only** `transform` and `opacity` — never layout properties for motion
- Grain overlay stays fixed and non-interactive

---

## 9. Voice & Content (for generated screens)

- Guest copy: warm speakeasy / prohibition hospitality — house language, not marketing slogans
- Prefer concrete bar words: bottle, pour, cellar, tap, keeper, guest, vault
- Sample names should feel real (e.g. “Victory Golden Monkey”, “House Old Fashioned”) — never “Acme Spirits” or “John Doe”
- Counts and prices should look organic (`3 left`, `47%`, `$14`) — avoid fake perfection (`99.99%`)

### Banned copy clichés
- “Elevate”, “Seamless”, “Unleash”, “Next-Gen”, “Revolutionize”, “Discover your journey”
- “Scroll to explore”, “Swipe down”, “Tap to continue” filler

---

## 10. Anti-Patterns (Banned)

- No emojis in UI chrome or generated mock copy
- No `Inter` / generic system stacks as the design voice
- No pure black `#000000` fills
- No purple neon, blue glow, or glassmorphic “AI” aesthetics
- No centered generic heroes or equal 3-up feature cards
- No overlapping text on imagery; no floating promo badges on heroes
- No custom mouse cursors
- No excessive gradient-filled headline text
- No `h-screen` without `dvh`; no broken Unsplash links (use stable seeds e.g. `picsum.photos/seed/smokey-vault-{id}/800/600` or local bottle art)
- No corporate dashboard coldness — if a screen could pass for a fintech admin after removing the wordmark, it failed the brand test

---

## Stitch Prompt Starter

Use with this file attached:

> Generate a guest-facing home screen for The Smokey Vault using DESIGN.md. Dark speakeasy atmosphere, Playfair Display wordmark left, copper/gold orbit ornament right, Outfit UI chrome, one primary CTA, asymmetric inventory/feature preview below — no centered marketing hero, no purple accents, no emoji.
