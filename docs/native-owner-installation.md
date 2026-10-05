# Native owner activation configuration

Reviewed 5 October 2026. This records installation behavior, not desktop input acceptance.

The generated `service-drop-in.conf` must use an unquoted absolute path in its
`EnvironmentFile` directive. systemd treats quotes in this directive as literal
path characters and ignores the resulting nonabsolute path. Its
[directive parser](https://github.com/systemd/systemd/blob/main/src/core/load-fragment.c)
expands unit specifiers and validates the path without shell unquoting.
The values inside `broker-native.env` retain their double quotes; that file has
a different parser. Percent characters are doubled only in the unit directive.

The regression in `tests/native-prepare.test.ts` generates a preparation with
mocked compositor metadata, loads its template in a disposable real user unit,
and reads the two environment variables from that unit's Python child. Its
directory contains spaces and a literal `%u`. The unchanged test failed before
the fix because both variables were absent, then passed after the directive fix.
An earlier fixture attempt failed on incomplete mocked metadata and is retained
privately. Hosts without a Linux user manager skip this integration check.
The fixture opens no display and stops and removes only its own unit.

On the development workstation, the exact-version plugin was built, privately
staged and loaded through the journaled `native-plugin` owner command. Status
verified its source stamp, ABI, binary digest and kernel mapping identity with
zero live roots. No owner window enumeration, capture or input was performed.
Controls remained protected. Installation and plugin loading do not establish
the pointer, focus, clipboard, toolkit, theme or performance acceptance gates.

An activation plan is bound to the current compositor process and sockets.
A temporary service drop-in under the user runtime directory disappears after
logout or reboot, leaving normal Orbit startup independent of that old plan.
The native path then needs a new preparation and matching plugin activation.
Do not install a permanent required environment-file reference to such a
temporary plan. Existing application instances and unsaved work are not enrolled
by this installation.

Validation on 5 October 2026: typecheck passed. The indexed full suite completed
with 655 passes, 48 configured skips, zero failures and 4,030 assertions across
703 tests in 154 files. The corrected runtime drop-in appeared in systemd's
`EnvironmentFiles` property. The installed command created and closed a real
`native` session through the managed broker. A fresh owned-browser smoke check
then passed navigation, rendered text, pause refusal, resume, capture and stop
while the native configuration was enabled. These are service integration and
installation checks; no owner-target application input was sent.
