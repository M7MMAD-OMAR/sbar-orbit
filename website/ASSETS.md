# Asset provenance

## Identity

`public/brand/logo.png`, `logo-white.png` and `public/favicon.svg` are the existing repository's approved Sbar Orbit artwork. Geometry and wordmark are unchanged.

## Illustrations

The original illustrations were generated with the built-in image generation tool on September 12, 2026 from the user-approved navy ink landing design. Three were edited with the same built-in tool on October 15, 2026 to replace the retired browser imagery with native application windows. Exact prompts and reference commit paths are recorded in [desktop-assets.json](desktop-assets.json). They are decorative illustrations, not screenshots or evidence of product behavior.

- `hero-desktop.webp`: human desk on the left, agent file manager and image editor on the right, ivory paper, navy ink and small orange accents.
- `hero-desktop-mobile.webp`: the same two desktop scenes arranged vertically, with a file manager replacing the old rear window.
- `private-desktop-apps.webp`: text editor with a file sidebar, image editor with mountain artwork and a small cactus, navy ink on ivory paper.
- `viewer-control.webp`: the original off-white ink drawing of a person watching application windows, solid navy background, no rendered controls.

WebP encoding preserves the generated dimensions. Original generated PNG files remain outside the shipped assets. The three superseded WebP assets are removed from `public/images` and are not shipped by the new build.

## Support button

`coffee-button.webp` is a lossless conversion of the user's supplied `Downloads/BuyMyCoffee/bmc-button.png`. Buy Me a Coffee branding belongs to its respective owner. The destination is the exact account URL supplied by the user.

## Typography and icons

DM Sans is distributed under the SIL Open Font License included in `public/fonts/OFL.txt`. Phosphor icons are provided by `@phosphor-icons/react` under its MIT license. Dependency licenses remain applicable separately from this repository's Apache-2.0 license.

Arabic typography uses Noto Sans Arabic Variable from the pinned Fontsource package.
Vite bundles the font subsets locally, with no request to a remote font provider.
The redistributed SIL Open Font License is in `public/fonts/NotoSansArabic-OFL.txt`.
