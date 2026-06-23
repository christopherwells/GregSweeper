# GregSweeper Icon Style Guide

This document defines the house style for GregSweeper's custom icons so any new
icon drops into the existing set seamlessly. Hand this file to whoever (or
whatever) is drawing a new icon, along with sample images of the subject.

GregSweeper is a polished Minesweeper game. Its mascot is **Greg**, a friendly
green crab field-scientist. The icon set covers game modes, modifiers, medals,
and power-ups. Every icon is a small, bold, flat-vector emblem that has to stay
legible when it is shrunk to a 24-pixel mode-card chip or a 16-pixel inline
glyph.

---

## Output format

- **SVG, hand-authored, is strongly preferred** — the whole set is SVG and the
  app swaps icons in by filename. If you can output clean SVG that follows the
  construction rules below, do that. If you can only produce raster, render a
  transparent PNG at 512×512 that matches the visual spec, and someone will
  trace it to SVG afterward.
- **Canvas:** `viewBox="0 0 128 128"`. Design on a 128×128 grid.
- **Background:** fully transparent. Never draw a background panel, frame, or
  card behind the subject — the app supplies the card.
- **Safe area:** keep the meaningful shapes within roughly x/y 6–122. Strokes
  can bleed close to the edge (a dumbbell bar may run edge to edge) but nothing
  important should be clipped.
- **No raster effects:** no gradients meshes, no blur, no drop shadows, no
  photographic texture. Flat fills only. (Flat opacity overlays for highlights
  are fine — see below.)

---

## The look in one sentence

Bold flat shapes, filled with saturated color, wrapped in a single thick
near-black outline, with round joins and round caps — a sticker / enamel-pin
aesthetic that reads instantly at thumbnail size.

---

## Color palette

Use these exact hex values so a new icon matches the set. Roles, not a rainbow —
pick the few that fit the subject.

**The outline (used on essentially everything):**
- `#232838` — near-black ink. This is THE outline color for every shape. Never
  pure black.

**Brand greens (Greg, and anything "GregSweeper green"):**
- `#53a05b` — Greg's shell / primary green
- `#3e7f46` — green shadow / underside
- `#7cc184` — green highlight / mottling
- `#2e8b57`, `#50c878`, `#5ad07a` — gem / accent greens (medals)

**Skin (hands, Greg's claws hold these too):**
- `#d4a068` — skin base
- `#e0b888` — skin highlight
- `#e8873a` — deeper orange accent (claw tips, pencil ferrule)

**Metal / neutral:**
- `#9a9a9a` — steel / metal gray
- `#46506b`, `#3a4258` — slate ribbon / cool neutral

**Paper / light surfaces:**
- `#f3f6fb`, `#eef3fb` — paper white
- `#dfe5ee`, `#d4dae6`, `#b9c2d4` — light gray fills / faint grids

**Signal colors:**
- `#e4453a` — flag red (the GregSweeper flag is always this red)
- `#ffd23e` — highlight yellow (today's date, pencil body, "active")
- `#5d8ad8`, `#3a5fa6` — blues (mountains, cool subjects)

When a subject needs a color not on this list, pick the nearest family member
and keep it equally saturated. Two color ramps per icon is the ceiling — more
than that and it stops reading at 24px.

---

## Construction techniques

There are three ways shapes are built in this set. Use whichever fits the part.

### 1. Fill + outline (the default)

Every solid shape is a flat fill with a `#232838` stroke, `stroke-linejoin="round"`
(and `stroke-linecap="round"` for open paths). This is 90% of the set.

```svg
<rect x="16" y="22" width="96" height="92" rx="10"
      fill="#f3f6fb" stroke="#232838" stroke-width="6"/>
```

### 2. Double-stroke (for thin limbs / antennae / legs)

Thin elements that must read on both dark and light backgrounds are drawn TWICE:
a wide dark stroke underneath, then a narrower colored stroke on top. The dark
shows as an outline on both sides of the colored core.

```svg
<path d="M42 84 L30 96 L26 107" fill="none" stroke="#232838" stroke-width="9"
      stroke-linecap="round"/>
<path d="M42 84 L30 96 L26 107" fill="none" stroke="#53a05b" stroke-width="4.5"
      stroke-linecap="round"/>
```

### 3. Composite (dark shape behind, colored shape inset on top)

For a chunky form made of several overlapping pieces (a hand, a cluster), draw
the whole silhouette ONCE in `#232838`, slightly oversized, then draw the
color fills inset by ~3–4 units on top. The dark reads as a uniform outline and
there are no seams where the internal pieces overlap. (This is how the hand /
fist forms are built.)

### Highlights

A highlight is a lighter fill of the same family at reduced opacity, laid on top
of the base shape — never a gradient.

```svg
<path d="M44 52 ... Z" fill="#5ad07a" opacity="0.4"/>
```

---

## Stroke-width scale (on the 128 grid)

Consistent weights are what make the set feel like one hand drew it:

- **6** — main outline of the dominant shape (the big silhouette)
- **5** — secondary outlined shapes, medium parts
- **3.5–4** — small parts, inner details, little flags
- **2.5** — fine facet/accent lines
- **9–10 / 4.5–5** — the double-stroke pair for thin limbs (dark / color)

Bigger icons keep heavier outlines; never go below ~2.5 or the line vanishes at
small sizes.

---

## Small-size legibility (non-negotiable)

These render at **24px** on mode cards and **16px** inline. Before shipping,
shrink the icon to 24px and confirm it still reads.

- One clear silhouette. If you can't tell what it is as a 24px black blob, the
  composition is wrong.
- No detail finer than ~5 units on the 128 grid — it disappears.
- High contrast between adjacent fills; rely on shape, not subtle hue shifts.
- Round, generous corners (`rx` of 3–10 on rects). Nothing hair-thin.

---

## Two complete annotated examples

These are real icons from the set. Match this level of finish.

### `mode-daily.svg` — a flagged calendar

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <!-- Page -->
  <rect x="16" y="22" width="96" height="92" rx="10" fill="#f3f6fb" stroke="#232838" stroke-width="6"/>
  <rect x="16" y="22" width="96" height="26" rx="10" fill="#e4453a"/>
  <path d="M16 40 L112 40 L112 48 L16 48 Z" fill="#e4453a"/>
  <!-- Binder rings -->
  <g stroke="#232838" stroke-width="6" stroke-linecap="round">
    <path d="M38 14 L38 30"/>
    <path d="M90 14 L90 30"/>
  </g>
  <!-- Faint day grid -->
  <g fill="#d4dae6">
    <rect x="28" y="58" width="16" height="14" rx="3"/>
    <rect x="56" y="58" width="16" height="14" rx="3"/>
    <rect x="84" y="58" width="16" height="14" rx="3"/>
    <rect x="28" y="86" width="16" height="14" rx="3"/>
    <rect x="84" y="86" width="16" height="14" rx="3"/>
  </g>
  <!-- Today: highlighted, flagged -->
  <rect x="52" y="80" width="26" height="26" rx="5" fill="#ffd23e" stroke="#232838" stroke-width="5"/>
  <path d="M61 100 L61 86 L73 90 L61 94" fill="#e4453a" stroke="#232838" stroke-width="3.5" stroke-linejoin="round"/>
</svg>
```

### `medal-emerald.svg` — a gem on a ribbon (shows highlight/facet technique)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <!-- Ribbon -->
  <g stroke="#232838" stroke-width="5" stroke-linejoin="round">
    <path d="M42 8 L60 8 L67 40 L46 46 Z" fill="#46506b"/>
    <path d="M86 8 L68 8 L61 40 L82 46 Z" fill="#3a4258"/>
  </g>
  <!-- Emerald-cut stone -->
  <g stroke="#232838" stroke-width="5" stroke-linejoin="round">
    <path d="M38 56 L50 44 L78 44 L90 56 L90 96 L78 108 L50 108 L38 96 Z" fill="#2e8b57"/>
  </g>
  <!-- Inner facet outline -->
  <g stroke="#1f6b42" stroke-width="2.5" stroke-linejoin="round" fill="none">
    <path d="M44 52 L56 48 L72 48 L84 52 L84 100 L72 104 L56 104 L44 100 Z"/>
  </g>
  <!-- Light facets (opacity overlays) -->
  <path d="M50 44 L56 48 L44 52 L38 56 Z" fill="#50c878" opacity="0.7"/>
  <path d="M78 44 L72 48 L84 52 L90 56 Z" fill="#3da86a" opacity="0.5"/>
  <path d="M44 52 L56 48 L72 48 L84 52 L84 60 L44 60 Z" fill="#5ad07a" opacity="0.4"/>
  <!-- Sparkle -->
  <path d="M94 38 L96 44 L102 46 L96 48 L94 54 L92 48 L86 46 L92 44 Z" fill="#ffffff" opacity="0.8"/>
</svg>
```

---

## Checklist before calling an icon done

- [ ] `viewBox="0 0 128 128"`, transparent background, nothing important clipped
- [ ] Every shape carries a `#232838` outline; round joins/caps
- [ ] Palette pulled from the list above; ≤2 color ramps
- [ ] Stroke weights follow the scale (≈6 on the hero shape, never below ~2.5)
- [ ] Highlights are opacity overlays, not gradients
- [ ] Shrunk to 24px it still reads as the subject
- [ ] Feels like it belongs next to the calendar and the emerald above
