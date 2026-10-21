# Orbit

Open original installed native Linux applications on a numbered Hyprland workspace.
The user can select another workspace for their own work. Applications retain their normal owner state and
stay open after the opening worker exits.

Browser launching, browser automation, copied profiles, private desktops and
browser viewers were removed. There is no hidden or substitute session mode.

```sh
bun install --frozen-lockfile --ignore-scripts
./install.sh --dry-run --json
./bin/sbar-orbit applications Calculator
./bin/sbar-orbit native-open '{"workspace":2,"applicationId":"org.gnome.Calculator.desktop"}'
```

Opening requires the configured native owner compositor metadata and protected
action approval. Input and capture of owner applications remain under the
[compositor crash release hold](docs/native-handoff-incident.md). Opening is not
proof of input support or signed-in account state.

See the [contract](docs/desktop-only.md), [CLI](docs/cli.md),
[connectors](docs/connectors.md), and [installation](docs/agent-install.md).

```sh
bun run typecheck
bun run verify
```

The supported suite never opens a browser or creates a private desktop. Unknown
measurements are reported as `not measured`, never as a pass.

![Original native application workspace diagram](docs/images/native-workspaces.svg)

This is an architecture illustration, not a screenshot. See [real installed app
results](docs/native-opening.md) and [the platform matrix](docs/support-tiers.md).
Windows, macOS and other Linux compositor opening adapters are not implemented.
Full desktop application work is unfinished while input and capture remain held.
