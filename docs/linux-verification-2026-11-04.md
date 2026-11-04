# Linux verification and Windows 11 handoff

Date: 4 November 2026, Asia/Dubai. Tested code: `0c53b8e182817ff990e129414d11dc51523bff42`. Source version `0.4.3` is an unpublished candidate; published stable remains `0.4.2`.

## Verified on Linux

- Strict TypeScript: passed.
- Mandatory default suite: **562 passed, 5 platform skips, 0 failed**, 3102 assertions across 567 tests and 60 files, 67.79 seconds. The Windows task-policy suite is mandatory, including its isolated live-proof fixture worker.
- Focused policy/lifecycle/installer/packaging suite: 105 passed, 1 Windows-only skip, 0 failed.
- Canonical packaging tests: 12 passed, 0 failed. Source graph refreshed.
- Local heavy commands ran serially after fresh resource checks, under a 1536 MiB memory, 150 percent CPU, 256-task, zero-swap ceiling. Smaller packaging/graph checks used a 768 MiB ceiling. No owner process was stopped to obtain capacity.

The [clean Ubuntu 24.04 build](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/41781310218) passed in 3 minutes 6 seconds from the same immutable source and workflow commit. Its aggregate receipt confirms strict types, default and packaging tests, source manifest, registry source receipt, frozen dependency installation, packaged launcher help, preflight contract and non-activating install dry-run. It used Bun `1.3.14` and an enforced 1536 MiB / 150 percent CPU / 256-task / zero-swap budget.

The clean-host counts are separate from the local counts: **561 passed, 6 skipped, 0 failed**, 3098 assertions, 567 tests across 60 files in 69.59 seconds. Hosted packaging had 17 passes and 0 failures; website tests had 10 passes, 0 failures and 284 assertions, with typecheck and build also passing. The additional hosted skip was the stale Flatpak branches/deployments fixture. The full skip names are retained in the machine-readable record, without guessing why a host skipped a case.

The site was built only, not deployed. Its candidate download list assumes Windows assets that are not qualified or published; Linux-green evidence is not authority to deploy those unavailable links.

## Immutable candidate artifacts

These are verified CI build artifacts, not a newly published GitHub or npm release.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `sbar-orbit-0.4.3-source.tar.gz` | 5120631 | `1daf14984fc6ff490cc87684ea411ce1626c18f468429c70d6f74d7fd65a655f` |
| `sbar-orbit-0.4.3.tgz` | 1044887 | `5592effc815316eaa25ef39548c33f538ee0030d3e3cf726f86138687ce80219` |

The source manifest and registry receipt bind both artifacts to the tested commit. The two archives and both checksum sidecars were independently rehashed after download and matched the aggregate receipt in bytes and SHA-256. All four exact file records are retained in the JSON evidence. Dirty owner instructions and unrelated untracked files were not publication inputs. Full machine-readable evidence is in [the verification record](linux-verification-2026-11-04.json).

## Limits and preservation

This is source and artifact verification, not new original-application end-to-end acceptance. No live desktop input/capture campaign or throughput benchmark was rerun in this round. No 80 percent saving, application-effect guarantee or Meta-ban immunity is claimed. No shared broker restart, profile copy, owner-window control, security disabling or unknown managed-state deletion was performed. The hosted receipt explicitly sets `nativeAcceptance: false`.

## Windows work is handed off, not declared successful

The owner requested that further Windows testing happen on a separate, owner-operated **Windows 11** laptop with its own DeepSeek agent, and that defects be reported as sanitized GitHub Issues. Windows CI and remote-connection work stopped here. No remote connection, keys or credentials were created.

The last actual [Windows run](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/41780007115) still failed positive installation at `health / broker-not-ready`, central exit `1`. Successful GUI, installed tamper tests, native MCP/update lifecycle, activation/rollback and uninstall acceptance are not established. Old pure ownership diagnostics are not measurements of the new live semantic guard. Windows native original-application control remains unsupported.

Give the Windows agent [the handoff document and copyable Arabic prompt](windows11-agent-handoff.md). It identifies valid local source/GUI compilation steps, the current hosted-only full-Setup harness limitation, preservation boundaries, existing issue forms and required evidence. Unsupported local paths must be reported rather than bypassed. Search for duplicates, record actual tested SHA and OS/tool versions, distinguish observations from hypotheses, and never upload raw task XML, accounts, SIDs, private paths, secrets, profiles or unredacted logs.

When the owner returns with issue links, the maintainer can review, reproduce and coordinate verified repairs. No continuous background issue monitoring is promised. No new release, tag, npm publication, website deployment or Windows binary upload occurred in this verification round.
