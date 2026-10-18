# Desktop roadmap

Orbit's objective is native application control that discovers the current system,
installation and target identity automatically. It must preserve requested existing
state, report unsupported capabilities, and never substitute a new application or
standalone browser session for an unavailable existing-window operation.

This is the current acceptance plan as of 16 October 2026. Historical browser
milestones and test counts are not current desktop completion criteria. Evidence
uses the definitions in [support tiers](support-tiers.md).

## Implemented foundations

- Desktop-only broker, CLI and MCP admission, with browser automation retired. A panel session
  card opens Orbit's native session window, and a private session can be drawn as a real
  window on the owner's desktop with `visible: true`. Installed runtime activation is a
  separate verification step.
- OS application metadata discovery, with a registration-based Linux route for
  supported new private launches. Installation paths are resolved from current
  registrations. See [application discovery](application-discovery.md).
- Session-scoped private Sway workspace listing, selection and exact window moves.
  Existing owner windows and other desktop environments require separate adapters.
- A compositor handoff release gate that rejects owner activation after the crash.
  Preserve this gate until its [incident requirements](native-handoff-incident.md)
  have been satisfied.

## Remaining acceptance work

1. **Complete adaptive acquisition.** Keep installation identity, running process
   identity, window identity and requested state distinct. Verify supported launch
   recipes across relocated installations and altered XDG paths. Ambiguous,
   disappeared or unsupported targets must fail explicitly. A new private HOME
   must never be reported as preserved owner state.
2. **Review and broaden native accessibility.** Private read-only inspection is
   implemented. An owned GTK3 fixture measured button name/role readback, foreign
   window refusal, replacement of inherited AT_SPI routing and helper cleanup.
   Independent review remains pending. Extend evidence for multiple windows,
   duplicate titles, changing trees and other toolkits. Document text, per-node
   actions and semantic mutations are unsupported. The earlier
   [calculator demonstration](native-desktop-demonstration.md) remains historical
   supporting evidence, not general application acceptance.
3. **Close the existing-owner incident.** Distinguish corrected code from measured
   safety. Follow the source-bound regression, client, isolation and cleanup gates
   in the incident contract on an appropriate isolated environment. Keep owner
   handoff disabled while those gates remain open. Do not bypass a rejected test
   through another agent or route.
4. **Broaden desktop adapters through capability checks.** Preserve the common
   identity and action contract while implementing platform-specific discovery,
   accessibility and window/desktop operations. Windows and macOS native control
   remain unimplemented. Linux private workspace success does not certify other
   compositors or owner workspace movement.
5. **Verify delivery and cleanup.** Run the applicable desktop, installer,
   packaging and safety regressions against the final source. Record skipped and
   unavailable runtime cases. Verify the installed revision separately without
   disrupting unrelated sessions. Publish only claims supported by retained
   evidence and preserve diagnostic records outside release documentation.

The [desktop guide pilot](https://github.com/M7MMAD-OMAR/sbar-orbit/blob/609a000889584a1ddc2bbb7e3a3798792f6fb05d/docs/desktop-guide.md)
remains Limited visual-overlay evidence from one workstation. Its presence does
not complete application acquisition, semantic control or the owner-handoff gate.

Completion requires demonstrated behavior at the stated support tier. A package
version, installation result, passing metadata fixture or overlay is insufficient
to close the remaining runtime requirements.
