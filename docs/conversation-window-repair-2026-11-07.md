# Conversation and window preservation repair

## Reported behavior

The installed service and adapters were version 0.4.4, matching the latest
published release. Native opening repeatedly returned `CONVERSATION_REQUIRED`.
The owner also reported resizing during execution and disruption of other work.

## Confirmed causes

1. Codex's app-server launched MCP children without a conversation environment.
   The broker requires stable conversation ownership before native opening,
   but MCP tools had no argument for supplying it. `orbit_usage` reported
   connection scope, confirming the missing binding.
2. A real Hyprland client on a special workspace reported its workspace as
   `{address: "special:special", type: "special", name: "special:special"}`,
   without a numeric `id`. The inventory rejected this reply and prevented
   opening before any launch. The private worker traceback identified
   `workspace_inventory`, independently of the identity failure.
3. The production plugin copied the selected floating window's size into the
   application lease. New sibling and parented-dialog rule hooks then forced
   floating, centering and parent-sized dimensions on every static rule recheck.
   Handback could also write saved geometry after toolkit or owner changes.

## Changes

Every global and session MCP tool accepts an optional actual `conversationId`.
The adapter holds identity and usage checks per invocation, strips the argument
before dispatch, and rejects attempts to replace a fixed binding. Concurrent
calls, reconnects and CLI operations use the same exact ownership and off state.
Explicit malformed environment IDs never fall through to another scope.

Invocation environment precedence is `ORBIT_CONVERSATION_ID`,
`T3CODE_THREAD_ID`, `CODEX_THREAD_ID`, then `HERMES_SESSION_ID`. Shared hosts
without these values pass the actual host ID on every call. An already loaded
old adapter requires host connection reload; the documented installed CLI path
uses the same actual scope and checks both connection-local and persisted off.

Inventory accepts explicitly consistent special-workspace objects as
nonnumbered occupancy and still refuses malformed or contradictory identities.
The corrected parser read the live desktop as occupied workspaces `[1, 2, 4]`
and shown workspaces `[1, 2]`, without changing any window or workspace.

Application leases no longer infer or repeatedly impose sibling/dialog sizes.
Initial bounds belong to explicit opening only. Rule refresh and handback
preserve mapped window geometry and workspace. Automatic workspace routing is
limited to new unmapped windows with a verified parent in the controlled
application and is suppressed during pause or owner input. Uncorrelated
top-level siblings retain their own placement, including delayed owner windows.

## Verification and deployment

Identity regression tests failed on the original implementation before passing
after repair. Coverage includes concurrent calls, reconnect, fixed-identity
conflicts, connection-local off, persistent off, read delivery, CLI environment
inference and a missing-identity preflight that dispatches nothing.

The first complete identity suite passed 1178 tests, skipped 7 and failed none.
Subsequent inventory and window-preservation changes require their own final
verification recorded below; this earlier total does not prove them.

The stable local launcher now selects the existing main checkout, and installed
Codex/Agents skill copies receive the current same-scope CLI fallback guidance.
The shared broker and loaded plugin were left running while a separate
publishing task held an active lease. After it ended, broker update admission
was acquired. Plugin unload confirmed admission paused, zero live roots,
zero tracked scopes, no legacy enrollment and readiness before unloading.
The new pinned plugin was refreshed and the idle broker restarted from main.
`native-check` confirmed compositor, plan, build and loaded plugin agreement.

The plugin was compiled against the running Hyprland 0.57.1 commit
`acc1aa0bfd4bd575dcb0f76c35ccf12b660a1ab9`.
Loaded source SHA256:
`7fdb55980c767f2b4433b9d4431c49ebb22834050ad4039acaf1504bf7293289`.
Binary SHA256:
`d4100ce5e6c2e5ac3f726d4466d25c6033deaeb2bea71cd358ed971ea95040a8`.

## Original application acceptance

A fresh installed stdio MCP process was deliberately launched without any of
the supported conversation environment variables. All schemas exposed
`conversationId`. Calls used the actual host thread ID; usage reported
conversation scope. Original `org.gnome.Calculator.desktop` opened on allocated
workspace 3 at requested 420 by 640, with a launch-ancestry-bound identity.
Exact handoff returned the matching conversation owner and selected window.

An application menu interaction opened a second Calculator top-level window.
It retained independent 945 by 1154 geometry rather than inheriting 420 by 640.
Its rendered capture was inspected, a native key inserted `7`, and the next
state still reported window geometry 945 by 1154. The original window later
reported 420 by 641: toolkit negotiation remains observable and is not claimed
to be eliminated by this repair. This run did not exercise a separate native
dialog or prove permanent geometry stability in every application.

Each test window was closed by its exact acknowledged handle. Refresh showed
only the original after closing the sibling; final workspace candidates were
empty. Own-session stop succeeded with no failures. Monitor samples before,
during and after stayed eDP-1 focused on workspace 1 and HDMI-A-5 on workspace 2.
No agent workspace presentation was requested. These samples are not a claim
of continuous owner focus or physical-pointer preservation.

One complete verification run had a 5-second timeout in the
existing update activation fixture; its focused rerun passed all 26 update
tests, with the timed-out case completing in 335 ms. The final complete rerun
passed 1178 tests, skipped 7 platform-dependent cases, failed none, and completed
in 98.86 seconds. Frozen dependency installation, budgeted TypeScript checking,
matching-ABI plugin compilation and `git diff --check` also passed.
