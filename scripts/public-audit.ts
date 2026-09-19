import { isPublicSourcePath } from "./public-paths";
/** Inspect index blobs, not the working tree, so the exact staged publication is checked. */
const git = async (...args: string[]) => {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  const data = await new Response(child.stdout).arrayBuffer();
  if (await child.exited) throw new Error("Cannot inspect the Git index");
  return Buffer.from(data);
};
/**
 * Binaries that have had the review the `binary-needs-explicit-publication-review` rule asks for.
 *
 * Keyed by content, not by path, so replacing an approved file with different bytes fails the audit
 * again rather than inheriting its approval. Each of these was opened and looked at: flat brand
 * artwork, generated website illustrations, the supplied coffee button, and the licensed DM Sans
 * font. Website provenance is recorded in website/ASSETS.md. Images contain no personal metadata
 * or captures of the person's machine. A binary that is not listed here still fails, which is the whole point of the rule.
 */
const reviewedBinaries = new Map([
  ["brand/logo/lockup-arabic-black.png", "3193c90cc1a4f8168e99e1d803d1d8068fcab8515df26d05db3152f7b4fc0b13"],
  ["brand/logo/lockup-arabic-blue.png", "37d8b8c2c2572f0abb3ab1b347db321b29c344b8b936b0e1f24a5bff65d03632"],
  ["brand/logo/lockup-arabic-reversed.png", "d1820a2268785b1a837fd9bf81f2bb2474a33f551ecb462a66a4888948be3fcf"],
  ["brand/logo/lockup-arabic-white.png", "51af43648e1e40f3dbc3b17b6974f60a5e8e71c0f6c301fba54e007799725607"],
  ["brand/logo/lockup-latin-black.png", "180a3dd82e83aafb6cd2f4437ada341ff19892e993bb2627b5b34fca4d85635b"],
  ["brand/logo/lockup-latin-blue.png", "9f2fd99fdc6f92921d73a515c15199b652d741d35038ea776c7160298b020277"],
  ["brand/logo/lockup-latin-reversed.png", "e4ba34e197bf3dfe69a34e70bef496fa82796b43192f469673a4dba4e57a40c4"],
  ["brand/logo/lockup-latin-white.png", "8f503621e67e794946247dac93ae0f12b4d2d12946376c19c27b7da6d6a9c07e"],
  ["brand/logo/mark-black.png", "e22b658f87f66abbf24e5f4e52fa010dbfde39b8b2a42c142bde729cc95ff407"],
  ["brand/logo/mark-blue.png", "f98a558b41bb1f6d1b2635f2757da0c69094203fb397a0ae9763a76fe09a131b"],
  ["brand/logo/mark-white.png", "2342f42a14facb079c7535f1bcdb4e45b658d179ca75aa9f7a6a562997e80884"],
  // Reviewed 14 September 2026: an Orbit private display or the viewer, no personal window, no account.
  ["docs/images/dolphin-in-private-display.jpg", "86eae2ca1ad62e58f2d5cb04f122cc7f5f9dd6fc288c08503578f0df69104cf8"],
  // Reviewed 14 September 2026: an Orbit private display or the viewer, no personal window, no account.
  ["docs/images/extension-headed-private-display.jpg", "e9195720647e4a58994a20a44becde868f1f14a60dac4214bb3bdd9aa52a4105"],
  // Reviewed 14 September 2026: an Orbit private display or the viewer, no personal window, no account.
  ["docs/images/viewer-window.jpg", "4b6f7af5a2ef21bd3a36dbff9377712e5fee189ce43e8602c34079503b8b0875"],
  // Reviewed 14 September 2026: an Orbit private display or the viewer, no personal window, no account.
  ["docs/images/writer-in-private-display.jpg", "33af88f1c9337bb12b9786da3950f3be14e6d6304d8773898677219bb82ed643"],
  // Reviewed 19 September 2026, and the one exception to the line above: this frame is the person's
  // own desktop, published at their request, because the panel is the one part of Orbit that lives
  // there and no private display can show it. What is in it was looked at rather than assumed: a
  // wallpaper, a clock, and one session card carrying an agent name and a task the person wrote.
  // No window contents, no account, no file path, no address bar, and the metadata was stripped at
  // export rather than trusted to be absent.
  ["docs/images/panel-card-on-desktop.jpg", "716fd377ea867250b1314767f583b6dbde7c77ca65acb9775205f835720617e5"],
  // The same frame, cropped closer onto the card for the glass section. Same review, same content.
  ["docs/images/panel-card-detail.jpg", "8904fab65af445f13f7a0aea661c4ea87483e38927b14efbec508f1aa05fc938"],
  ["website/public/brand/logo-white.png", "8f503621e67e794946247dac93ae0f12b4d2d12946376c19c27b7da6d6a9c07e"],
  ["website/public/brand/logo.png", "9f2fd99fdc6f92921d73a515c15199b652d741d35038ea776c7160298b020277"],
  ["website/public/fonts/dm-sans-latin.woff2", "9fea608a947e67020c33cad9a6fe3d60c54119dfb8cff87768a8117a15ed7543"],
  ["website/public/images/coffee-button.webp", "3ac30a2d7298247e8b8e5a1b98588384d605a97ab3c7cfb0524d321bf7f2ab77"],
  ["website/public/images/hero-workspaces-mobile.webp", "670cf3ce1faaf062c3bf54fb922ead94469f17ebb1df235b2c270e62507d9ca0"],
  ["website/public/images/hero-workspaces.webp", "95f1abd83e4eae7af815a471d6250f0f466b48c38156685c666ca896598e8a61"],
  ["website/public/images/private-spaces.webp", "b8bc68bee393dca90f60f5b65468a34a6b2c356096acf505d4553853425c361e"],
  ["website/public/images/viewer-control.webp", "055956a37290e6724564a84ad16decdb1ef09f5ec3e6dbe24a535524dfc4f8e7"],
]);

const files = (await git("ls-files", "--cached", "-z")).toString().split("\0").filter(Boolean);
if (!files.length) throw new Error("Stage the intended public files before auditing");
const findings: { file: string; rule: string }[] = [];
for (const file of files) {
  if (!isPublicSourcePath(file))
    findings.push({ file, rule: "private-or-generated-path" });
  const bytes = await git("show", `:${file}`);
  if (bytes.includes(0)) {
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (reviewedBinaries.get(file) !== digest) findings.push({ file, rule: "binary-needs-explicit-publication-review" });
    continue;
  }
  const content = bytes.toString("utf8");
  const rules: [string, RegExp][] = [
    // `example` is exempt, and only that exact name: it is the reserved documentation name, the same
    // convention the email rule below already allows through `example.com`. A test that states a
    // macOS path has to state SOME home directory, and the readable choice is the one that cannot
    // belong to anybody. Every other name is still reported, including short ones.
    //
    // `linuxbrew` is exempt for a different reason: `/home/linuxbrew/.linuxbrew` is Homebrew's own
    // documented prefix on Linux, a fixed system path rather than a person, and documentation that
    // cannot write it down is documentation that has to paraphrase a real installation path.
    ["personal-home-path", /\/(?:home|Users)\/(?!example\/|linuxbrew\/)[a-zA-Z0-9._-]+\//],
    ["windows-user-path", /[A-Z]:\\Users\\[^\\\s]+\\/i],
    ["private-task-link", /thread:\/\/|\?hostId=[l]ocal/],
    ["private-network-address", /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
    ["private-key-material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ];
  for (const [rule, pattern] of rules) if (pattern.test(content)) findings.push({ file, rule });
  // The macOS refusal list, checkable from any host, which is the whole reason it is worth having.
  //
  // Every one of these is a call that raises a TCC dialog on the person's screen, and each is a
  // route Orbit does not need: frames come from CDP, input goes through CDP, and there is no reason
  // to script another application. A source grep cannot see a dialog raised by a CHILD process, so
  // this is necessary and not sufficient, and docs/porting.md says so beside the table. What it can
  // do is fail the build the day somebody reaches for one of them.
  //
  // `sourceFile` narrows this to code: a documentation page that NAMES these symbols in order to
  // promise Orbit does not call them is the rule working, not a violation of it, and the tables in
  // docs/porting.md and docs/support-tiers.md do exactly that.
  //
  // This file is excluded for the same reason and it is not a loophole: the rules have to spell the
  // symbols they forbid, so an audit that scanned itself would always fail. Its test is excluded on
  // the same ground, because a test that proves the rules fire has to contain the strings that make
  // them fire. `tests/public-audit.test.ts` is what guards these rules instead, by feeding them
  // known-bad sources through the real script and asserting each one is refused by name.
  //
  // The exemption is by exact path, never by pattern: `scripts/public-audit*` would let anybody
  // silence a finding by naming a file to match, which is the one way this list could be defeated
  // from inside the repository.
  const selfReferential = file === "scripts/public-audit.ts" || file === "tests/public-audit.test.ts";
  const sourceFile = /^(?:src|scripts|bin|desktop|viewer|experiments|tests)\//.test(file)
    && !file.endsWith(".md") && !selfReferential;
  if (sourceFile) {
    const forbidden: [string, RegExp][] = [
      // Screen Recording. Frames come from CDP, so none of these is needed.
      //
      // Written as PREFIXES rather than exact symbol names, because an audit probe showed the exact
      // form missing every realistic spelling: `CGWindowListCreateImageFromArray` is a different
      // symbol from `CGWindowListCreateImage`, `CGDisplayCreateImage` was not in the list at all,
      // and `screencapture` was anchored to `/usr/sbin/` so a bare spawn of it walked straight past.
      // A rule that only catches the one spelling somebody happened to write down is a rule that
      // fails the first time anybody writes the call for real.
      ["macos-screen-recording", /\bCGWindowList\w*|\bCGDisplay(?:Create|Stream)\w*|\bSC(?:Stream|ShareableContent|Display|Window|ContentFilter)\w*|\bscreencapture\b/],
      // Accessibility, and posting synthetic input to another process. `AX` covers the whole API
      // surface rather than `AXUIElement` alone, and the cursor warp calls are input even though
      // their names say display.
      ["macos-accessibility", /\bAX[A-Z]\w*|\bCGEventPost\w*|\bCGWarpMouseCursorPosition\b|\bCGDisplayMoveCursorToPoint\b/],
      // Input Monitoring: an event tap of any flavour, or raw HID in either direction.
      ["macos-input-monitoring", /\bCGEventTap\w*|\bIOHID\w*/],
      // Automation and Apple Events. Driving another application is the thing this project refuses,
      // and `NSWorkspace` open is the quiet way to do it.
      ["macos-automation", /\bNSAppleScript\b|\bosascript\b|\bAESend\w*|\bNSWorkspace\b/],
      // Downloading a browser or a helper: first launch of a quarantined binary prompts.
      ["macos-quarantine-risk", /com\.apple\.quarantine/],
      // The Command Line Tools installer. `/usr/bin/python3` is a STUB on a Mac without them and
      // raises the installer as a window on the person's screen, which is why `bin/sbar-orbit`
      // refuses its Python subcommands on darwin rather than letting the path be reached.
      ["macos-clt-installer-risk", /\bxcode-select\b/],
    ];
    for (const [rule, pattern] of forbidden) if (pattern.test(content)) findings.push({ file, rule });
    // A grep cannot see a symbol assembled at runtime, and saying so in the audit is better than
    // letting the audit's silence be read as proof. A `dlopen` whose argument is not a plain string
    // literal, or a bun:ffi `.symbols[...]` lookup by expression, is reported for a person to look
    // at rather than failed: both are legitimate in this codebase, and the point is that the TCC
    // claim rests on review here rather than on this scan. docs/porting.md states the same limit.
    //
    // Scoped to TypeScript and to `.symbols[`, not any `symbols[`: the first version matched an
    // ordinary C array index in `experiments/fedora-display/pointer.c`, which is a Linux keyboard
    // helper with no dynamic loading in it at all. A rule that cries wolf on unrelated code is a
    // rule people learn to ignore, which is worse than not having it.
    if (/\.tsx?$/.test(file) && (/\bdlopen\s*\(\s*[^"'`)]/.test(content) || /\.symbols\s*\[\s*[^"'`\]]/.test(content)))
      findings.push({ file, rule: "macos-dynamic-symbol-needs-review" });
  }
  for (const email of content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? []) {
    // A systemd template unit has the shape of an address and is not one. `user@1000.service` is the
    // thing this project's own installer starts, so a rule that cannot write it down is a rule that
    // stops the documentation rather than a leak.
    //
    // Every suffix here is singular, and that is the whole safety of this skip rather than a style
    // choice: none of these eleven words is a registered top level domain, so nothing that is really
    // an address can end in one. `.services` IS a real gTLD, so adding it, or pluralising the list to
    // tidy it, would blind this audit to every address at a `.services` domain. Add a suffix only
    // after checking it against the TLD list.
    //
    // The local part below is narrower than the one the match above accepts, which leaves `+` and `%`
    // outside the skip, so a name carrying either is still reported even with a unit suffix. That
    // asymmetry is deliberate. It errs toward reporting, and a unit instance name does not carry
    // those characters anyway. The example is not written out here, because writing it would be a
    // finding in this very file, which is the rule working.
    if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]*\.(?:service|socket|slice|target|timer|mount|automount|path|scope|swap|device)$/.test(email)) continue;
    if (!/@(?:example\.(?:com|org|invalid)|users\.noreply\.github\.com)$/.test(email)) findings.push({ file, rule: "email-needs-publication-review" });
  }
}
console.log(JSON.stringify({ filesChecked: files.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
