# Empty workspace opening

Owner requirement, 5 November 2026: open original applications on an empty
numbered workspace within 1 to 10 when available, without switching the owner
to it or using a workspace they are working on.

## Implemented

- Automatic selection chooses the lowest empty, undisplayed number in 1 to 10.
  The environment may narrow that range, not widen it.
- A private native inventory reads every compositor client workspace and every
  displayed monitor workspace. It returns only numeric IDs, not owner titles or
  process identities. Unknown or malformed inventory refuses opening.
- Live sessions and previous opening reservations are excluded even for the same
  caller. Uncertain or late-mapping openings are retained for this broker lifetime;
  visible emptiness alone does not authorize clearing that uncertainty.
- Explicit destinations are also checked for windows, display and reservations.
- The worker checks again before exec, including fallback, and before forwarded
  post-map placement. Only the exact attributed candidate may be excluded from
  that placement occupancy check. A newly occupied/displayed destination is not
  moved into; the candidate is returned for inspection instead.
- Exec requests retain silent workspace placement, no initial focus and disabled
  focus-on-activation. Opening never calls presentation or workspace switching.
- Same caller/request identities retain their existing outcome; no uncertain launch
  is retried automatically with a new destination.

## Limits and rollout

Compositor inventory and launch are separate operations, not an atomic reservation
against an owner or another process moving windows concurrently. An application
can still request activation before attribution. No universal owner-focus or
pointer-preservation guarantee is claimed.

The regression fixtures use fake compositor metadata and mocked application
launch boundaries. No original application was launched and no owner workspace
was switched for this change. Updating source does not replace a running broker
instance. Do not restart a shared broker while another task has active work.

## Verification

The exact staged source was exported separately from concurrent unfinished native
changes. Strict TypeScript checking passed. Its complete default verifier passed
1122 tests, skipped 5 and failed 0 across 113 files in 80.41 seconds. The working
tree verifier also passed, but is not substituted for that staged-only evidence.
An initial export run had two installer-fixture failures because its dependency
symlink resolved outside the export; a local dependency copy fixed that fixture
condition. The initial run also had one failure in the pre-existing over-limit
stdin feeder test, which passed on focused and full reruns; that intermittent
failure is not claimed solved by the workspace change.
