# Color system

Four roles. Everything colored in the app maps to exactly one of them — if a
new element needs a color and it doesn't fit one of these, that's a sign to
either reuse an existing role or add a role deliberately, not reach for a new
hex value.

## 1. Neutrals — structure, not meaning

`--color-background` (`#f3f3f3`) → `--color-card` (`#ebebeb`) →
`--color-popover` (`#ffffff`) is the app's surface stack: page, then a card
sitting on the page, then a raised surface (composer, message bubbles, form
inputs) sitting on the card. `--color-foreground` / `--color-muted-foreground`
/ `--color-border` handle text and hairlines. None of these carry information
— they're just where things sit.

## 2. Brand accent — orange, `--color-orange`

The app's one signature color. Used for chrome that says "this is Rumble,"
not for data: the default icon-badge accent, the Power breakdown chart line,
the TSB card's icon.

The Next Training card (`TodayTab.tsx`) is a deliberate exception: it uses a
one-off literal (`#d9530f`, a darker shade of the same orange) rather than
`var(--color-orange)`, by request, so it doesn't affect the token everywhere
else it's used. Kept as a literal (not a new token) since nothing else
should ever reuse this specific shade.

### The dark hero surface

`AthleteHeroCard` is the other deliberate exception. It renders on a near-black
gradient (`HERO_GRADIENT`) with `HERO_SHADOW`, both exported from
`components/shared.tsx`, and sets its text to the literal `#f3f3f3` rather than
`var(--color-foreground)`.

The reason is that this is the one surface whose background does not follow the
light/dark theme — it is always dark, so themed foreground tokens would invert
against it and become unreadable in light mode. The two constants are shared
rather than inlined so the gradient and its shadow stay in step; the text
colour is a literal for the same reason as the card above, since nothing else
should adopt it.

## 3. Data intensity — same orange hue, varied shade

Anywhere a number needs to say "how good/complete is this," it's the same
orange hue running dark (bad/low) → bright (good/high) — never a hue swap to
red/green. One function, `intensityColor()` in `shared.tsx`, is the only place
this gradient is computed; `SegmentedStats` and `BarStat` are the only
components that render it (Nutrition calories, Nutrition macros, the TSB
sunburst's dot density).

This scale is only used where there's a real bounded reference (a % of a
calorie/macro target, or the sunburst's fresh/fatigued range). **CTL, ATL, and
Ramp Rate deliberately don't get it** — they have no fixed 0–100 scale, so
`SegmentedStats` renders them as `showTicks: false` (colored number, no tick
bar) rather than implying a range that doesn't exist.

Empty/not-yet-logged values (`noData: true`) render as `—` in a neutral
border color, never as a "0" scored against the intensity scale — an unlogged
macro should read as "nothing recorded," not "the worst possible value."

## 4. Secondary accent — lime, `--color-lime`

A reserved highlight color, used sparingly — the Next Event card, and (as a
plain categorical color, not a semantic one) the Fat macro bar. Never a second
data-intensity scale; if a future card needs "good/bad," it uses role 3, not
lime.

## Warning / destructive — red, `--color-primary` / `--color-destructive`

Reserved for destructive actions and the "Missed" session badge. Not used as
a data-value color anywhere (it used to double as both a "low intensity" tone
and the destructive color — that overlap was the "color carries no meaning"
problem this doc exists to prevent).

## Out of scope, on purpose: calendar type colors

`ACT_COLORS` / `SESSION_COLORS` in `CalendarTab.tsx` (ride=blue, run=green,
threshold=red, etc.) are a separate, categorical palette for telling activity
*types* apart at a glance in the History grid — not semantic like the roles
above (blue isn't "bad," green isn't "good"). Because they're categorical,
the calendar renders a legend of only the types present in the visible month,
rather than trying to force them into the four roles above.

## Out of scope, on purpose: macro colors

Carbs/Protein/Fat (`NutritionTab.tsx`) are three categorical bars, same idea
as the calendar colors — they just need to be distinct from each other, not
mapped to a role. Carbs reuses the brand orange and Fat reuses lime (fine,
since neither is being used as an intensity/semantic signal here — just a
color swatch). Protein is a dedicated brown (`#92400e`) rather than reusing
`--color-foreground`/black: black is reserved for neutral/structural chrome
(role 1), so a data category shouldn't borrow it — that's exactly the kind
of unconsidered reuse this doc exists to catch.
