# CI and build-only verification, 4 November 2026

The source-contract [run 41879617974](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/41879617974)
passed for exact main commit `e38f967c7e3a1305f3772803b38a13faa018e767`.
Ubuntu 24.04, Windows latest, macOS 15 Intel and the bilingual static website
jobs all completed successfully. These are source/build contracts, not native
desktop acceptance on Windows or macOS. The preceding two failures had no macOS
runner assigned; GitHub reported hosted arm64 capacity constraints. This CI now
uses a required Intel runner, not an ARM macOS verification claim.

The build-only [run 41884952150](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/41884952150)
succeeded for source and workflow commit `e38f967c7e3a1305f3772803b38a13faa018e767`,
version `0.4.3`, Bun `1.3.14`. Hosted resource gates, exact identity checks,
full verification, packaging, extracted source/registry checks and bilingual site
build completed. It published no release, registry package, tag or website.

The two workflow artifacts were downloaded into an owner-private temporary
location. Each of the four release files and the site archive was independently
hashed and checked against its receipt and declared length:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `sbar-orbit-0.4.3-source.tar.gz` | 5342591 | `9b2c626262343feb58b066b57953b42d26b1391c8002e5e6adb2dd0e23356ffe` |
| `sbar-orbit-0.4.3.tgz` | 1192603 | `146c2bf49106258a1f9f5e2e74846aab439ed83d3c84c5ab7e496bd19278baaa` |
| `sbar-orbit-site-0.4.3.tar.gz` | 749624 | `412f0cb1e247927cc798c8a81c9e79e40ce97e3b394f2e9c248875151b28fa5e` |

The checksum files also matched their receipt hashes. Both receipts name the same
source/workflow commit; the site receipt states `deployed: false` and the release
receipt states `nativeAcceptance: false`. Hash agreement establishes byte
integrity against those workflow receipts, not independent signing, human review,
publication authorization or complete native application behavior. GitHub warned
that two pinned actions target Node 20 and were run with Node 24.

The [older Windows candidate run 41780007115](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/41780007115)
remains failed at broker readiness. The installer accepted task launch but no
healthy broker endpoint was established; existing content-free evidence does not
identify the exact startup rejection. Task ownership diagnostics after cleanup
are not proof of which live gate failed. No Windows guard or recovery barrier was
weakened, and the owner-operated Windows investigation remains separate.
