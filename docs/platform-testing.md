# Native platform evidence

Updated 22 October 2026.

Historical browser measurements do not certify the current native-only product.
See [actual platform support](support-tiers.md), [the real native opening report](native-opening.md)
and [the native adapter contract](porting.md). Opening on Windows and macOS is
not implemented. Application input and capture remain held. Git history retains
retired implementation measurements.

The Native source contracts GitHub workflow checks source types and metadata/service
contracts on Linux, Windows and macOS runners. A separate Linux job builds the
English/Arabic website. These jobs launch no browser and create no private session.
Their results must be read from the actual workflow run; adding the YAML is not
evidence that remote jobs passed or that a desktop application was controlled.
