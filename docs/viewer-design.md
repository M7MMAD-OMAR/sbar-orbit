# Viewer design

The viewer has one job the rest of the project does not: it is the only surface a person looks at for minutes at a time, with somebody else's application filling most of it, and the person looking is not necessarily technical. Everything below follows from that. The picture is the subject and the interface around it is the frame.

## Two rules

**No lines.** Nothing in `viewer/style.css` draws a border, and nothing draws a hairline ring with a shadow either, because that is a border wearing another property's name. Separation comes from the surface a thing sits on and the shadow it casts. Two exceptions, both for reasons other than decoration: the focus ring, which a keyboard has no other way to find, and the white stroke on the pointer in the markup, which sits over somebody else's page rather than over this design.

**No hue.** White, black, and the greys between them. State is carried by brightness, motion and words. That also means it survives being read by somebody who cannot separate red from green, which a green and amber status light does not. The one thing that keeps its colour is the agent pointer, for the same reason its stroke is white.

## What is fixed and what follows the desktop

The palette above is what a viewer shows on any machine. Following the desktop's generated scheme is a switch at the foot of the rail, and a desktop palette has hue in it, which is the person's choice to make. See [theming](theming.md).

Dark is not a preference. The stage holds arbitrary application content, usually a bright page, and a dark frame is what makes that content the brightest thing on screen rather than a competitor to it.

## Tokens

Every colour is a token declared once at the top of the file, and no rule below that block writes a colour of its own. Each token is a Material 3 role with Orbit's value in the fallback position, which is how one declaration serves both palettes.

| Group | Tokens | For |
|---|---|---|
| Ground | `--ground`, `--sunken` | The page, and the well the picture sits in |
| Elevation | `--level-0` … `--level-4` | Five surfaces, lightest at 4 |
| Ink | `--ink`, `--ink-dim`, `--ink-faint` | Three weights, and nothing quieter is legible |
| Loud | `--loud`, `--on-loud` | Inversion, for the primary action and for a real error |
| Shape | `--r-sm` … `--r-xl`, `--r-pill` | 9, 13, 18, 24 pixels |
| Space | `--gap-1` … `--gap-6` | 4, 8, 12, 16, 24, 32 |
| Depth | `--shadow-1` … `--shadow-3` | Card, stage card, stage |

The steps between surfaces are wider than a bordered design needs. With no line to hold an edge, the difference between one surface and the next is the entire separation, so each is about eight per cent lighter than the one below rather than the three or four a hairline would have carried.

Without hue there is no red for an error, so an error takes the loudest thing a monochrome system has, which is inversion: dark text on a light field, the only place on the page where that happens apart from the primary button.

## Elevation

On a dark ground a shadow is nearly invisible, so elevation is carried by the surface and the shadow only says which way the stack goes.

| Rank | Surface | Where |
|---|---|---|
| 0 | `--level-0` | The rail, and text inputs |
| 1 | `--level-1` | Cards, session entries, quiet buttons |
| 2 | `--level-2` | Controls at rest |
| 3 | `--level-3` | The selected session, a control under the pointer |
| 4 | `--level-4` | A button under the pointer |

The stage inverts it. It sits on `--sunken`, below the page rather than above it, under the deepest shadow. Everything else is a step up from the ground; the one thing that matters is a well cut into it, and the eye lands in the hole.

## Where the assistant is working

Four states, four brightnesses, and only one of them moves.

| State | Light | Words |
|---|---|---|
| Working | Full ink, a halo, breathing | Working |
| You are in control | Full ink, still | You are in control |
| Open | Dim | Open |
| Finished | Dimmest | Finished |

Bright and moving is working, bright and still needs you, dim is open, dimmest is done. The stage carries the same fact at the size the question is asked at: while the selected session has an action in flight the well lights up around the picture and a line sweeps across the top of it.

An action in flight is the only honest signal for "something is happening right now". A session that is running with nothing in flight is open, not working, and saying otherwise is the kind of small lie that teaches a person to stop believing the screen.

`prefers-reduced-motion` removes every animation and transition. The halo is a shadow rather than a keyframe, so it survives, and all four states stay separated by brightness alone. That case is checked rather than assumed; `output/viewer-reduced-motion.png` is the check.

## Words

The person reading this is not required to know what a session, a frame, a backend or a surface is.

| Instead of | It says |
|---|---|
| Pause agent, Resume agent, Stop session | Take over, Hand back, End session |
| running, paused, closed | Open, You are in control, Finished |
| Frame age: 3.2s | Picture is 3 seconds old |
| SbarOrbit: Fill field · working · Step 12 | SbarOrbit is filling in a box right now · step 12 |
| Low cost · 1 frame/second | Every second |
| Session · aa11 · browser | Web page · Working |

The state itself stays on `#state`'s `data-state` attribute, which is what anything reading the page for the state should use. The words beside it are for a person and are free to change; the two browser tests read the attribute for exactly that reason.

The short session identifier appears on a card only when two cards would otherwise read the same. It exists to tell duplicates apart, and on every other card it is four characters of noise.

The viewer's own cost readout is kept and moved into a **Technical details** disclosure under the picture. It is the only instrument for what the viewer costs, because the viewer runs outside Orbit's resource scope, and it is not a sentence anybody needs to read first.

## Bigger

**Make it bigger** hides the rail, the panels and the heading, and lets the picture use the height of the window as well as its width. It changes nothing about the session, so unlike **Screen size** it needs no pause: it is the answer to "let me see it properly" that does not move a single coordinate out from under the assistant.

The width is still what sizes the picture, computed from the window's height and the picture's shape through `--shot-width` and `--shot-height`, so the canvas and the box the pointer is placed in stay the same rectangle. That is what keeps the pointer on its coordinate in both views, which is asserted at both sizes.

**Screen size** does change the session, so it waits for **Take over** and says so on screen beside the control. A greyed control with no reason next to it teaches nobody anything.

## Controls

A `<select>` with the platform's arrow and casing taken off it, a chevron cut out of a filled block, and the surface it sits on for its edge. The list a select opens is drawn by the browser and cannot be styled; `color-scheme: dark` is what keeps that list dark rather than white. A hand built listbox would style the list too, and it would need document level click handling, its own keyboard model and its own accessibility tree. That is a lot of new ways to be wrong in exchange for the appearance of one popup.

## Layout

A rail of 300 pixels and a work column. Under 900 pixels the rail becomes a horizontal strip of the same cards above the work, which is the only breakpoint. The page never scrolls horizontally at any width, and the cost readout wraps rather than pushing the page wider; both are asserted in `tests/preview.test.ts`.
