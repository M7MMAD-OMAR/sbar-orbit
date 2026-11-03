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

## Exact GTK routing and identity boundary followup

Additional source/static-metadata review, 4 November 2026. This section refines the earlier generic private-endpoint warning. It does not inspect or change an application, accessibility bus, live lease or runtime provider.

### GetApplicationBusAddress returns the managed-bus address

For the exact GTK 4.22.5 release, [handle_application_method](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspiroot.c#L191-L195) returns `root->bus_address`. It does **not** return an unconditional empty string. That field is the construct-only bus-address property copied by [the setter](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspiroot.c#L124-L133); [the constructor](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspiroot.c#L1056-L1063) receives the same address that [constructed](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspiroot.c#L955-L961) opens with `G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION`. The root explicitly calls this a fully managed accessibility bus.

[Address selection](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspicontext.c#L1915-L1950) uses a cached display address, then nonempty `AT_SPI_BUS_ADDRESS` if supplied; on Wayland it otherwise requests [org.a11y.Bus.GetAddress](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspicontext.c#L1882-L1910) over the session bus. Environment overrides/portals therefore remain relevant provenance, not proof that every address is the ordinary host endpoint.

[Root registration](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspiroot.c#L854-L885) exports Application and Accessible interfaces at `/org/a11y/atspi/accessible/root` on that connection, and passes its **unique** name plus root path to Registry Embed. This traced GTK root does not construct a separate application GDBusServer for the method.

Thus libatspi 2.60.7 may call `dbus_connection_open_private` on the **same managed bus address** returned by GTK. Private ownership of the client connection is not, by itself, evidence of a distinct application peer endpoint. The earlier generic warning must not be read as a claim that this GTK release necessarily routes through a separate peer server. Conversely, source tracing does not prove the endpoint/bus instance actually selected by a future running process, successful authentication/registration on it or identity under address replacement. A future route token needs corroborated bus-instance/endpoint evidence, not merely a nonempty address or the word private. No bus-only environment switch or native route change is enabled here.

### Exact object path and owner extraction contract

[Base-path selection](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspiroot.c#L976-L1023) uses the registered GApplication object path plus `/a11y`; otherwise it uses `/org/gtk/application/<program-name>/a11y`, replacing invalid non-slash path characters with underscores. [Context realization](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspicontext.c#L1599-L1613) appends `/` and a random UUID with hyphens replaced by underscores. The source-backed suffix shape is:

```text
[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}
```

A pure validator should require an independently trusted exact base path followed by that suffix and otherwise valid D-Bus path syntax. The broad shape `(valid-base)/a11y/(UUID-suffix)` is only parsing, never provider provenance. Do not treat the fixed application root, numeric Qt paths, bare accessible IDs, labels or proxy repr strings as GTK realization handles. This audit does not add UUID version/variant bit constraints without separately pinning the GLib generator contract.

[Context references](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspicontext.c#L2048-L2055) carry the connection unique name and context path. Re-realization generates a new UUID, so an original ref must not be rebound to it even if the widget/name/bounds remain the same. The native typed pair is usable input to a future identity adapter; it does not alone supply helper/bus/process/window generations or authority.

### Installed static GI exposure, without initialization

The installed [GIR metadata](</usr/share/gir-1.0/Atspi-2.0.gir#L8622-L8638>) exposes `Atspi.Object.app` as `Atspi.Application` and `path` as UTF-8; [Application.bus_name](</usr/share/gir-1.0/Atspi-2.0.gir#L2099-L2125>) is UTF-8. These are declared fields, not names invented by inspecting a proxy repr. The installed [Python override](</usr/lib64/python3.14/site-packages/gi/overrides/Atspi.py#L44-L51>) itself accesses `self.app.bus_name` and `self.path`. Static declarations and consumer code support that access pattern; actual live field reads and null/disposal handling were not exercised.

Important: [that override](</usr/lib64/python3.14/site-packages/gi/overrides/Atspi.py#L33-L50>) implements equality by comparing hashes and caches a hash of concatenated bus name/path. Neither equality nor hash is an authoritative remote lifetime test. Use retained-object `is` only for local registry bookkeeping, plus exact immutable typed token fields for proven remote bindings; never proxy `==`, proxy hash or string concatenation as identity proof. A disposed proxy can retain its cached hash.

[Installed toolkit getter metadata](</usr/share/gir-1.0/Atspi-2.0.gir#L1261-L1305>) declares root-only `get_toolkit_name` and `get_toolkit_version`. [GTK sets](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspiroot.c#L854-L856) ToolkitName to `GTK` and Version to `PACKAGE_VERSION`; [property handling](https://github.com/GNOME/gtk/blob/bd25f1e2dc2c2fbf3b8864e61afe642910ba359c/gtk/a11y/gtkatspiroot.c#L211-L218) returns those values. [libatspi getters](https://github.com/GNOME/at-spi2-core/blob/66707c370bef824ed4edb08a909fc6a61449c12c/atspi/atspi-accessible.c#L887-L934) may cache them on the application proxy. Those strings are compatibility observations, not signed provider provenance or a per-object generation.

**Pure comparison boundary:** an injected trusted proof must bind exact reviewed provider/release and artifact provenance, managed-bus route and bus instance, unique owner, PID/start generation, helper generation, exact compositor window lifetime, trusted base path and captured UUID path. Every component must match at validation. Well-known-name rebinding, unknown route/version/source, absent epochs, custom providers or changed UUID fail closed. This remains an unintegrated token-comparison contract, not public refs, provider lifetime acceptance or semantic-action enablement.
