# Original application discovery

`applications [QUERY]`, broker `applications.list` and MCP `orbit_applications`
return current-user application metadata. Discovery does not launch applications,
capture a screen, inspect keyring values or authenticate an account.

Linux discovery reads XDG desktop registrations, verified Flatpak deployment
metadata, bounded PATH candidates, current-user process metadata and available
XBEL application usage metadata. Hidden user registrations shadow matching system
entries. Executable presence, packaging, running PIDs and registration IDs are
metadata, not proof of successful native opening. Unresolved namespaces and
truncated enumeration must remain visible as limits. No filesystem-wide search is
performed. Profile directories, when reported, do not authorize copying profiles
or establish signed-in state. Use the owner's original browser or personal profile
only when explicitly requested; ordinary web tasks use the AI host's browser.

Choose an exact discovered `.desktop` registration ID for `native-open`, with an
explicit numbered workspace and optional bounded window dimensions. The current
opening adapter requires configured Hyprland owner metadata. It supports literal
native executables, bounded literal shell forwarders, installed Python/GJS native
entry scripts and supported literal environment values. Original browser and
terminal registrations retain their installed recipe, profile arguments and normal
owner state. This registration support is distinct from accepting arbitrary
caller-supplied commands or copying profiles. Unsupported recipes and activation
adapters return their actual error or uncertain attribution; they are not repaired
by substituting another profile. See [the registered launch architecture](architecture.md).

Flatpak deployment discovery does not establish Flatpak opening. Single-instance
forwarding can fail launch attribution; missing acknowledgement stays uncertain.
See [actual application results](native-opening.md), [the CLI](cli.md) and
[the current platform matrix](support-tiers.md).

macOS bundle metadata and Windows App Paths adapters are implemented for discovery.
Their fixtures do not certify real native application opening or control. No native
opening adapter is implemented for those platforms. Native input and capture require a matching loaded source and compositor ABI.
See [current acceptance](acceptance.md); the compositor incident is
retained as historical evidence.
