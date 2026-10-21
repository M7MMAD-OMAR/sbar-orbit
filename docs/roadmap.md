# Native desktop roadmap

Updated 22 October 2026. The goal is original application work on an explicitly
selected visible workspace. This is a development plan, not a compatibility claim.

1. Restore trustworthy input delivery and capture without risking the person's
   compositor. The [incident](native-handoff-incident.md) release gate remains held.
   A successful IPC reply must be matched by an actual application state change,
   visible pointer evidence, owner focus and pointer checks, and verified handback.
2. Extend registered opening using real application failures. Retain exact launch
   ancestry, normal owner state, custom floating geometry and precise test cleanup.
   Single-instance forwarding and applications with minimum sizes need explicit
   results rather than an inferred successful opening.
3. Implement desktop adapters for GNOME, KDE, other Linux compositors, Windows and
   macOS. Each needs platform-native consent, target identity, observable effects,
   visible workspace behavior and lifecycle handling. There is no fallback to a
   browser or another user profile.
4. Run application tasks on real machines for each supported host class. Test
   opening, editing a disposable document, saving, reopening, account continuity
   where relevant, window cleanup and normal owner activity during agent work.
5. Publish per-operation evidence and failure limits in the support table before
   enabling a platform claim. CI, installation and source review are supporting
   checks, not substitutes for real application acceptance.

Browser/private session code and obsolete viewer assets were removed. Their old
results remain in Git history, and cannot close these native milestones.
