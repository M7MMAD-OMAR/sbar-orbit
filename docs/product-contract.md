# Product architecture and interface contract

This contract describes the current source owners. It does not certify participant
acceptance, a published release or native owner handoff. The
[native release hold](native-handoff-incident.md) remains unconditional.

| Owner | Responsibility | Boundary |
| --- | --- | --- |
| `src/session.ts`, `Sessions` | Session identity, profile leases, lifecycle, request deduplication and input ordering | The broker is the authority for running, paused, closing and closed. Views do not own a second session state machine. |
| `src/browser.ts`, `BrowserBackend` | Owned browser pages, supported actions, surface size and capture | Page and pointer coordinates belong to the private workspace. No fallback to the person's browser or input. |
| `src/preview.ts`, `startPreview` | Optional loopback viewer transport, token, exact origin and method allowlist | Viewer requests cannot create sessions or issue arbitrary agent actions. Closing the viewer does not stop the broker. |
| `viewer/viewer.js` | Session selection, localized presentation, control busy state, frame rendering and viewer layout | The displayed state comes from broker replies. Manual input waits for pause acknowledgement and uses `session.control`. |
| `viewer/settings.js` | Search and localized controls for the returned settings schema | It does not duplicate defaults or validation rules. Successful writes use the returned schema; failures retain the last known values. |
| `src/desktop-settings.ts`, `desktop/orbit_settings.py` | Settings bridge and shared schema/validation/persistence | The viewer and CLI write through the same schema. The desktop panel reads the stored settings. Browser fixtures do not establish actual panel behavior. |
| `viewer/diagnostics.js` | Explicit report preparation, review and download/share choices | Reports do not include page content, typed text or screenshots. Preparation is separate from sharing. |
| `website/src/App.tsx`, `locale.tsx`, `usePresentation.ts` | Public onboarding, translation and presentation motion | A walkthrough is labeled as a walkthrough. Installation, registration, runtime measurement and acceptance are separate facts. |

The subject of the viewer is the selected application image. One rail selects
sessions; the header identifies the conversation, project and agent. Take over
and resume stay beside that identity. Typing appears only during takeover.
Session tools contain workspace sizing, reports, stop and the measured viewer
cycle. Settings reuse the same shell and connection, reached from the rail.
Secondary controls should not duplicate session navigation.

The agent supplies conversation, task, project and agent names as display
metadata. They describe a session; they do not turn the viewer into an agent-host
task manager. `sessionId` is the broker identity. A named account selects an Orbit
snapshot with an exclusive lease and an explicit save operation while paused.
It does not mean access to a live personal profile. New sessions belong to the
agent/API/CLI entry points; the viewer follows them instead of owning a second
creation or account lifecycle.

Preserve Orbit's monochrome surfaces, mark, optional desktop palette and visible
keyboard outline. English and Arabic share logical CSS properties. The image,
pointer and manual coordinates stay left to right in either language. Resizing
the view changes presentation; changing screen size changes the workspace and
requires takeover. Do not stretch, tint or crop application pixels.

Settings controls need a localized name, associated description and appropriate
native or ARIA semantics. A successful save or refusal must preserve focus when
the focused control still exists. Choice groups have one Tab stop and support
arrow keys, Home and End. Empty searches and failed requests must say what
happened. A status message cannot replace the authoritative returned value.

Public setup must offer platform-appropriate installation commands. The managed
broker socket default is selected by the CLI, so the common preview command is
`sbar-orbit preview`. A custom `serve` socket needs an explicit override in that
terminal. Preview prints a link and opens no window. Support copy links its
evidence tiers and states the native hold beside native guidance.

| Platform | Current interface boundary | Remaining required evidence or interface |
| --- | --- | --- |
| Linux | Private browser viewer and Linux desktop mark schema. Isolated Fedora sessions have their own backend; the native owner path stays held. | Participant/device usability, actual appearance and permitted native acceptance after the hold is resolved. |
| macOS | Private browser/session controls and viewer preferences. Linux mark settings refuse before interpreter spawn. | Real account/device usability and a separately designed native equivalent where the platform permits it. No Aqua or owner-input fallback. |
| Windows | Private browser/session controls and viewer preferences. Linux mark settings refuse before interpreter spawn. | Real account/device usability and permitted platform-specific settings/ownership interfaces. No owner-desktop input fallback. |

Viewer language, rail, palette, focus view and preview cadence are presentation
preferences. Workspace dimensions and manual input are session controls. The
settings page in this source is the desktop mark schema, rather than a portable
manager for installation, updates, agent registration or account connections.
Those lifecycle entry points remain CLI/installer contracts. The scoped refusal
prevents an incorrect executable launch; it does not establish native parity or
close the full platform product objective.

Automated private fixtures can prove rendered states, keyboard interaction,
overflow, manual browser control and viewer-close continuity. They cannot prove
participant comfort, concurrent personal work, external account/device behavior,
publication or permission to activate held native paths. Those requirements stay
in [completion-status.md](completion-status.md) and [acceptance.md](acceptance.md).
