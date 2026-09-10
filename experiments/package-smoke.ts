import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { call } from "../src/ipc";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const name = `sbar-orbit-${version}-source`;
const archive = resolve(`output/packages/${name}.tar.gz`);
const scratch = await mkdtemp("/tmp/orbit-package-smoke-");
try {
const run = async (args: string[], cwd = scratch) => {
  const child = Bun.spawn(["/usr/bin/timeout", "--kill-after=5", "45", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`Package command failed (${code}): ${stderr}`);
  return stdout;
};
const listing = (await run(["/usr/bin/tar", "-tzf", archive])).trim().split("\n");
if (listing.some(path => /(^|\/)(node_modules|output|\.private|\.runtime|\.secrets|__pycache__)(\/|$)/.test(path) || /\/docs\/(evidence|superpowers)\/|\/\.env(?:\.|$)/.test(path) || path.includes(".."))) throw new Error("Forbidden archive entry");
await run(["/usr/bin/tar", "-xzf", archive, "-C", scratch]);
const root = join(scratch, name);
const manifest = JSON.parse(await readFile(join(root, "SOURCE-MANIFEST.json"), "utf8")) as { files: { path: string; sha256: string }[] };
for (const file of manifest.files) {
  const actual = createHash("sha256").update(await readFile(join(root, file.path))).digest("hex");
  if (actual !== file.sha256) throw new Error(`Manifest mismatch: ${file.path}`);
}
await run([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], root);
const launcher = join(root, "bin/sbar-orbit");
if (!(await run([launcher, "--help"])).includes("connector-config")) throw new Error("Missing launcher help");
const broker = Bun.spawn([launcher, "serve"], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
const reader = broker.stdout.getReader();
const stderr = new Response(broker.stderr).text();
try {
  let line = "";
  while (!line.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Packaged broker exited before startup");
    line += new TextDecoder().decode(chunk.value);
  }
  const { socket } = JSON.parse(line.split("\n")[0]!);
  const session = await call(socket, "session.create", { backend: "browser" }) as { sessionId: string };
  const frame = await call(socket, "session.observe", session) as { image: string };
  if (Buffer.from(frame.image, "base64").subarray(1, 4).toString() !== "PNG") throw new Error("Packaged browser capture failed");
  const { launchChrome } = await import(join(root, "src/chrome.ts"));
  const { createWorkspaceDirectory } = await import(join(root, "src/workspace-storage.ts"));
  const viewer = await launchChrome(await createWorkspaceDirectory("package-viewer"));
  try {
    const { url } = await call(socket, "preview.open") as { url: string };
    await viewer.page.goto(url);
    await viewer.page.waitForFunction(() => {
      const frame = document.querySelector<HTMLCanvasElement>("#frame");
      return frame instanceof HTMLCanvasElement && !frame.hidden && Number(frame.dataset.capturedAt) > 0
        && frame.width === 1280 && frame.height === 800 && frame.getContext("2d")!.getImageData(0, 0, 1, 1).data[3] === 255;
    }, undefined, { timeout: 5000 });
  } finally { await viewer.close(); }
  await call(socket, "session.stop", session);
  broker.kill("SIGTERM");
  if (await broker.exited !== 0) throw new Error("Packaged broker did not stop cleanly");
  await rm(join(root, "node_modules"), { recursive: true, force: true });
  const report = { temporaryDependenciesRemoved: true, status: "passed", version, sha256: createHash("sha256").update(await readFile(archive)).digest("hex"),
    manifestFilesVerified: manifest.files.length, dependenciesInstalled: true, browserCapture: true, packagedViewerCanvas: true, brokerStopped: true,
    excludedRuntimeData: true, rootEntries: await readdir(root),
    limitations: ["Source archive tested on this Fedora host with existing Bun and Chrome; native runtime/bootstrap, global installation and uninstall are not tested."] };
  await Bun.write("output/packages/smoke.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (broker.exitCode === null) broker.kill("SIGTERM");
  await broker.exited; reader.releaseLock(); await stderr;
}

} finally {
  await rm(join(scratch, name, "node_modules"), { recursive: true, force: true });
}
