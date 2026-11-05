# Snapshot refs and bounded drill-down

Text and combined observations accept `refs:true`, `skeleton:true` and
`root:"@<snapshot>:e<index>"`. Select the exact acknowledged application and
window explicitly. Image-only and passive observations reject these selectors.
A skeleton implies refs. Root queries retain the original window coordinate
system and inherited ancestor scaling, scrolling and toolkit corrections.

Refs are opaque retained-object handles, not role, name or box selectors.
Each private accessibility helper retains at most 4 snapshots and 1024 object
slots, with a maximum lifetime of 30 seconds. Selected provider changes,
provider object/property/state events, process changes, eviction and expiry
invalidate refs. Expiry is checked again after provider I/O. A failed or
incomplete subtree publication preserves earlier snapshots and does not claim
new usable refs. A complete subtree receives its own bounded snapshot.

`STALE_REF`, `INVALID_REF` and `FOREIGN_REF` are explicit failures. Mutation
requires an additional qualified provider lifetime route. Unsupported providers
return `UNSUPPORTED_REF_IDENTITY`; Orbit never selects a similarly named object
or retries an uncertain mutation by pointer. GTK qualification pins the
mapped GTK 4.22.5 exporter and its realization UUID paths on the managed
accessibility bus. Generic read refs and drill-down are available independently
of mutation qualification. The explicit Qt Widgets helper binds primary widgets
before field reads and verifies retained UUID/QPointer routes; see
[Qt qualification](native-input-reliability.md#scoped-refs-and-explicit-qt-widgets-qualification-6-november-2026).
Gecko drill-down does not authorize Gecko semantic mutation.

Skeleton traversal includes containers and child counts. Its intentional depth
boundary uses `descendantsOmitted:true`; that is distinct from an incomplete
observation caused by the node, byte, depth or time budget. Root traversal uses
the ordinary 300-node and 16000-byte output bounds.

## Original Thunderbird acceptance, 5 November 2026

The actual source MCP route opened the original registered Thunderbird with its
normal profile on allocated numbered workspace 6, at 1100 by 760 logical pixels.
It retained the exact launch-bound window and did not present a workspace or
move the owner's pointer. In the existing inbox, a skeleton returned 21 nodes,
complete and without truncation. Rooting its message-list section returned 40
nodes, complete and without truncation. Rooting one particular message-row ref
then returned 6 nodes, complete and without truncation, in 83.948 ms of worker
time. The row's contents and account metadata remain private. This was read-only
traversal, not opening or changing a message. No throughput gain is inferred.

An earlier delayed manual root request correctly returned `STALE_REF`. A later
ordinary full-window text observation fell back to an image with the explicit
reason `accessibility changed during observation (PropertyChange)`; this failure
is retained and is not represented as a capped flat-tree success. The successful
skeleton and two root queries were independently bounded reads without retrying
a mutation. Another earlier newly opened candidate disappeared before handoff;
its two handoff refusals were diagnosed as no exact candidate and no input was
sent. Only after confirming that process and its windows were absent did the
normal registered opening above run.

The exact test window received normal closure, then workspace candidates were
empty, and the own session was stopped. The temporary diagnostic registration
was removed. This does not establish continuous owner-state preservation or
mutation lifetime qualification for Gecko or Qt.
