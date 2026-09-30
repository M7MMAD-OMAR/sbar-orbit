# Personal application parity contract

Status on 30 September 2026: acceptance contract, source audit and scoped evidence, not a claim
that Orbit meets it. This document does not launch or change any personal
application or profile.

## Required behavior

Orbit's agent must have its own display, windows, pointer, and keyboard while
the person keeps using theirs. Across the applications the person uses, the
agent must see the same account, existing work, settings, and current data, and
must be able to perform the same supported actions, including editing existing
conversations and documents. An intentional edit from either side must become
visible to the other without replacing either workspace. Closing and reopening
the private application must retain that relationship. The person's current
windows and input must not be driven by Orbit.

These are separate properties. A window opening, a familiar theme, a signed-in
footer, and an initial copy of tabs or projects do not establish live parity.
A copied local profile can bootstrap a private window, but bidirectional
updates require a shared application authority or the application's own
collaboration protocol. Each application needs its own measured integration;
the native display alone supplies only input and window separation.

## Current routes and their limits

| Route | Current evidence | Parity limit |
| --- | --- | --- |
| Generic Fedora application | Private Wayland display and input; the backend creates private XDG config, data, cache, and state directories (`src/fedora.ts:136-240`). | A generic launch starts with separate application state. A mapped window does not show the person's sessions or drafts. `launch` selects at most 32 files (`src/fedora.ts:33-97`). |
| Installed Ptyxis | The corrected generic launcher executes commands, accepts private keyboard input, reopens a generated file and retains the inherited Orbit cgroup (`experiments/ptyxis-functional-probe.md`). Six current host settings matched in the normal default shell, and three personal Bash startup settings loaded. A fresh-profile control was rejected; original configuration and history remained unchanged (`experiments/ptyxis-personal-state-probe.md`). | Preferences are an initial copy. Existing tabs, commands, scrollback and live preference changes are not shared. History sharing, containers, SSH sessions, complete file permissions and devices remain unmeasured. |
| Native Nextcloud experiment | One existing account authenticated through a private Secret Service and exact account CONNECT tunnel. Generated files uploaded and downloaded, then edits and deletions propagated in both directions. The owned remote collection was removed and absence confirmed (`experiments/seccomp-nextcloud-app-probe.md`). | This is an experimental broker path, not the generic production launcher. Original sync folders, conflicts, selective sync and arbitrary file permissions remain unmeasured. The socket broker and CONNECT authority are incomplete isolation boundaries. |
| Browser profile clone | An owned browser session can start from a copied profile (`src/clone.ts:92-147`). | The copy is a point-in-time branch. It does not by itself share live tabs, bookmarks, or local state changes with the person's running browser. |
| Zen | The private launcher snapshots the detected profile and starts `--no-remote` on a private display (`src/native-zen-launch.ts:153-241`). | The snapshot is not a live shared profile. Starting Zen against a fresh or wrong profile fails the user's identity and state requirement even if a browser window opens. |
| VS Code | The launcher copies bounded User settings and selected extensions into a private data directory (`src/native-vscode.ts:28-183`). | That does not establish the person's active sign-in, open editors, extension state, or a shared live application session. |
| Codex Desktop | A copied Desktop and fake account displayed an existing saved conversation, submitted a text follow-up, showed the owner's reply, and showed both again after reopening the private window (`experiments/codex-fixture-notification-reopen-evidence.md`). A separate fake turn invoked one Orbit tool on the private display and saved its reply (`experiments/codex-fixture-private-orbit-tool-evidence.md`). After a fake owner restart, an owner-only resume let the private client save one follow-up in a cold conversation (`experiments/codex-cold-owner-activation.md`). | The personal owner has no shared socket, the public gate does not expose the fixture reader or writer, coherent multi-store reads are unimplemented, and general cold-thread activation and full permissions are not measured (`docs/codex-real-attach-review.md`). |
| Files and devices | Native launch can pass selected files, and the private display has scoped device mounts (`src/fedora.ts:33-97`; `src/native-zen-launch.ts:153-241`). | This does not demonstrate full access to every file, application service, or device that the person can use. |

The workstation has many installed application entries, including aliases and
system utilities. This table groups implementation paths, not the person's
actual usage. An unlisted application is not implicitly supported at parity.

## Per-application acceptance gate

1. In a disposable account or profile, record account identity, existing
   projects or documents, relevant settings, and session state before launch.
   Verify the private window shows the same records with stable identifiers.
2. Keep the person-side owner running. Make a change on each side in turn and
   verify the other sees it. Exercise reopening and, where supported, recovery
   after a stopped owner. Measure complete content and actions, not only a
   sidebar title or first frame.
3. Prove the agent uses only its own display and input. Attribute file and
   database changes to intentional owner or agent actions. Reject mixed or
   stale reads, duplicate writes, fresh-profile fallbacks, and silent sign-out.
4. Test the application's tools, files, peripherals, approvals, and failure
   paths at the tier the evidence supports. A missing measurement is `not
   measured`. A failed capability remains a failure until a corrective test
   passes against the same behavior.
5. Only after disposable gates pass, prepare a reversible, application-only
   personal cutover. Any interruption of a running personal application is a
   separate final approval step with its current work and rollback reviewed.

This contract is the user's success criterion. The present state is partial:
Orbit can isolate windows and has app-specific experiments, but it cannot yet
claim full parity for Codex, Zen, VS Code, generic applications, files, and
devices.
