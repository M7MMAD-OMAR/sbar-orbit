# Asset provenance

## Identity

`public/brand/logo.png`, `logo-white.png` and `public/favicon.svg` are the existing repository's approved Sbar Orbit artwork. Geometry and wordmark are unchanged.

## Current diagram

`public/images/native-workspaces.svg` depicts two numbered workspaces in the
existing desktop session, original application state, floating geometry, shared
clipboard and activity indicators. It is a schematic, not a screenshot or proof
of input delivery. [The product contract](../docs/desktop-only.md) defines the
operational meaning; [dated acceptance](../docs/acceptance.md) records real results.

## Historical illustration provenance

The original navy ink illustrations were generated on 12 September 2026 and edited
on 15 October 2026. Their exact prompts and reference commit remain in
[desktop-assets.json](desktop-assets.json). That JSON is historical provenance,
not a current asset inventory or a product instruction. The old hero, private
desktop and viewer WebP files are no longer shipped in `public/images`.

## Support button

`coffee-button.webp` is a lossless conversion of the user's supplied `Downloads/BuyMyCoffee/bmc-button.png`. Buy Me a Coffee branding belongs to its respective owner. The destination is the exact account URL supplied by the user.

## Typography and icons

DM Sans is distributed under the SIL Open Font License included in `public/fonts/OFL.txt`. Phosphor icons are provided by `@phosphor-icons/react` under its MIT license. Dependency licenses remain applicable separately from this repository's Apache-2.0 license.

Arabic typography uses Noto Sans Arabic Variable from the pinned Fontsource package.
Vite bundles the font subsets locally, with no request to a remote font provider.
The redistributed SIL Open Font License is in `public/fonts/NotoSansArabic-OFL.txt`.
