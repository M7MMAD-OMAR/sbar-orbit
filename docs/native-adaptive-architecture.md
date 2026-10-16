# Adaptive native desktop architecture

Status: staged implementation, not full desktop capability acceptance.

Orbit must discover the current system and application registrations, attach to exact
live objects when requested, and select operations from measured capabilities. It
must not depend on one person's installation paths or silently replace an existing
application session with a fresh application. Standalone browser automation, DOM
automation and browser profile copying remain retired.

## Problem and first implementation slice

The repository audit found application discovery disconnected from the general
launch path. Discovering an installed executable did not guarantee that a subsequent
launch used the matching registration or handled an installation inside the owner's
home directory correctly under Orbit's private HOME.

The current first slice connects an exact Linux `.desktop` registration ID to
registered launch resolution, then launches through the existing private desktop
pipeline. `src/application-launch.ts` resolves registrations and executable recipes;
`src/fedora.ts` routes `launch-installed` into private launch. Registration lookup
uses the installation environment, while application execution retains the private
HOME. Known profile-selection arguments are refused. Private HOME is not a
filesystem sandbox and cannot prove that every application ignores owner state.

This slice handles supported literal executable recipes. Activation mechanisms,
wrappers and packaging that cannot preserve the private session contract must return
an explicit unsupported result. Discovery of a registration does not imply every
activation mechanism is supported. See the [Desktop Entry Specification](https://specifications.freedesktop.org/desktop-entry/latest-single/)
for `Exec`, `TryExec`, field codes and D-Bus activation semantics.

This is fresh private launch. It does not complete semantic application control or
existing owner window attachment. Owner application handoff remains disabled under
the compositor crash release hold. Windows and macOS native execution adapters
remain separate work requiring runtime evidence.

## Identity and intent

Keep these identities separate:

| Object | Identity and lifetime |
| --- | --- |
| Installed registration | Desktop file ID, Windows AppUserModelID, or macOS bundle identifier; resolve location when needed |
| Process instance | Process ID plus a creation or generation discriminator; invalidate after exit |
| Window | Backend native handle bound to its current process and session; invalidate after destruction |
| Accessibility element | Backend object reference bound to a current tree generation and window |
| Lease | Explicit task ownership, permitted capabilities and expiry |

Names and window titles help selection but are not sufficient identities. One
application may have several processes and windows. Windows UIA runtime identifiers
may be recycled, while Wayland foreign toplevel identifiers expire when unmapped.
Revalidate before acting. [UIA identity rules](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.getruntimeid),
[Wayland toplevel protocol source](https://raw.githubusercontent.com/wayland-mirror/wayland-protocols/main/staging/ext-foreign-toplevel-list/ext-foreign-toplevel-list-v1.xml).

`attachExisting` and `launchInstalled` express different intent. An ambiguous,
unsupported, stale or unavailable attachment must not fall back to fresh launch.
The result must state which operation happened and which session it affects.

Windows registration lookup should use [AppUserModelID discovery](https://learn.microsoft.com/windows/configuration/find-the-application-user-model-id-of-an-installed-app).
macOS should use [NSWorkspace application lookup](https://developer.apple.com/documentation/appkit/nsworkspace/urlforapplication%28withbundleidentifier%3A%29)
and [running application observations](https://developer.apple.com/documentation/appkit/nsworkspace/runningapplications?language=objc).
These sources describe adapter design, not implemented Orbit support.

## Capabilities and execution

Probe available interfaces at runtime. Report semantic inspection, semantic actions,
window capture, private input, workspace management and owner input isolation
separately. A successful API connection or installation is not a capability test.

Semantic adapters should use Linux AT-SPI interfaces, Windows UIA control patterns,
and macOS AX actions and attributes. Inspect supported actions before selecting one;
avoid a permanent button index or dependence on one translated label.
[AT-SPI Action](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/iface.Action.html),
[UIA control patterns](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternsoverview),
[AX actions](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction?language=objc).

Use an observe, validate, act, verify loop. Bound tree traversal and API timeouts.
Invalidate destroyed elements and refresh changed state. Verify the intended
postcondition independently of an action's return value. Do not blindly retry
mutations after timeouts: Apple documents that modal action callbacks can time out
even when the action did not fail. Preserve an uncertain outcome until observation
resolves it. [AX timeout semantics](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction?language=objc).

Semantic actions do not universally guarantee unchanged focus. Concurrent workflows
on a shared desktop can interfere. Owner input isolation needs its own evidence;
a virtual workspace is not an independent input seat.
[Microsoft desktop concurrency guidance](https://learn.microsoft.com/en-nz/windows/apps/dev-tools/winapp-cli/ui-automation).

## Implemented private inspection slice

The private Linux desktop adapter exposes `inspect` only when its accessibility
services are available. Obtain a window identity through `list-windows`, then send
`{ "type": "inspect", "windowId": "RETURNED_WINDOW_ID" }` through the session's
normal action API. See [the usage contract](desktop-only.md#read-only-native-inspection).

The result is a bounded read-only snapshot of names, roles, states and parent
relationships. It includes a snapshot identity, empty per-node action lists and
`mutations: "unsupported"`. No document text or callable element actions are
returned. Window and process identities are checked against the private session,
and inherited AT_SPI routing is replaced with the private bus. Unavailable or
ambiguous targets fail explicitly.

An owned GTK3 runtime fixture measured button name/role readback, foreign window
refusal, replacement of inherited AT_SPI routing and helper process cleanup.
Independent review remains pending. This is Limited evidence for inspection,
not completion of the semantic mutation architecture described above, existing
owner acquisition or native control on other operating systems.

## Window management is a separate adapter

Accessibility describes controls and actions. Window systems describe mapped
windows, outputs and workspaces. Keep these adapters separate and correlate exact
identities only when the backend can establish the relationship.

Use supported [EWMH requests on X11](https://specifications.freedesktop.org/wm/latest-single/).
On Wayland, probe advertised protocols and permissions. Foreign toplevel listing
does not grant arbitrary window control. The [workspace protocol](https://raw.githubusercontent.com/wayland-mirror/wayland-protocols/main/staging/ext-workspace/ext-workspace-v1.xml)
does not provide universal arbitrary window movement. The
[RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
provides mediated input, including EIS, but does not promise an independent cursor.
Unsupported compositor operations must remain explicit rather than selecting a
browser fallback or an unverified internal compositor hook.

## Research and validation basis

- [Engineering Software for Accessibility, Microsoft](https://www.microsoft.com/en-us/download/details.aspx?id=19262)
  is a foundational book for accessibility architecture and engineering lifecycle.
  The official listing was reviewed; the full PDF was not readable through the
  research tool. Use current API documentation for implementation details.
- [Sikuli, Yeh, Chang and Miller, 2009](https://dspace.mit.edu/entities/publication/604a3f79-451d-4186-a94e-d12690ffe40a)
  establishes screenshot-based GUI grounding. It informs a visual supplement for
  inaccessible controls, not a claim of focus isolation or universal control.
- [Chang's MIT thesis](https://up.csail.mit.edu/other-pubs/vgod-thesis.pdf)
  includes combining pixels and accessibility metadata. Relevant extracted sections
  were inspected, not the entire thesis.
- [OSWorld, 2024](https://arxiv.org/abs/2404.07972)
  uses real environments, controlled initial states and execution-based evaluation.
  Apply that evaluation principle to Orbit instead of accepting mocked responses
  as evidence that real applications work.

Acceptance should cover moved installation paths, spaces and quoting, disabled or
ambiguous registrations, missing executables, unsupported activation recipes and
private HOME preservation. Subsequent semantic integration needs real application
tests for duplicate names, multiple windows, translated labels, destroyed elements,
modal timeouts, task results and owner focus/pointer preservation. Each platform
and backend is claimed only at its measured tier. Unrun cases are not measured.
