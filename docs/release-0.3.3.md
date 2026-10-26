# Orbit 0.3.3

This maintenance release corrects documentation and agent instructions that still
described retired behavior. Native runtime logic is unchanged from 0.3.2.

## Current guidance

- The discovery guide accepts original browser and terminal registrations while
  preserving the explicit-request rule for the owner's browser or personal profile.
- Opening, native handoff, input, capture and workspace presentation are documented
  as implemented Hyprland capabilities with operation-specific measurements.
- The [documentation index](README.md), [product contract](desktop-only.md) and
  [acceptance index](acceptance.md) distinguish today's operating guidance from
  dated incident, compliance, research and release records.
- Historical failures remain failures. Former policy holds, isolated clipboard
  requirements and browser category prohibitions are not current runtime rules.
- Lease conflicts, physical owner input and ended control are distinguished as
  `APPLICATION_BUSY`, `OWNER_BUSY` and `SESSION_CLOSED`.
- GitHub issue forms ask for current native capability evidence. Security text and
  website documentation no longer imply a shipped viewer or obsolete isolation gates.
- Portable agent skill instructions and UI metadata describe original applications
  on visible numbered workspaces rather than only conversation on/off commands.

## Scope and upgrade

This release does not add a Windows, macOS, other compositor or XWayland control
adapter. It does not turn source CI or a past application measurement into general
compatibility. The [support matrix](support-tiers.md) retains those limits.

Both source and installable packages carry the corrected guides and skills. Refresh
manually installed skill copies and reload the host's supported MCP connection
when its Orbit sessions are idle. A file update does not replace instructions
already cached in an active task. Preserve other work and the running broker.

```sh
bun add -g https://github.com/M7MMAD-OMAR/sbar-orbit/releases/download/v0.3.3/sbar-orbit-0.3.3.tgz
sbar-orbit install --connect auto
```

The plugin source and native input behavior are the same as 0.3.2. A host already
running that matching plugin does not need a plugin rebuild for these documentation
changes. Older sources still require their actual source/ABI checks and safe
upgrade boundary. Publishing this release does not restart a shared service.
