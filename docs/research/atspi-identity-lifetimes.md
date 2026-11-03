# AT-SPI identity lifetimes: pinned source audit

Reviewed 4 November 2026. Source-only audit using GitHub APIs and raw pinned source. No AT-SPI initialization, application reads, builds, installation changes or live tests. These upstream main/dev pins are **not installed GTK4/Qt6/libatspi compatibility evidence**. Unknown installed versions must not enable identity-dependent mutation.

## Decision

- **Generic retained libatspi proxy:** insufficient. Local object retention does not reserve the remote object path or extend the provider object lifetime.
- **GTK4 at the reviewed pin:** promising provider-specific basis. Each realization creates a fresh random UUID path and unrealization unregisters it. Exact unique-owner plus path can identify that realization under an explicit UUID noncollision/trusted-provider assumption. This is not yet Orbit support or unconditional mathematical nonreuse.
- **Qt6 at the reviewed pin:** strict nonaliasing remains unsupported. Paths encode finite cached IDs; allocation advances and can wrap/reuse freed IDs. Client retention/TTL does not prevent provider allocation or prove a no-wrap interval.
- **Semantic writes:** remain disabled until installed provider/version matching, frame/object binding, provider lifetime and external authority/drain gates are proved. Accessibility-object identity also does not prove that a virtualized widget still represents the same document row.

## Revisions and exact evidence

| Project | Reviewed upstream branch | Pinned revision |
| --- | --- | --- |
| GTK | main | [`a69dd89fbfa67da20e378a08cb0ef870a11975f1`](https://github.com/GNOME/gtk/tree/a69dd89fbfa67da20e378a08cb0ef870a11975f1) |
| Qt base | dev | [`e5b8c68e1042d66e702cfc19a7b1c2c59055f61c`](https://github.com/qt/qtbase/tree/e5b8c68e1042d66e702cfc19a7b1c2c59055f61c) |
| at-spi2-core | main | [`98a724896fc75f1299dcaea8aab8f2cd8f121b4c`](https://github.com/GNOME/at-spi2-core/tree/98a724896fc75f1299dcaea8aab8f2cd8f121b4c) |

### GTK4: UUID per realization, unregister on loss

[Context realization](https://github.com/GNOME/gtk/blob/a69dd89fbfa67da20e378a08cb0ef870a11975f1/gtk/a11y/gtkatspicontext.c#L1597-L1654) obtains a per-display root, calls `g_uuid_string_random`, replaces hyphens with underscores and constructs `base_path/uuid`. It is not a widget pointer, tree index or accessible name. [Reference emission](https://github.com/GNOME/gtk/blob/a69dd89fbfa67da20e378a08cb0ef870a11975f1/gtk/a11y/gtkatspicontext.c#L2076-L2084) returns the connection unique name with that context path. The [root construction](https://github.com/GNOME/gtk/blob/a69dd89fbfa67da20e378a08cb0ef870a11975f1/gtk/a11y/gtkatspiroot.c#L957-L1031) derives the base path from the registered application or program name; the prefix alone is not identity.

[Unrealization](https://github.com/GNOME/gtk/blob/a69dd89fbfa67da20e378a08cb0ef870a11975f1/gtk/a11y/gtkatspicontext.c#L1658-L1676) emits defunct, removes the context from the root/cache, unregisters every registered D-Bus interface, then frees the path/root. [Finalization](https://github.com/GNOME/gtk/blob/a69dd89fbfa67da20e378a08cb0ef870a11975f1/gtk/a11y/gtkatspicontext.c#L1550-L1575) also unregisters and releases the path. A later realization allocates a new UUID rather than reviving the saved path. A saved realization ref must fail, not follow a re-realized widget.

[Defunct emission](https://github.com/GNOME/gtk/blob/a69dd89fbfa67da20e378a08cb0ef870a11975f1/gtk/a11y/gtkatspicontext.c#L929-L940) depends on a connection and registered event listeners. [Root unregister](https://github.com/GNOME/gtk/blob/a69dd89fbfa67da20e378a08cb0ef870a11975f1/gtk/a11y/gtkatspiroot.c#L945-L954) removes cached context state; [cache removal](https://github.com/GNOME/gtk/blob/a69dd89fbfa67da20e378a08cb0ef870a11975f1/gtk/a11y/gtkatspicache.c#L447-L466) emits RemoveAccessible when the path was present. These signals assist invalidation, but they are not a synchronous lease held by the client. Missing events do not authorize a predicate-based replacement search.

**Limit:** the path generator is random, not a monotonic never-reuse ledger. This audit establishes the allocation mechanism, not a zero-collision theorem or an application-independent promise. Generic/custom/embedded providers cannot be whitelisted merely because their application reports GTK or their path resembles a UUID. Toolkit provenance and exact installed implementation must be established. Semantic virtual-row rebinding needs a separate task-level precondition.

### Qt6: current cache ID dispatch, no external reservation

[ID allocation](https://github.com/qt/qtbase/blob/e5b8c68e1042d66e702cfc19a7b1c2c59055f61c/src/gui/accessible/qaccessiblecache.cpp#L51-L80) uses a static unsigned `nextId`, starts above `INT_MAX`, skips IDs still in the local interface cache and contains wrap logic. [Insertion and QObject destruction](https://github.com/qt/qtbase/blob/e5b8c68e1042d66e702cfc19a7b1c2c59055f61c/src/gui/accessible/qaccessiblecache.cpp#L123-L179) bind native interfaces to IDs and connect destruction handling. [Deletion](https://github.com/qt/qtbase/blob/e5b8c68e1042d66e702cfc19a7b1c2c59055f61c/src/gui/accessible/qaccessiblecache.cpp#L181-L209) erases the mappings and deletes the interface; a libatspi client ref does not reserve its ID.

[Path generation](https://github.com/qt/qtbase/blob/e5b8c68e1042d66e702cfc19a7b1c2c59055f61c/src/gui/accessible/linux/atspiadaptor.cpp#L1865-L1875) appends `QAccessible::uniqueId(interface)` to the AT-SPI path prefix. [Incoming path resolution](https://github.com/qt/qtbase/blob/e5b8c68e1042d66e702cfc19a7b1c2c59055f61c/src/gui/accessible/linux/atspiadaptor.cpp#L959-L977) parses the ID and returns the **current** cached interface. A reused numeric ID can therefore make the same path dispatch to a different interface. This is a possible lifetime alias, not evidence that ordinary replacement immediately reuses IDs.

[Destruction notification](https://github.com/qt/qtbase/blob/e5b8c68e1042d66e702cfc19a7b1c2c59055f61c/src/gui/accessible/linux/atspiadaptor.cpp#L1488-L1512) emits parent ChildrenChanged/remove with index `-1`, but returns early for missing/invalid interface or missing parent. [Event dispatch](https://github.com/qt/qtbase/blob/e5b8c68e1042d66e702cfc19a7b1c2c59055f61c/src/gui/accessible/linux/atspiadaptor.cpp#L1030-L1033) is listener-gated. It is not a complete nonreuse primitive. [Object references](https://github.com/qt/qtbase/blob/e5b8c68e1042d66e702cfc19a7b1c2c59055f61c/src/gui/accessible/linux/qspi_struct_marshallers_p.h#L34-L40) use the connection base service with the path, so connection identity is useful but does not solve within-connection ID reuse.

A short ref TTL does not bound the number of allocations in the provider. Unsupported remains the honest strict answer unless a provider-side generation/reservation API or independently proved no-reuse interval is added.

### libatspi: proxy interning, not remote retention

[Application lookup and accessible interning](https://github.com/GNOME/at-spi2-core/blob/98a724896fc75f1299dcaea8aab8f2cd8f121b4c/atspi/atspi-misc.c#L414-L481) key applications by the supplied bus name and accessible proxies by object path within that application. Existing lookup returns a ref to the same local proxy. A local `is` match can thus reflect the same lookup address, not the same surviving server object.

[RemoveAccessible](https://github.com/GNOME/at-spi2-core/blob/98a724896fc75f1299dcaea8aab8f2cd8f121b4c/atspi/atspi-misc.c#L515-L537) calls `g_object_run_dispose` even if another client ref exists. [Accessible disposal](https://github.com/GNOME/at-spi2-core/blob/98a724896fc75f1299dcaea8aab8f2cd8f121b4c/atspi/atspi-accessible.c#L195-L241) emits defunct and clears cached state/relationships; [base disposal](https://github.com/GNOME/at-spi2-core/blob/98a724896fc75f1299dcaea8aab8f2cd8f121b4c/atspi/atspi-object.c#L33-L46) removes the path from the application hash and nulls the app pointer. A retained proxy can be disposed; do not equate strong reference with live provider handle.

[NameOwnerChanged handling](https://github.com/GNOME/at-spi2-core/blob/98a724896fc75f1299dcaea8aab8f2cd8f121b4c/atspi/atspi-misc.c#L550-L581) disposes matching applications. [Application disposal](https://github.com/GNOME/at-spi2-core/blob/98a724896fc75f1299dcaea8aab8f2cd8f121b4c/atspi/atspi-application.c#L62-L92) disposes cached objects and releases the root/bus. Messages are [deferred for main-context dispatch](https://github.com/GNOME/at-spi2-core/blob/98a724896fc75f1299dcaea8aab8f2cd8f121b4c/atspi/atspi-misc.c#L1048-L1075), so event pumping is necessary but cannot make a later remote write atomic. Cache-none removes stale property-cache dependence, not proxy address reuse.

## Concrete identity and PID corroboration

The pinned headers expose [AtspiObject.app/path](https://github.com/GNOME/at-spi2-core/blob/98a724896fc75f1299dcaea8aab8f2cd8f121b4c/atspi/atspi-object.h#L41-L47) and [AtspiApplication.bus_name](https://github.com/GNOME/at-spi2-core/blob/98a724896fc75f1299dcaea8aab8f2cd8f121b4c/atspi/atspi-application.h#L42-L58). This is the native source identity representation. Validate the installed GI field types/readability separately; never parse a proxy repr or fabricate ownership from a path prefix. `get_application()` returns an accessible root, not proof that its name is immutable or unique.

[`get_process_id`](https://github.com/GNOME/at-spi2-core/blob/98a724896fc75f1299dcaea8aab8f2cd8f121b4c/atspi/atspi-accessible.c#L1819-L1864) asks the accessibility bus daemon for GetConnectionUnixProcessID using the app bus name. Errors yield no usable PID. [`get_id`](https://github.com/GNOME/at-spi2-core/blob/98a724896fc75f1299dcaea8aab8f2cd8f121b4c/atspi/atspi-accessible.c#L979-L987) reads the Application.Id property; [`get_accessible_id`](https://github.com/GNOME/at-spi2-core/blob/98a724896fc75f1299dcaea8aab8f2cd8f121b4c/atspi/atspi-accessible.c#L1964-L1974) reads AccessibleId. Neither is a remotely retained lifetime generation.

Future implementation must:

1. Capture typed native path and app bus name. Require a live root/object and provider provenance tied to the actual installed audited code. Reject unsupported custom descendants or cross-provider embeddings.
2. Resolve any well-known name with GetNameOwner on the **same accessibility bus**, record the unique owner, query its connection PID and compare with the leased compositor client PID plus boot/start generation. Resolve/check again around capture and before dispatch; reject any mismatch or unavailable evidence. Do not query an unrelated ordinary session bus.
3. Bind accessibility bus connection/instance, helper generation, unique owner, process generation, exact leased window/frame and provider path into the retained identity. Invalidate on reconnect/owner loss, even if the same PID or displayed title reappears. Send only to the recorded unique owner; never follow a well-known name to its replacement.
4. Audit libatspi peer-to-peer routing: [get_application](https://github.com/GNOME/at-spi2-core/blob/98a724896fc75f1299dcaea8aab8f2cd8f121b4c/atspi/atspi-misc.c#L438-L446) can request GetApplicationBusAddress. A retained shared-bus name does not automatically prove the identity of a later private transport endpoint. Either prove that endpoint's peer/process binding or deliberately use an audited bus-only path. No such future routing change is enabled by this report.

## Next-source gates, not live claims

First add an internal content-free identity adapter and offline tests for typed path/owner extraction, well-known-name replacement, bus/process generation mismatch, disposed proxy, missing events and unsupported provider versions. Do not expose mutation APIs as part of that adapter. Confirm GTK UUID re-realization/old-path refusal against matched installed source before accepting a GTK-specific capability. Qt stays unsupported under the strict noalias contract.

Then prove exact frame membership and handle virtualized semantic item rebinding independently. Finally complete the [external admission/revocation/drain design](../accessibility-host-design.md#stage-c-semantic-mutation-remains-disabled). Even a sound identity token cannot retract already-sent D-Bus work or bypass pause/off/narrow/owner-input gates. Installed/runtime evidence and real GTK4/Qt6 acceptance remain separate and pending; no provider capability is enabled by this audit.
