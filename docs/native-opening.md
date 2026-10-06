# Open an application on the actual desktop

`orbit_open` and `native.open` open an application with its normal owner profile
on an explicitly selected workspace. This is distinct from launching an owned
application in the private Fedora display. It requires configured native owner
controls and a live preparation bound to the selected Hyprland compositor.
Opening does not load a plugin or change its admission state. Owner plugin
loading and handoff remain disabled under the compositor crash release hold.

```sh
ORBIT_REQUEST_ID=chrome-opening-1 sbar-orbit native-open '{"workspace":4,"argv":["/usr/bin/google-chrome-stable","--profile-directory=Profile 1","--new-window","--ozone-platform=wayland","about:blank"]}'
```

The compositor receives a silent workspace rule with initial focus disabled.
Arguments travel in a private launch specification, not as shell fragments.
The helper replaces itself with the application, leaving no polling helper
running after startup. No profile is copied and no browser is restarted.

The reply identifies the exact new window by address and stable identity. It
must belong to the launch process or its descendants and appear on the requested
workspace. Owner application handoff is currently unavailable after a compositor
crash, pending isolated validation. The identity is retained for later verified
handoff. Opening itself neither grants input access nor captures the application.
Worker shutdown and handback leave the owner application open.

Protected mode requires approval of the exact normalized opening request before
dispatch. The mode is never changed by this operation. Request identities dedupe
accepted openings for the broker lifetime. An approval denial permits retry after
approval. Other uncertain failures retain their original result and the private
worker directory; check candidates before submitting a different opening request.
Broker restart does not preserve the in-memory dedupe cache.

Single-instance applications may forward startup to an unrelated existing
process. That case is not verified as a launch target and cannot silently grant
that process. Multiple newly opened windows require explicit selection. XWayland
input handoff remains unsupported. Broader application compatibility and
comparative performance remain not measured.

For Chrome and Chromium, opening pins an absolute user data directory in the launch arguments. Without an explicit directory it uses the standard owner directory under `~/.config`, so compositor environment overrides cannot redirect the lock check and launch to different profiles. Custom directories must be supplied explicitly.


The supported evidence is limited: one real Chrome Profile 1 opening on workspace
4 was acknowledged before the incident, with the active window, workspace and
pointer preserved. The subsequent handoff crashed the compositor. Current opening
fixtures use a simulated transport and mock helper execution; they do not establish
current live desktop support, a visible agent cursor, or comparative performance.
The release hold is preserved and live opening has not been repeated after the
incident.
