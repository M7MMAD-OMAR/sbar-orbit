# Windows signing and SmartScreen

Written 30 October 2026. This page records the signing decision for Orbit on Windows, what the sibling
project Kawaro measured and was told by Microsoft and the SignPath Foundation, and what carries over.
It claims nothing that was not observed. Sources for the Kawaro facts are that project's
`docs/distribution-status.md`, `docs/windows-smartscreen.md`, `backlog/S-083-windows-install-trust.md` and
`docs/signpath-application.md`, last read on the date above.

## What applies to Orbit today

Orbit ships no Windows executable. A release is a source tarball and an npm package with their SHA-256 files; `install.cmd` is inside
the source tarball, and the code runs on Bun. There is no Authenticode target, so there is nothing to sign and no signing
certificate is held. Windows has the shared broker, installer, per user logon task and resource budget only;
the native control adapter does not exist (see [Windows evidence](windows-measured.md)).

Whether SmartScreen prompts for the release tarball or for `install.cmd` extracted from it has not been tested. It is step 8 of
[the Windows manual check](windows-manual-check.md); until someone records the result on a real desktop, no
document says the install is free of a prompt. Whatever a Windows user sees, the safe path is to check the
published SHA-256 first and never turn SmartScreen off.

## What Kawaro found

| Question | Result | Date |
| --- | --- | --- |
| Self-signed test certificate | SmartScreen still warns for other machines; the dialog shows "Unknown publisher" | 2026-10-27 |
| SignPath Foundation (free for open source) | Declined: the program requires public visibility (community adoption, outside articles, sustained engagement), not a judgement of quality | 2026-10-27 |
| Paid SignPath subscription | Judged a poor fit for a one person project | 2026-10-30 |
| EV certificate | Not worth the premium: Microsoft's current guidance says EV no longer bypasses SmartScreen | 2026-10-26 |
| Microsoft Store | Microsoft re-signs the package and shows no warning; free for individuals, but identity verification has not completed, so nothing is listed | 2026-10-30 |
| WinGet | Pull request open and passing automated checks; a silent local install verified the installer hash. Not merged, so not published | 2026-10-27 |

Kawaro's own `CODE_SIGNING_POLICY.md` still says the SignPath approval is pending while its `CLAUDE.md` and
distribution status record the decline. That inconsistency belongs to Kawaro and is not repeated here.

## Lessons that apply once Orbit has a Windows binary

1. Sign only artifacts built from this repository, and generate `SHA256SUMS` after signing.
2. Put an RFC 3161 timestamp on every signature; without one the signature dies with the certificate.
3. Verify each signature right after signing and fail the release on any failure.
4. Keep one signing identity across releases, because reputation accumulates on the certificate, and never
   modify a file after signing it.
5. Submit each release to Microsoft's malware analysis portal (https://www.microsoft.com/wdsi/filesubmission).
6. Do not buy an EV certificate for the sake of SmartScreen.
7. Expect a warning on a new certificate until reputation builds; never promise a date.
8. The free path to a trusted publisher name is the Microsoft Store. The SignPath Foundation route needs the
   public visibility Kawaro was told it lacked, so apply only after Orbit has it.

## Orbit specific constraints

- A helper that injects input or captures the screen will draw antivirus attention whether or not it is signed.
  This is recorded as a risk in [the compatibility plan](windows-compatibility-plan.md), not as a measurement.
- Driving an elevated window needs a UIAccess build, and UIAccess requires a signed binary installed in a
  protected location. Until that exists Orbit must refuse elevated windows by name.
- Orbit must not claim Windows native control, a signed build or a SmartScreen outcome until each has been run
  on a real Windows desktop and recorded with the date, the Windows build and the artifact hash.
