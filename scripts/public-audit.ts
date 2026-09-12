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
    ["personal-home-path", /\/(?:home|Users)\/[a-zA-Z0-9._-]+\//],
    ["windows-user-path", /[A-Z]:\\Users\\[^\\\s]+\\/i],
    ["private-task-link", /thread:\/\/|\?hostId=[l]ocal/],
    ["private-network-address", /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
    ["private-key-material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ];
  for (const [rule, pattern] of rules) if (pattern.test(content)) findings.push({ file, rule });
  for (const email of content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? []) {
    if (!/@(?:example\.(?:com|org|invalid)|users\.noreply\.github\.com)$/.test(email)) findings.push({ file, rule: "email-needs-publication-review" });
  }
}
console.log(JSON.stringify({ filesChecked: files.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
