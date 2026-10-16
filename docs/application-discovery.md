# Application discovery

`applications [QUERY]`, broker `applications.list`, and MCP `orbit_applications`
return current-user application metadata. Discovery does not start an application,
capture a screen, inspect keyring values, or establish account authentication.
Executable presence, observed running state, and account compatibility are separate
facts. Native work uses a `system` session; failure must be reported rather than
silently replacing the requested desktop task with a browser session.

## Evidence and selection

Each verified application reports its canonical executable, packaging, evidence sources,
observed running process IDs, and supported explicit profile directories. Raw
command lines, document URLs and document titles are excluded. OS registrations
that point to absent executables are ignored. A registration is metadata, not a
signature check or proof that launching that program is safe or compatible.
Namespace-visible paths that cannot be resolved on the host remain in the
inventory with `availability: unresolved`. An unresolved running Zen prevents
idle installation or default profile fallback. It is not a verified launch path.

Supported Mozilla-family installations expose their version and update channel
when those literal values are present in `application.ini` and
`defaults/pref/channel-prefs.js`. Missing metadata remains `not measured`.
A release channel is reported as observed metadata, not inferred from a version
suffix, a folder name, a successful launch, or the newest modification time.

A single observed running Zen installation takes priority over installed idle
versions. Conflicting running installations, conflicting profile flags or an
unresolved local/Flatpak installation choice are refused. The current profile
is selected from an explicit running `--profile` flag when available. Relative
paths resolve against the observed process working directory, and `-P NAME`
selects a unique named entry in `profiles.ini`. Unavailable or conflicting
explicit selectors refuse default fallback. Otherwise Zen's `profiles.ini`
defaults must resolve unambiguously. Recency cannot prove
which account or profile is active. This observed profile metadata does not authorize
profile copying or establish existing-session control.

## Linux adapter

Discovery combines XDG desktop registrations, Flatpak exported entries with a
confirmed deployment, supported application names on absolute PATH entries,
current-user `/proc` executable metadata, and available XBEL application usage
metadata. User registrations shadow matching system entries, including hidden
entries. Literal shell wrappers and symlinks can resolve a moved archive without
executing a shell; complex launch scripts are not evaluated.

Desktop registration and process discovery cover arbitrary executable names.
PATH lookup is bounded to supported browser/editor/agent names and 128 absolute
search directories. Filesystem-wide
search is not performed. The metadata scan caps enumeration while traversing
and checks an eight second cooperative deadline. Expiry reports truncation.
A single filesystem call may outlast that deadline; slow filesystem acceptance
is not measured and this is not a hard kernel time limit.
Recently used application metadata can identify a relocated executable, but
returned data never includes the recent document's path or title.

For a new private Linux launch, use a discovered `registrationIds` entry with
`launch-installed`. Registration identity remains separate from the executable.
The supported resolver handles literal executable recipes and bounded literal
forwarders; complex scripts, Flatpak activation, terminal and DBus activation fail
explicitly. Discovery of these packages is not launch support. No application name
or personal installation path is required in the generic launch action.

## Other platform adapters and accounts

macOS enumerates application bundles in the system and current-user Applications
roots and uses bundle executable metadata. Windows enumerates current-user and
machine App Paths, preserving current-user precedence. These adapters have local
contract fixtures, not fresh physical Mac or Windows acceptance in this change.
Windows localized registry output, running processes, recent usage and profiles
are not measured. macOS running processes, recent usage and profiles are not
measured. Unsupported platforms explicitly return no adapter.

Inventory is scoped to the logged-in user. It does not inspect another user's
processes or authenticate arbitrary accounts. Private native displays remain
Linux only, and the native owner handoff release hold remains unchanged. Neither
these limits nor platform/account support can be closed by installation or by
fixtures on another operating system.

## Installation channels

A source checkout, installed package and running broker may be different revisions.
Record the selected revision and package version before installation. Current
release identity must be read from its actual destination; historical channel
observations do not establish the installed runtime. See [packaging](packaging.md).
