# Native resource budget

Orbit entry points use a shared system resource budget. On Linux, the supported
verification command is `bun run verify`; bounded commands run through
`bun run scripts/limited.ts COMMAND`. Do not run concurrent budgeted test commands.

The broker and opening worker require the budget. Original owner applications are
launched by the existing compositor with their normal environment and lifetime.
Do not claim that an already running owner application is constrained by the
worker budget. Resource enforcement, application launch and desktop control are
separate measurements. No private display or viewer resource setting exists.

Windows Job Object and macOS process-budget code support shared service/tooling
contracts. They do not establish native application opening or input on those
platforms. See [current support](support-tiers.md).
