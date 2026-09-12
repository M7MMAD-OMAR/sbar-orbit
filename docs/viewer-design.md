# Viewer design

The viewer has one job the rest of the project does not: it is the only surface a person looks at for minutes at a time, with somebody else's application filling most of it. Everything below follows from that. The session image is the subject, and the interface around it is the frame.

## What is fixed and what follows the desktop

Orbit's palette is fixed and dark, and it is what a viewer shows on any machine. Following the desktop's generated scheme is a switch at the foot of the rail. See [theming](theming.md) for the mechanism.

Dark is not a preference here. The stage holds arbitrary application content, usually a bright page, and a dark frame is what makes that content the brightest thing on the screen instead of competing with it.

## Tokens

Every colour in `viewer/style.css` is a token declared once at the top of the file, and no rule below that block writes a colour of its own. Each token is a Material 3 role with Orbit's value in the fallback position, which is how one declaration serves both palettes.

| Group | Tokens | For |
|---|---|---|
| Ground | `--ground`, `--sunken` | The page, and the well the stage sits in |
| Elevation | `--level-0` … `--level-4` | Five surfaces, lightest at 4 |
| Ink | `--ink`, `--ink-dim` | Body text, and everything secondary |
| Lines | `--line`, `--line-strong` | The hairline every card carries, and the stage's own edge |
| Accent | `--accent`, `--on-accent`, `--accent-soft`, `--on-accent-soft`, `--accent-quiet`, `--on-accent-quiet` | Selection, the primary action, paused |
| Live | `--live`, `--live-soft`, `--on-live-soft` | Running, connected, and the working glow |
| Trouble | `--alarm`, `--alarm-soft`, `--on-alarm`, `--on-alarm-soft` | Errors, stop, a stale frame |
| Shape | `--r-sm` … `--r-xl`, `--r-pill` | 8, 12, 16, 22 pixels |
| Space | `--gap-1` … `--gap-6` | 4, 8, 12, 16, 24, 32 |
| Depth | `--shadow-1` … `--shadow-3` | Card, stage card, stage |

The accent's fallback is the brand blue's dark value, and the working colour is the green the desktop mark already uses for the same meaning, so a person who learned the colours on their panel does not learn them again here. See [brand](brand.md).

## Elevation

On a dark ground a shadow is nearly invisible, so elevation is carried by the surface rather than by the shadow: each rank is a lighter surface, with a hairline border to hold its edge and a shadow only as reinforcement.

| Rank | Surface | Where |
|---|---|---|
| 0 | `--level-0` | The rail |
| 1 | `--level-1` | Cards, session entries, the stage card |
| 2 | `--level-2` | Controls at rest |
| 3 | `--level-3` | The selected session, the state chip |
| 4 | `--level-4` | A control under the pointer |

The stage inverts it. It sits on `--sunken`, below the page rather than above it, inside a strong border and the deepest shadow. Everything else is a step up from the ground; the one thing that matters is a well cut into it, and the eye lands there.

## Where the model is working

Three signals, all reading from the same fact, which is whether the session has an action in flight:

- The light on its card in the rail breathes.
- The stage glows in `--live`, at the size the question is actually asked at.
- The activity line names the actor, the kind of action, its state and its step.

A running session with nothing in flight is open, not working, and none of the three fires for it. The glow answers "is something happening in there" about the thing being looked at, rather than putting a badge somewhere else on the page.

Motion is decoration in all of it: `prefers-reduced-motion` removes every animation and transition, and each signal still reads as a colour.

## The pointer

The agent's pointer keeps fixed colours, blue for the agent and green for the person, because it is drawn over arbitrary application content and its contrast cannot depend on a palette. It is positioned as a percentage of a box carrying no padding or border of its own, so its edges are the canvas's edges exactly and a coordinate on screen is the coordinate the agent used.

Over a stale frame it dims rather than disappearing. Hiding it meant that at the default one frame a second it spent most of its life invisible.

## Layout

A rail of 296 pixels and a work column. Under 900 pixels the rail becomes a horizontal strip of the same cards above the work, which is the only breakpoint. The page never scrolls horizontally at any width, and the cost readout's line wraps rather than pushing the page wider; both are asserted in `tests/preview.test.ts`.
