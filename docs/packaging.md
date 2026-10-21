# Packaging

Orbit packages the native application broker, CLI, MCP adapter, panel and owner
compositor integration. Bun dependencies are the MCP SDK and Zod. No browser
automation library, browser binary, extension, browser viewer or private compositor
runtime belongs to the product.

Use `bun install --frozen-lockfile --ignore-scripts`, `bun run typecheck`, and
`bun run verify`. The supported suite uses native logic and protocol fixtures,
never browser sessions or substitute desktops. The former `--native` bootstrap
is unavailable. Native opening uses the configured original owner compositor.

A source release and installation are not runtime acceptance. Managed activation
requires an idle broker. Preserve unrelated settings and work. See
[installation](agent-install.md) and [the contract](desktop-only.md).
