# Windows runtime delivery v2: direct upstream acquisition

Design only, 4 November 2026. No runtime, installer or workflow changes are authorized by this document. The immutable a777900 private bundled CI run can finish unchanged. This design replaces the public bundled-Bun route; it is not legal clearance, a source offer, or proof that runtime acceptance passed.

## Invariants

- Public Setup and desktop overlay contain **no Bun executable, official Bun ZIP, renamed copy or Bun-compiled bootstrap**. License text and digest metadata are not executable payloads.
- The native installer obtains explicit initial download consent. Normal GUI launch, MCP startup and configuration generation never silently download or search PATH for a runtime.
- Acquisition is from the exact fixed official upstream release or an explicitly supplied matching official archive, into private per-user staging. No global installation, profile copy, arbitrary URL or remote-script execution.
- The updater may hash-check and copy an existing private runtime or fetch directly from upstream. It cannot activate until source, GUI, CLI, runtime, receipt, dependencies and final seal are complete. An acquisition failure leaves current and the owned task unchanged.
- Existing off preferences, active/starting work, SID/task/runtime admission, exact health, rollback and persistent recovery barriers remain unchanged. Windows pruning stays disabled before any deletion.
- .NET/WebView2/dependency notice delivery remains a separate public-artifact gate. Avoiding Bun redistribution does not certify other licensing terms.

## Compatibility decision

Use desktop manifest schema **2** and bootstrap protocol **2**. The private v1 native parser only understands schema 1, so advertising schema 2 as compatible protocol 1 would permit retaining a host that cannot start the next broker. No automatic v1-to-v2 transition is allowed: defer before mutation and require an explicit idle migration/installer procedure. First public v2 adoption is fresh-root only. The existing private v1 run remains evidence for v1, not for v2.

Future protocol-2 hosts can be retained on a real sharing violation only after the existing executable and its protocol-2 sealed origin are validated. Do not close an initialized MCP connection to overwrite its image. All Windows versions remain on disk; origin alone is not a complete liveness proof.

## Managed namespace

Use the corrected native Windows managed root: %LOCALAPPDATA%/sbar-orbit/managed. Stable bin, current pointer, versions and activation metadata belong there. Ordinary application state/workspaces remain under the parent %LOCALAPPDATA%/sbar-orbit namespace and are not evidence that the managed root is already occupied. Initial consent, download and pre-materialization staging stay outside the fresh managed root until central admission owns it. Prepared-root derivation and Linux layout are unchanged. The v1 namespace correction is separate from this v2 delivery design.

## Schema 2

```ts
type RuntimeSourceV2 = {
  kind: "bun-official-zip";
  version: string;                 // exact stable Bun semver, not Orbit version
  platform: "win32";
  arch: "x64";
  url: string;                     // exactly reconstructed fixed official URL
  archiveSha256: string;           // 64 lowercase hex
  archiveBytes: number;            // exact positive bounded archive length
  archiveEntry: "bun-windows-x64/bun.exe";
  executablePath: "runtime/bun.exe";
  executableSha256: string;        // required actual digest, never a placeholder
  executableBytes: number;         // exact positive bounded executable length
  license: { url: string; sha256: string };
};
type DesktopManifestV2 = {
  schema: 2;
  bootstrapProtocol: 2;
  version: string;                 // exact Orbit version
  platform: "win32";
  arch: "x64";
  sourceRevision: string;
  sourceDigest: string;
  runtimeSource: RuntimeSourceV2;
  files: { path: string; sha256: string }[];
};
```

Initial upstream pin: Bun 1.4.4 at https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-windows-x64.zip, archive SHA-256 cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5. The license URL is https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.4/LICENSE.md, SHA-256 362fe32c954ec829240bd7429c53d705eef08c6bfa45ffc2d02005f857cba4dd.

The metadata-only receipt from [private Windows run 41752689533](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/41752689533) measured executable SHA-256 cb1d8e6564e655e49d30cead359750a1cbbd12f42651caa4b62244d7bd93c244, 115281496 executable bytes and the exact archive member bun-windows-x64/bun.exe. The official GitHub asset API reports 54731706 archive bytes; acquisition must verify that expected length against the downloaded bytes. These facts qualify the upstream runtime pin, not schema-2 native GUI or activation acceptance. Later versions require reviewed descriptor pins; no latest/canary URL.

The URL parser reconstructs github.com/oven-sh/bun/releases/download/bun-vVERSION/bun-windows-x64.zip from the validated version. Reject credentials, custom hosts/ports, fragments, initial queries and alternate paths. License URLs are likewise fixed-version raw upstream URLs. Allow only bounded HTTPS redirects to the official GitHub release/CDN host set, never to a descriptor-provided arbitrary host. Pin checks establish integrity within the reviewed feed, not independent code signing.

## Public hole versus complete private payload

The public archive contains only desktop/windows-app/** and desktop-manifest.json. Its manifest files list describes the **final** overlay: GUI/launcher/UI/notices plus exactly one runtime/bun.exe entry. That entry's digest must equal runtimeSource.executableSha256.

Use separate APIs, not a general allowMissing boolean:

```ts
parseDesktopManifestV2(json, expectedVersion): DesktopManifestV2;
validatePublicDesktopOverlay(dir, expected): Promise<VerifiedPublicOverlay>;
mergePublicDesktopOverlay(verifiedOverlay, sourceStage): Promise<void>;
materializeWindowsRuntime(sourceStage, descriptor, acquisitionContext): Promise<RuntimeReceiptV2>;
validateDesktopPayload(sourceStage, expectedVersion, sourceDigest): Promise<CompleteDesktopPayload>;
```

The verified/complete results are module-produced validation results, not authority asserted by JSON booleans.

Public validation requires the actual regular-file set to equal files minus exactly runtime/bun.exe. Reject any runtime subtree, bundled Bun archive/executable, any other missing file, extra file, reparse/link, source collision or casefold duplicate. Retain existing file/byte/depth/path/CRC/overlap bounds and fresh canonical quarantine. The packager must take GUI publication and descriptor metadata inputs, not a private merged directory. Audit output member hashes for renamed known Bun binaries/archives as well as forbidden paths; an expected filename list alone is not a no-Bun publication proof. Do not use bun build --compile for the first installer helper.

Private final validation requires all expected overlay bytes including runtime/bun.exe, its exact binary digest and a regular bounded runtime-source-receipt.json outside the runtime directory. No other runtime files are accepted. Keep Bun's pinned license/index text under the public GUI notices tree and verify its digest. Only after full validation may production sealing, file inventory, pointer activation and exact broker health run.

## Private runtime acquisition

The receipt records schema 2, Orbit/Bun versions, exact URL/archive/executable hashes and paths, acquisition kind (upstream download, supplied verified archive, or verified private cache copy) and descriptor ID. It is an audit record, not consent, publisher authentication or provider capability proof. The trusted materializer computes hashes; manifest fields cannot assert that validation occurred.

Define descriptor ID as SHA-256 of the ordered length-prefixed UTF-8 values: kind, Bun version, platform, arch, URL, archive SHA, decimal archive byte length, archive member, executable path, executable SHA, decimal executable byte length, license URL, license SHA. These are exactly thirteen values; both size strings use invariant ASCII decimal notation. Each value is encoded as decimal byte length, colon, then bytes. Publish shared conformance vectors for native and Bun implementations.

Cache candidates are restricted to canonical regular files in this user's admitted prepared runtime/cache roots, matching the expected executable digest. Verify before and after copying into an exclusive new stage. No hardlinks, junctions, global Bun discovery or overwrite of a mapped old runtime. A cache receipt never replaces byte verification.

Download into an exclusive private temporary archive, stream hash while enforcing length/byte limits, verify the archive hash, then extract only the confirmed official member. Proposed bounds: 128 MiB compressed, 256 MiB executable/expanded data, at most 32 archive entries, depth 8, bounded metadata and a 5-minute total deadline; one attempt per operation. Confirm actual pinned layout before freezing those limits. Reject traversal, links/reparse kinds, reserved names, ADS, case collisions, overlap, malformed/truncated data, unsupported ZIP forms and extra executable members. Check fresh available memory/disk space before download/extraction; never kill owner processes to make room.

## Native first-install sequence

1. A native .NET Framework/Inno helper runs without Bun. Verify public source/GUI inputs, descriptor and notice packet. The helper itself contains no embedded Bun engine.
2. Show the exact upstream runtime/version, network requirement and vendor terms link. Require explicit download consent, or an explicitly supplied official ZIP that matches the same pin. Keep this consent in private installer staging until central bootstrap owns the fresh managed root; do not create unexpected root files before fresh-root admission.
3. Acquire privately with the same URL/hash/layout/bounds policy and create a receipt. Normal app start cannot enter this acquisition mode.
4. Run only the verified private Bun and verified central source installer with the complete private payload. Existing fresh-root/task/SID/endpoint/barrier/health checks own all managed changes. The native helper does not independently register tasks, write current or announce installed success.
5. Refusal, cancellation or missing prerequisite returns an explicit failure; no partial current/task installation. WebView2 prerequisite handling stays friendly, with no silent global runtime download.

An explicit unattended installer flag can represent the operator's download consent; a descriptor field or test-only bypass cannot. Automatic acquisition authority comes only from the existing explicit automatic-update setting and its final off recheck, not from downloaded data.

## Update sequence

Select the existing mature same-line npm candidate and mature fixed-repository GUI-only asset. Verify source identity and all public files; merge exclusively into source staging. Then copy a matching private runtime or fetch upstream, verify the complete final payload/receipt, restore frozen dependencies, seal the final canonical runtime path and create the inventory. Only the existing admitted activation transaction can switch the pointer. Missing runtime, denied acquisition, hash failure, timeout or insufficient resources defers the complete GUI/CLI/runtime update. Loaded GUI/MCP processes are not force-replaced.

## Proposed disjoint implementation split, subject to Lead approval

- **Runtime/validation owner:** new src/windows-runtime-source.ts and, if sharing the existing extractor, new src/windows-zip.ts neutral leaves; schema/validators/public ZIP policy in [windows-desktop-update.ts](../../src/windows-desktop-update.ts); full private checks/protocol 2 in [windows-bootstrap.ts](../../src/windows-bootstrap.ts); integration in [windows-managed-install.ts](../../src/windows-managed-install.ts) and [update.ts](../../src/update.ts); matching native connector protocol validation and owned source fixtures. No lifecycle-to-installer edge or weakened architecture test.
- **Native/packaging owner:** desktop/windows/** and packaging/windows/** native first acquisition and consent; shared pre-execution checks; scripts/package-windows.ts public GUI-only output and no-Bun audit; exact Microsoft/vendor notice inclusion; packaging/acceptance fixtures. Current task31 frozen run stays unchanged. Coordinate shared descriptor fields before either side edits.
- **Lead/integration:** workflow publication gates, source/release documentation and version. Reports-only remains until notice inventory, no-Bun audit, real build/install/IPC/MCP/GUI/version-transition evidence and owner-approved release gates pass.

Required dependency direction: ZIP primitives import only node builtins; runtime-source imports those primitives, not desktop validation or install/lifecycle; desktop validation may import runtime-source; bootstrap validation imports only lower verification leaves; lifecycle imports bootstrap; installer orchestrates lifecycle and those leaves. Neither ZIP nor runtime-source may import installer, lifecycle, broker or IPC. This explicitly avoids recreating the architecture cycle already fixed. If extraction code is shared, move the bounded parser into the neutral ZIP leaf with two narrowly fixed policies rather than having runtime-source import desktop-update.

Private CI may materialize full ephemeral payloads to exercise actual APIs. It must not upload those payloads, the runtime archive/cache or an installer embedding them. Only qualified public no-Bun outputs and sanitized evidence can be considered for publication; do not label v1 bundled evidence as schema-2 acceptance.
