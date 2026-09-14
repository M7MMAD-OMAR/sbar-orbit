# The desktop panel, reconsidered

A study, not a change. Nothing here is built yet.

Status, 14 September 2026: the settings window this document is about is gone. Its questions moved to the settings view of the viewer, which is described in [viewer design](viewer-design.md); what follows is the reasoning that shaped those questions, and it still applies to the rows the page now draws.

The panel is the mark on the edge of the screen, the card list it opens, and the settings behind a right click. This document is about the settings window and the interaction around it, because that is the part a person is asked to operate, and it currently asks them for eighteen decisions in seven groups.

## What it asks for today

| Group | Settings | What a person is actually deciding |
|---|---|---|
| Startup | `autostart` | Should this come back after I log in |
| Placement | `edge`, `monitor`, `margin`, `position` | Where the dot sits |
| The mark | `style`, `size`, `hideWhenIdle`, `colors` (four of them) | What the dot looks like |
| The viewer | `viewerBrowser`, `viewerAppWindow` | How the window opens |
| Working glow | `frame`, `framePulse`, `frameColor` | Should the screen glow while something runs |
| Motion and blending | `motion`, `blend` | How the card animates and how see-through it is |
| Notifications | `notifications`, `blink` | Should I be told when something happens |

Eighteen rows, and the right hand column has seven entries. That ratio is the problem in one line.

## The five faults

**One question is spread across several rows.** "Should the screen glow while an assistant is working" is three settings: whether it glows, whether it breathes, and what colour it is. "Should I be told when something happens" is two. "Where does the dot sit" is four, and one of those four, `position`, is already set by dragging the mark, so the row is a second way to do something the person has done with their hand.

**The words are Orbit's, not the reader's.** "The mark", "Working glow", "Liquid motion", "How solid the card is", "Blend". A person who has never read this repository cannot tell what a mark is, and "liquid motion" describes the implementation's feel rather than what turning it off does.

**The state colours ask for knowledge of a state machine.** Four colour wells named idle, working, paused, and offline. To set them usefully you must first know that Orbit has exactly those four states, that offline means the broker rather than the session, and that the colours are also what the quickshell bar reads. That is a maintainer's control sitting in a person's window.

**Nothing is ranked.** A switch that decides whether Orbit starts at login sits in the same visual weight as a slider for how transparent a card is. The reader has no way to tell which rows they should care about, so they read all eighteen or none.

**The window is undiscoverable.** It opens on a right click on a small dot that is deliberately unobtrusive. There is a search box inside it, which is an admission that the list is too long to scan, and a search box cannot be reached by somebody who never found the window.

The two dropdowns in the screenshot are a symptom rather than the disease. "Right" and "Largest screen" are correct answers to questions nobody asked in those words: a person wants to point at where the dot should go, not choose the noun for an edge.

## What it should ask instead

Five decisions on one screen, in the order a person meets them, and everything else behind one disclosure.

**1. Start Orbit when I sign in.** One switch. Unchanged, just moved to the top, because it is the only row that decides whether any of the rest happens.

**2. Where the dot sits.** One control, not four. A small picture of the screen, or of both screens when there are two, with eight places to click around its edge. Clicking one sets the edge, the monitor and the position along the edge together, which is what the person meant. Dragging the real mark keeps working and moves the dot in the picture. `margin` disappears from the window; a distance from the edge is not a decision, it is a default that should be right.

**3. Tell me when an assistant starts or finishes.** One switch, replacing `notifications` and `blink`. They are the same intent expressed twice, once through the notification daemon and once through the mark.

**4. Glow my screen while one is working.** One switch, replacing `frame` and `framePulse`. The breathing is part of what the glow is; a person who wants the glow without the motion is served by the system's own reduced motion setting, which the glow should be reading anyway.

**5. Open the viewer in.** The browser picker, unchanged. It answers a question a person genuinely has and has no other way to answer.

### Behind "More"

`style`, `size`, `hideWhenIdle`, the four state colours, `frameColor`, `motion`, `blend`, and `viewerAppWindow`. Every one of these is either taste or tuning, and none of them is wrong to keep. They stop being the first thing a person reads.

`motion` and `blend` deserve a note of their own: they are performance controls wearing the clothes of taste, and on the measured host that matters. Under "More" they can say so, which they cannot say from a group called "Motion and blending".

### Interaction

A left click on the mark opens the viewer today and that is right. The card list should carry a visible way into settings rather than only a right click: a gear at the foot of the list, where a person who opened the list is already looking.

The search box stays. With five rows it will rarely be needed, which is the point.

## What this costs and what it risks

The schema in `desktop/orbit_settings.py` is the single source for the window, the `sbar-orbit config` command and its search terms, so the grouping is one edit in one file and the window follows. That part is cheap.

Two things are not cheap and should be decided before anything is built.

The eight place picker is a new widget. It replaces three controls with one drawing, and a drawing that is wrong is worse than three dropdowns that are ugly. It needs the monitor layout, which the panel already reads for `monitor_for`, and it needs to be operable from a keyboard, which a picture is not by default.

Collapsing `notifications` with `blink`, and `frame` with `framePulse`, removes settings that exist today. Anyone whose stored file sets them to different values loses that combination. The migration is to keep reading both keys and write both, with the single switch setting the pair, so an existing file is not broken by a window that no longer shows one of them.

## Not covered here

This is the settings window and the way into it. The card list itself, the notification text, and the quickshell module are each their own question. The viewer is [a separate document](viewer-design.md).
