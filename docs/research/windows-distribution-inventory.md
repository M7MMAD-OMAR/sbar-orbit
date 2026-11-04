# Windows candidate vendor-distribution inventory

Text and metadata inspected on 4 November 2026. This is an engineering inventory and publication gate, **not legal clearance, a jurisdictional conclusion, or an assertion that an upstream distributor is noncompliant**. No binary, archive contents, build or relink was inspected or executed for this audit.

## Publication gate

**Redistribution of the bundled candidate remains blocked pending a qualified, fulfilled materials/notice route.** This includes Setup EXEs, overlay ZIPs and public GitHub Actions artifacts containing vendor binaries. Calling a bundle a CI artifact instead of a release does not remove this gate. Source and nonbinary evidence do not constitute approval to distribute the bundle.

Bun's statically linked LGPL components are the immediate unresolved item. Version-matched .NET/WebView2 notice delivery also needs an actual published-file inventory. Successful checksums, source tests and runtime acceptance are separate gates, not license clearance.

## Exact pins and inspection boundary

The repository [build pins](../../desktop/windows/build-pins.json) select:

| Component | Pin | Inspected here |
| --- | --- | --- |
| Bun | 1.4.4 Windows x64 ZIP; SHA-256 cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5 | [Release metadata][bun-release] agrees; ZIP bytes/members were not downloaded. |
| .NET | SDK 10.0.403; self-contained runtime 10.0.14 | Version-tagged license/notice texts below, not emitted runtime-pack files. |
| WebView2 SDK | Microsoft.Web.WebView2 1.0.4314.35 | [Pinned catalog][wv-catalog], package license page and notice filenames, not NUPKG bytes. |

The catalog's WebView2 SHA-512 is cOaiVqP3BmQHMnxGpZzANM22tUXgycrisyJHjIGNzIaMsm8iXj7Kx+ceYg+RbYwJtzT009qfcFTocvVLY+ekMw==, matching the pin. Metadata agreement is not this audit's verification of downloaded binary contents.

## Bun: MIT does not describe the whole executable

The complete [Bun 1.4.4 license/index][bun-license] hashes to **362fe32c954ec829240bd7429c53d705eef08c6bfa45ffc2d02005f857cba4dd**, matching the requested SHA-256. The [tag reference][bun-ref] resolved to commit 38afee6c84fcf48c0edb2466aa4b27d287a59c30.

The file says “Bun itself is MIT-licensed.” It also explicitly says Bun **statically links JavaScriptCore and WebKit**, and that WebCore files are LGPL2. Do not describe the entire executable as MIT-only. Preserve upstream license/copyright notices rather than inventing a replacement MIT attribution.

Upstream provides source-build relink instructions: clone the patched WebKit fork, run bun sync-webkit-source, then bun run build:local. It says this compiles JSC and Bun's C++ bindings, the objects using JSC. These instructions were read, not executed. The pinned [build definition][webkit-build] selects WebKit commit d6375c72affe0f70222cdcb45012b10f0bf3a9d5 and distinguishes prebuilt/local builds and ABI-dependent debug/LTO/ASAN profiles. It also identifies Windows static ICU libraries.

### Actual component texts

| Material | Observed text |
| --- | --- |
| [JSC COPYING.LIB][jsc-copying] | GNU **Library** GPL version 2, June 1991. Full-text SHA-256 5094ecb9c9dcd0eadc34f3c11511d9b5535063032bc150164ecd1a5d5a445547. |
| [JSC ArrayPrototype header][jsc-header] | Copyright notices and version-2-or-later LGPL language. Header inspected; the larger response was truncated, so no full-file hash is asserted. |
| [WebCore LGPL-2][wc-2] and [LGPL-2.1][wc-21] | Both texts are present. File-specific notices/version choices cannot be silently collapsed. |
| [WebCore Apple notice][wc-apple] | Separate permissive source/binary copyright, conditions and disclaimer. Not every WebKit file has one license. |
| [Bun TinyCC definition][tcc-build], [configuration][bun-config], [TinyCC COPYING][tcc-copying] | Commit 05f0fafaa3be31e31d7b4b5c17dc60f62c991171, a Bun patch, Windows-specific C sources, LGPL 2.1. Default configuration excludes Android/FreeBSD, not Windows. This additional LGPL component cannot be omitted from review. |

JSC's version-2 section 6 requires prominent library/license notice and a license copy. Subsection 6(a) describes complete corresponding modified library source plus the work using it **as object code and/or source code**, with data/utilities needed to reproduce and relink. Source is expressly an alternative; absence of a separately named object ZIP is not alone evidence of upstream noncompliance.

The text also provides written-offer and equivalent-access alternatives. LGPL 2.1 has its own section-6 alternatives and numbering. **Orbit has made no written source offer, no three-year undertaking and no promise on Oven's behalf.** A repository link or debug/PDB package is not automatically a fulfilled route. This inventory does not decide legal sufficiency for a particular distribution.

### Available versus unqualified materials

- Available as text/metadata: exact Bun source tag/commit, patched WebKit commit, TinyCC commit and Bun patch/build references, relink instructions and license texts.
- [Bun release metadata][bun-release] lists platform binary/profile ZIPs and checksum/signature files, without a separately named application-object/relink kit. Automatic source-archive URLs exist; their members/completeness were not inspected.
- [Pinned WebKit release metadata][webkit-release] lists Windows amd64 regular, debug, ASAN and LTO prebuilt archives. The build definition names JSC/WTF/ICU libraries. These archives were not downloaded. Their existence does not establish delivery to Orbit recipients of all matching Bun bindings, patched sources, generated inputs, utilities and link options.
- Still unqualified: choose and actually fulfill a redistribution route, identify exact archive contents/build flavor, supply applicable notices/license copies, and associate complete corresponding source and work-using-library/relink materials with the redistributed bytes. This document does not supply that package.

The upstream index also lists BoringSSL/libarchive mixed notices, Apache components, Windows libuv, ICU, polyfills and numerous ports. This focused review is not an exhaustive target SBOM or notice bundle.

## .NET 10 self-contained desktop

Version-tagged [.NET runtime][net-license], [Windows Desktop][desktop-license] and [WinForms][forms-license] MIT texts retain .NET Foundation/contributor copyright, permission and disclaimer. The [runtime notices][net-notices] explicitly describe other-license components. Associate [WPF notices][wpf-notices] with WPF components if actually present in the published Desktop runtime pack; do not infer absence solely from using WinForms.

| Inspected text | SHA-256 |
| --- | --- |
| Runtime MIT | cfc21f5e8bd655ae997eec916138b707b1d290b83272c02a95c9f821b8c87310 |
| Runtime third-party notices | 66f1d4e44973185519bb4aa8a9718eb22fc7af2cc532e3ae9cfc4c127ee7fc54 |
| Windows Desktop / WinForms MIT | ae48df11a335dc1a615f4f938b69cba73bcf4485c4f97af49b38efb0f216353b |
| WPF third-party notices | d23dba2fee20c6b59d8f7088ee9ed372459c952a319b7ca90f3eec370cc76eb9 |

These hashes identify upstream texts, not the emitted publish directory. Inventory actual runtime-pack files and notices and confirm they survive publish, overlay and installer assembly. Do not assume MSBuild automatically copies all notices. SDK build tools and the existing Windows .NET Framework used by the thin launcher are distinct from the bundled .NET 10 runtime.

## WebView2 SDK and browser runtime are separate

The [pinned catalog][wv-catalog] declares **LICENSE.txt (1,487 bytes)** and **NOTICE.txt (3,894 bytes)**. The [version-specific license page][wv-license] reproduces Microsoft's three-clause BSD-style text: source notice retention; binary reproduction of copyright, conditions and disclaimer in distribution materials; no Microsoft/contributor endorsement without permission. This is the inspected SDK license, not an assumption that it is MIT or the browser runtime license.

NOTICE.txt's existence is confirmed by catalog metadata; **its contents were not retrieved** in this text-only audit. Carry both files from the restored exact package into the notice bundle and record their actual hashes. The license page's changing HTML nonce makes its HTML digest unsuitable as a license-file byte pin.

Evergreen WebView2 is currently an existing prerequisite, not silently bundled/downloaded. Any later Evergreen or Fixed Version runtime distribution needs separate terms/notice review. Offline JavaScript production dependencies likewise need an exact package notice inventory. None is cleared by the top-level .NET/Bun license label.

## Proposed next step if Bun materials cannot be qualified

**Do not republish Bun.** A native installer/bootstrap can, with explicit download consent, fetch the exact official upstream Bun ZIP, verify its pinned hash and bounded expected entries before execution, and stage the runtime privately on the user's machine. Updates can fetch the matching upstream runtime directly and still stage complete GUI/CLI/runtime payloads before atomic activation. No global Bun installation, PATH fallback, personal-profile copy or unpinned remote-script execution is needed. An explicit offline prerequisite can be offered instead.

This is a proposal only: first-install native bootstrap and an approved external-runtime receipt/manifest must replace the current bundled-runtime contract. A Bun-compiled bootstrap itself embeds Bun and does not avoid the issue. CI downloading upstream and repacking those bytes into Orbit's Setup/overlay/public artifacts is **still republishing**, not this alternative. .NET/WebView2/dependency notice delivery remains necessary. Direct acquisition is a technical distribution change, not legal clearance or permission to ignore upstream terms.

[bun-license]: https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.4/LICENSE.md
[bun-ref]: https://api.github.com/repos/oven-sh/bun/git/ref/tags/bun-v1.4.4
[bun-release]: https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.4
[webkit-build]: https://raw.githubusercontent.com/oven-sh/bun/38afee6c84fcf48c0edb2466aa4b27d287a59c30/scripts/build/deps/webkit.ts
[jsc-copying]: https://raw.githubusercontent.com/oven-sh/WebKit/d6375c72affe0f70222cdcb45012b10f0bf3a9d5/Source/JavaScriptCore/COPYING.LIB
[jsc-header]: https://github.com/oven-sh/WebKit/blob/d6375c72affe0f70222cdcb45012b10f0bf3a9d5/Source/JavaScriptCore/runtime/ArrayPrototype.cpp
[wc-2]: https://raw.githubusercontent.com/oven-sh/WebKit/d6375c72affe0f70222cdcb45012b10f0bf3a9d5/Source/WebCore/LICENSE-LGPL-2
[wc-21]: https://raw.githubusercontent.com/oven-sh/WebKit/d6375c72affe0f70222cdcb45012b10f0bf3a9d5/Source/WebCore/LICENSE-LGPL-2.1
[wc-apple]: https://raw.githubusercontent.com/oven-sh/WebKit/d6375c72affe0f70222cdcb45012b10f0bf3a9d5/Source/WebCore/LICENSE-APPLE
[webkit-release]: https://api.github.com/repos/oven-sh/WebKit/releases/tags/autobuild-d6375c72affe0f70222cdcb45012b10f0bf3a9d5
[tcc-build]: https://raw.githubusercontent.com/oven-sh/bun/38afee6c84fcf48c0edb2466aa4b27d287a59c30/scripts/build/deps/tinycc.ts
[tcc-copying]: https://raw.githubusercontent.com/oven-sh/tinycc/05f0fafaa3be31e31d7b4b5c17dc60f62c991171/COPYING
[bun-config]: https://raw.githubusercontent.com/oven-sh/bun/38afee6c84fcf48c0edb2466aa4b27d287a59c30/scripts/build/config.ts
[net-license]: https://raw.githubusercontent.com/dotnet/runtime/v10.0.14/LICENSE.TXT
[net-notices]: https://raw.githubusercontent.com/dotnet/runtime/v10.0.14/THIRD-PARTY-NOTICES.TXT
[desktop-license]: https://raw.githubusercontent.com/dotnet/windowsdesktop/v10.0.14/LICENSE
[forms-license]: https://raw.githubusercontent.com/dotnet/winforms/v10.0.14/LICENSE.TXT
[wpf-notices]: https://raw.githubusercontent.com/dotnet/wpf/v10.0.14/THIRD-PARTY-NOTICES.TXT
[wv-catalog]: https://api.nuget.org/v3/catalog0/data/2026.10.23.06.50.10/microsoft.web.webview2.1.0.4314.35.json
[wv-license]: https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4314.35/License
