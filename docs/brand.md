# Brand

The identity has one hard job: survive being recoloured by somebody else's desktop.

Orbit's viewer paints from Material 3 roles supplied by matugen or quickshell, regenerated from the wallpaper ([theming](theming.md)), and the panel tints its mark by session state. So the mark ships as one flat silhouette in `currentColor`. A fixed brand colour is used only where Orbit controls the surface: this repository, the project map, social cards.

## The mark

Two rounded squares, offset on the diagonal, with a gap cut between them.

| Part | Reads as |
|---|---|
| Filled square, front, lower left | The person's own screen, the one that stays untouched |
| Outlined square, behind, upper right | The session Orbit opens beside it |
| The notch where they cross | They occupy the same space and never overlap |

The front shape is the one the reader is standing in, so it is the desktop, not the agent.

The outlined square is one open stroke with round caps that stops short at both crossings. The notch is drawn, not knocked out, so the silhouette holds when the whole mark is filled with a single value.

| File | Form | Use |
|---|---|---|
| [`brand/orbit-mark.svg`](../brand/orbit-mark.svg) | 24 grid, stroke 1.4, `currentColor` | Everything at 20px and above |
| [`brand/orbit-mark-small.svg`](../brand/orbit-mark-small.svg) | Same outer bounds, stroke 2.2, wider notches | 16px and 22px, panel and tray |
| [`brand/favicon.svg`](../brand/favicon.svg) | Small geometry, `#204c87`, swaps to `#6893ce` in a dark scheme | Browser tab |
| [`brand/logo/`](../brand/logo) | Approved raster artwork, 2172 by 724 for the lockups | The source of truth the SVGs were traced from |

The two SVGs are traced from `brand/logo/mark-blue.png`, so the vector and the raster are the same drawing. Change the raster and the trace has to be redone; do not edit one alone.

Safe area is 2 units on the 24 grid, which is the margin already built into the files. Do not add padding on top of it.

Not allowed: a second colour, a gradient, a stroke added around the filled square, rotation, a container circle, or closing the gap. The two squares never share an edge.

## Name

`Sbar` is the namespace and `Orbit` is the product. The lockup sets them as one word, `sbarorbit`, all lowercase, `sbar` at regular weight and `orbit` at bold, same size and same colour. The weight break is the only separator; no space, no colour change, no capital.

In Arabic the name is **صبار أوربت**, shortened to **أوربت**. The Arabic lockup mirrors the Latin one: mark on the right, `صبار` light, `أوربت` semibold.

| Lockup | Latin | Arabic |
|---|---|---|
| On light | [`lockup-latin-blue.png`](../brand/logo/lockup-latin-blue.png) | [`lockup-arabic-blue.png`](../brand/logo/lockup-arabic-blue.png) |
| On dark | [`lockup-latin-reversed.png`](../brand/logo/lockup-latin-reversed.png) | [`lockup-arabic-reversed.png`](../brand/logo/lockup-arabic-reversed.png) |
| One colour | [`lockup-latin-black.png`](../brand/logo/lockup-latin-black.png) | [`lockup-arabic-black.png`](../brand/logo/lockup-arabic-black.png) |
| One colour, reversed | [`lockup-latin-white.png`](../brand/logo/lockup-latin-white.png) | [`lockup-arabic-white.png`](../brand/logo/lockup-arabic-white.png) |

The `reversed` files carry the navy field baked in. They are the only assets with a background of their own; everything else is transparent. The `white` files are the same drawing on nothing, derived from the black ones by recolouring, which is what a dark page wants: `README.md` picks between blue and white with a `<picture>` and `prefers-color-scheme`. `mark-white.png` is the matching mark on its own.

The lockups exist as raster only. Anything that needs a vector lockup, print or a large banner, has to come from the design file rather than from an upscale.

## Colour

| Role | Light | Dark | Where |
|---|---|---|---|
| Brand | `#204c87` | `#6893ce` | Mark and lockup on fixed surfaces |
| Dark field | `#04204f` | | Background baked into the reversed lockups |
| Surface | `#f1f4f8` | `#121314` | Page background |
| Ink | `#192842` | `#e3e2e2` | Body text |

`#204c87` is not a new value. It is already the viewer's `--primary` fallback in `viewer/style.css`, which is why the mark and the interface agree without a second source.

The raster artwork does not hold one blue. Sampled: `#1f4e8d` in `mark-blue.png`, `#18467f` in `lockup-arabic-blue.png`, and the two dark fields differ as well, `#022154` against `#061d4a`. The SVGs are on the pinned value; the rasters drift and need re-exporting against it.

Three values in the product are fixed and are not identity colours. The agent pointer is `#255fce` and the human pointer is `#167653`; they sit over arbitrary application content, so their contrast cannot depend on a palette. The panel states are `#8a8a8a` idle, `#4caf50` working, `#ff9800` paused, `#585858` offline.

That is why the brand accent is blue. Green and orange already carry meaning in the same status bar, and a green mark would be read as an agent that is working.

## Type

The viewer takes its typeface from the desktop theme file and falls back to `system-ui`, so there is no brand typeface inside a session. On fixed surfaces the wordmark is a geometric sans with low contrast; Arabic pairs with IBM Plex Sans Arabic or Readex Pro, which match that contrast rather than a naskh curve.

## Where the mark is used

One geometry, four surfaces. Nothing keeps a second copy of it.

| Surface | How it gets the mark |
|---|---|
| Desktop panel | `Glyph` in `desktop/panel.py` paints the path in Cairo, tinted by session state. It is the default shape; `--style bar\|dot\|count` still gives the older ones |
| Quickshell bar | `desktop/quickshell/OrbitIndicator.qml` draws the same path as a `Shape`, tinted from `Appearance.colors` |
| Viewer | `viewer/index.html` carries it inline beside the eyebrow, in `currentColor`, and links `/favicon.svg` |
| Viewer favicon | `src/preview.ts` serves `brand/favicon.svg` directly, so the file is not copied into `viewer/` |
| Project map | `docs/overview.html` carries it inline and links the same favicon |

The path data is repeated in four languages because SVG, Cairo, QML and HTML cannot share a file. When the geometry changes, all of them change; `brand/orbit-mark-small.svg` is the one to edit first and copy from.

The QML copy is the one exception to the 24 grid. It carries the same drawing with the safe area removed, on a 20 by 18.21 box, so every coordinate is positive and a bar that clips its indicators cannot cut a corner off it. Subtract 2 from every x and 2.89 from every y to get from one to the other.

## Checks before shipping an asset

1. Fill the whole mark with a single flat colour. If it stops reading, the gap or the stroke is wrong.
2. Render at 16px in black on white. If the two squares merge, use the small variant.
3. Put it on `#4caf50`. The mark must still read as a mark, not as a status light.
