# Theming the viewer

The viewer ships with its own palette and needs no configuration. On a desktop that already generates a colour scheme, it can take that scheme instead, so the workspace reads as part of the same environment rather than a foreign page.

That is a switch, not the default. **Follow desktop colours** at the foot of the rail turns it on, and the choice is remembered in that browser's own storage; storage that is unavailable or blocked leaves Orbit's palette in place. Until it is thrown, the page looks the same on every machine, which is what [viewer design](viewer-design.md) describes.

## How it works

`viewer/style.css` paints from CSS custom properties named after [Material 3 colour roles](https://m3.material.io/styles/color/roles), each with the shipped colour as its fallback. The broker serves a generated `/theme.css` that sets those properties under `:root[data-palette="desktop"]`, which is the attribute the switch writes. With no theme file present, or with the switch off, no role is set and every token resolves to its fallback, which is Orbit's own palette.

The scoping is what makes the choice a choice. An unscoped rule would apply the desktop's colours to everyone who happens to have matugen configured, whether or not they asked the viewer to follow it.

## Where a palette is read from

When `ORBIT_THEME` is set, that file is the only one read. Otherwise these are read in order, later files overriding earlier ones:

| Path | Written by |
|---|---|
| `$XDG_CONFIG_HOME/matugen/colors.json` | matugen, when configured with a JSON template |
| `$XDG_STATE_HOME/quickshell/user/generated/colors.json` | quickshell wallpaper theming |
| `$XDG_CONFIG_HOME/sbar-orbit/theme.json` | you |

Merging rather than picking the first match means a desktop that regenerates its palette from the wallpaper keeps supplying colours while a hand written file adds fonts or overrides single roles. The file is read on each viewer load, so a new palette applies on refresh.

## File format

Either a flat Material You map, which is what matugen and quickshell write:

```json
{ "surface": "#121314", "on_surface": "#e3e2e2", "primary": "#b9c9d0" }
```

Or an Orbit theme file, which can also name fonts:

```json
{
  "colors": { "surface": "#121314", "on_surface": "#e3e2e2" },
  "fonts": { "main": "Google Sans Flex", "monospace": "JetBrains Mono NF" }
}
```

Roles read: `surface`, `surface_container_lowest`, `surface_container_low`, `surface_container`, `surface_container_high`, `surface_container_highest`, `surface_variant`, `on_surface`, `on_surface_variant`, `outline`, `outline_variant`, `primary`, `on_primary`, `primary_container`, `on_primary_container`, `secondary_container`, `on_secondary_container`, `tertiary`, `tertiary_container`, `on_tertiary_container`, `error`, `on_error`, `error_container`, `on_error_container`. Anything else in the file is ignored, so a palette that gains new roles does not break the viewer.

Light or dark is decided from the luminance of `surface` and emitted as `color-scheme`, which is what makes form controls and scrollbars match. It is not decided from `prefers-color-scheme`, because the owned headless browser used in tests and experiments reports light regardless of the desktop.

## What is not themed

The agent pointer keeps fixed colours. It is drawn over the session image, which is arbitrary application content, so its contrast cannot depend on the desktop palette.

## Boundaries

A theme file is observed content, and the viewer origin holds a session access token, so the file is never passed through to CSS as written. Only the listed keys are read; colours must match `#` followed by three to eight hexadecimal digits, and font names must be letters, digits, spaces, underscores or hyphens, at most 48 characters. A value that fails is dropped rather than escaped. Fonts are emitted with a generic fallback appended, so a font the viewer's browser does not have still renders.

A missing, unreadable or malformed file is not an error. The shipped palette stays in place.

Orbit's own palette is dark, so a theme file that supplies only a few roles against a light `surface` mixes light roles over dark fallbacks. matugen and quickshell both write the full map, so this is an edge case of hand written files rather than of generated ones; supply `surface`, `on_surface` and the surface containers together, or all of the roles.

`bun test tests/theme.test.ts` covers the flat and nested formats, font handling, the light and dark decision, injection attempts through both colour and font values, environment resolution and the fallback path, and asserts that the stylesheet itself carries no unthemed colours.
