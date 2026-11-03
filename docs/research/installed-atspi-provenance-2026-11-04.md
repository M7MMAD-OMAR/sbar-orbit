# Installed GTK/libatspi provenance: 4 November 2026

Read-only RPM metadata, file hashing, ELF notes and pinned source review. No GI/AT-SPI initialization, application/session reads, screenshots, tests, package installs, source-RPM extraction or provider activation. This narrows the [earlier upstream-main audit](atspi-identity-lifetimes.md); it does **not** enable public refs or semantic writes.

## Installed artifacts, not just version strings

| Package | Installed NEVRA | RPM-reported source | ELF build ID |
| --- | --- | --- | --- |
| GTK4 | `gtk4-0:4.22.5-2.fc44.x86_64` | `gtk4-4.22.5-2.fc44.src.rpm` | `b3413ec96610368a1281548155c59bce1fb47735` |
| AT-SPI | `at-spi2-core-0:2.60.7-1.fc44.x86_64` | `at-spi2-core-2.60.7-1.fc44.src.rpm` | `095149257f9aa3e80cb4f0665c3bd4ada95af546` |

Measured SHA256 of regular installed files:

```text
/usr/lib64/libgtk-4.so.1.2200.5
d30ad305f7e77c2b284b6098d968734be5d4e617de6f94182ffc2c9ef4a542fe
/usr/lib64/libatspi.so.0.0.1
26a28d89b5aa13f23cc927882470d957344b86a5172f909eb657dc2ae6672c4c
/usr/lib64/girepository-1.0/Gtk-4.0.typelib
9f280aefe3031fe614502292b170927dc0f3ec3a35d716ed0a096392cde92e96
/usr/lib64/girepository-1.0/Atspi-2.0.typelib
5548d2c199d3ed264aca54c1a42cd106c6ee63a9f0cea8af9db8d3466d4ff816
```

All 4 measured hashes exactly matched the installed RPM database FILEDIGESTS. ELF `.note.package` independently reports the same package version/release/architecture and Fedora 44 OS CPE. RPM headers name Fedora Project as vendor/packager and report RSA/SHA256 key ID `dbfcf71c6d9f90a6`. GTK build host is `buildvm-x86-10.rdu3.fedoraproject.org`, core build host `buildhw-x86-17.rdu3.fedoraproject.org`.

These are corroborating installed metadata observations, not a fresh cryptographic validation of downloaded signed RPMs. A matching RPMdb digest does not independently establish RPMdb trust or reproduce the binary from source. No claim is made about libraries actually mapped into a running application, container/Flatpak copies, alternate loaders or embedded providers.

## Fedora build and patch provenance

| Installed source identity | Fedora build record | Exact dist-git source |
| --- | --- | --- |
| GTK `4.22.5-2.fc44` | [Build 3097223](https://koji.fedoraproject.org/koji/buildinfo?buildID=3097223), [task 150103129](https://koji.fedoraproject.org/koji/taskinfo?taskID=150103129) | [`ab2ef95a50b9e745b9f56f2e18a16356ea0e9d28`](https://src.fedoraproject.org/rpms/gtk4/c/ab2ef95a50b9e745b9f56f2e18a16356ea0e9d28) |
| core `2.60.7-1.fc44` | [Build 3103034](https://koji.fedoraproject.org/koji/buildinfo?buildID=3103034), [task 150306214](https://koji.fedoraproject.org/koji/taskinfo?taskID=150306214) | [`012eb5c093ef51628eaa429846b39e32ee8e78d0`](https://src.fedoraproject.org/rpms/at-spi2-core/c/012eb5c093ef51628eaa429846b39e32ee8e78d0) |

Koji records explicitly associate those builds with the listed dist-git commits and source RPM names. This avoids assuming the current moving Fedora branch matches an old installed build.

- The immutable [GTK spec](https://src.fedoraproject.org/rpms/gtk4/raw/ab2ef95a50b9e745b9f56f2e18a16356ea0e9d28/f/gtk4.spec) uses GTK 4.22.5 Source0 and `%autosetup -p1 -n gtk-%{version}`, with **no Patch directives**. The commit is titled Drop obsolete patches and removes the prior application-Wayland null-check and drag-source patches. Its raw fetched spec SHA256 is `5f7ba1b5855e6cdd0ebd0aaa4a8d673711fdb65e95edd35242ab2d20cca83448`.
- The immutable [core spec](https://src.fedoraproject.org/rpms/at-spi2-core/raw/012eb5c093ef51628eaa429846b39e32ee8e78d0/f/at-spi2-core.spec) uses Source0 2.60.7 and `%autosetup -p1`, also with **no Patch directives**. Source1 is the distribution Xwayland session scriptlet, not a libatspi identity patch. Raw spec SHA256 is `d3603f7300611c66cc74e89e8cb257c120ad0e265dc82f0620884cf9b1c9a773`.

The Fedora [GTK source manifest](https://src.fedoraproject.org/rpms/gtk4/raw/ab2ef95a50b9e745b9f56f2e18a16356ea0e9d28/f/sources) records:

```text
SHA512 (gtk-4.22.5.tar.xz) =
6c8970b8795df724c9e44e95a484278f9da7ddbc830f73d0c8678bce0752272af9f23d04e528bd51e9007db007150ec678072d4d76f89fd41dec579630758971
```

The Fedora [core source manifest](https://src.fedoraproject.org/rpms/at-spi2-core/raw/012eb5c093ef51628eaa429846b39e32ee8e78d0/f/sources) records:

```text
SHA512 (at-spi2-core-2.60.7.tar.xz) =
6ebd470b75bb932e83b310c5ad7067f39c22b0a4bb5e2849e84e39284bc342913929320bfb168026abc3695094a04ef40248faca369f62ac9bb9a4f409b73ed9
```

The tarballs/SRPMs were not downloaded or extracted, so the manifest digests are recorded expected values, not locally reverified archive hashes. No-Patch specs support the absence of listed downstream identity patches, not an independently reconstructed source-to-binary proof.

## Matching release source, rather than main/dev inference

### GTK 4.22.5

[Tag 4.22.5](https://api.github.com/repos/GNOME/gtk/git/ref/tags/4.22.5) points through annotated tag `f93ed25dc632f2161fed4aac66602ec2d293317a` to release commit [`bd25f1e2dc2c2fbf3b8864e61afe642910ba359c`](https://github.com/GNOME/gtk/tree/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c). GitHub reports this tag unsigned; this audit does not claim a verified upstream tag signature.

The release [context source](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspicontext.c#L1599-L1613) calls `g_uuid_string_random` and constructs `base_path/uuid`, just like the previously reviewed main implementation. [Unrealization](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspicontext.c#L1635-L1653) emits defunct, unregisters the context/interfaces and frees the path. [Reference serialization](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspicontext.c#L2048-L2055) pairs the path with the connection unique name.

Thus the matching release source also supports a per-realization UUID identity design under explicit noncollision/trusted-provider assumptions. It does not prove that a particular running object uses that provider, that custom descendants comply, that semantic virtual-row content is unchanged, or that pause/off authority can be checked atomically with writes. Re-realization must invalidate the original ref, not substitute the new UUID.

### libatspi 2.60.7, including its actual P2P path

[Tag 2.60.7](https://api.github.com/repos/GNOME/at-spi2-core/git/ref/tags/2.60.7) resolves through `b8a46d6156733d53e4af5b16d973ecc5eaf5529d` to [`66707c370bef824ed4edb08a909fc6a61449c12c`](https://github.com/GNOME/at-spi2-core/tree/66707c370bef824ed4edb08a909fc6a61449c12c). The tag includes a PGP signature, but GitHub reports unknown key; this audit did not independently validate it.

Release [proxy interning](https://github.com/GNOME/at-spi2-core/blob/66707c370bef824ed4edb08a909fc6a61449c12c/atspi/atspi-misc.c#L441-L470) still keys accessible proxies by path within the app. [Removal](https://github.com/GNOME/at-spi2-core/blob/66707c370bef824ed4edb08a909fc6a61449c12c/atspi/atspi-misc.c#L505-L526) disposes them; strong client references do not reserve remote provider objects. [`get_process_id`](https://github.com/GNOME/at-spi2-core/blob/66707c370bef824ed4edb08a909fc6a61449c12c/atspi/atspi-accessible.c#L1831-L1864) uses accessibility-bus GetConnectionUnixProcessID.

Important release-specific detail: [get_application](https://github.com/GNOME/at-spi2-core/blob/66707c370bef824ed4edb08a909fc6a61449c12c/atspi/atspi-misc.c#L404-L437) **does** request GetApplicationBusAddress. [The reply callback](https://github.com/GNOME/at-spi2-core/blob/66707c370bef824ed4edb08a909fc6a61449c12c/atspi/atspi-misc.c#L349-L376) can open a private connection and replace `app->bus`. Unlike the reviewed main pin, this release path has no `ATSPI_DISABLE_P2P` guard. Do not prescribe that environment variable as an installed 2.60.7 bus-only guarantee. The actual application may return an empty address; this audit performed no live query and makes no routing claim for a particular process.

## What remains before any identity capability

1. If stronger supply-chain proof is required, coordinate a budgeted signed binary/SRPM retrieval, validate trusted Fedora signatures, inspect the exact source payload and compare the manifest archive with release content. This report did not consume that heavy operation slot.
2. At an owner-approved later runtime gate, bind the actual loaded library/provider and typed native path/bus owner to these reviewed artifacts. An installed file hash is not a process mapping observation. Resolve well-known names to recorded unique owners on the same accessibility bus and corroborate PID plus process/bus generation.
3. Prove the private-connection peer/endpoint identity or implement an audited shared-bus-only route compatible with this release. A shared-bus owner token alone does not authenticate a different P2P endpoint.
4. Preserve provider lifetime invalidation, exact frame membership, bounded retained state and re-realization refusal. Qt and other providers remain outside this GTK-specific source corroboration.
5. Keep semantic mutation disabled until the [authority/revocation/drain requirements](../accessibility-host-design.md#stage-c-semantic-mutation-remains-disabled) and remote in-flight uncertainty contract are satisfied. Nothing here establishes task-level success, live stale-ref refusal or a speed gain.

**Result:** installed binaries and matching Fedora/release sources are now concretely corroborated beyond a version string. Runtime provider attribution, archive/signature reconstruction and mutation safety remain separate unresolved gates. No native application was opened or queried for this audit.
