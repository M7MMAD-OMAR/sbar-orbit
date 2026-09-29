import { copyFile, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { FedoraBackend } from "../src/fedora";
import { prepareCodexAttachedLaunch } from "../src/native-codex-attach";
import { createLiveFixturePageReader } from "./codex-paginated-live-page-bridge";

const [ownerSocket, ownerRoot, helperBinary, copiedApp, preferences, outputRoot, label, threadId] = process.argv.slice(2);
if (!ownerSocket || !ownerRoot || !helperBinary || !copiedApp || !preferences || !outputRoot ||
    !threadId || (label !== "first" && label !== "second") || !ownerRoot.startsWith("/tmp/orbit-paginated-live-"))
  throw new Error("Pass the explicit disposable live owner and UI fixture paths");
const backend = await FedoraBackend.create({ width: 1280, height: 800 });
const privateBackend = backend as unknown as { directory: string; env: NodeJS.ProcessEnv;
  waylandDisplay: string; socketPolicy: (kind: string, sharing: boolean) => Promise<unknown> };
let prepared: Awaited<ReturnType<typeof prepareCodexAttachedLaunch>> | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
const session = privateBackend.directory;
process.env.ORBIT_CODEX_GATE_METHOD_AUDIT = "1";
try {
  const app = join(session, "fixture-app");
  await mkdir(app, { mode: 0o700 });
  await copyFile(copiedApp, join(app, "ChatGPT"));
  const source = copiedApp.slice(0, copiedApp.lastIndexOf("/"));
  for (const entry of await readdir(source))
    if (entry !== "ChatGPT") await symlink(join(source, entry), join(app, entry));
  const env = privateBackend.env;
  const pageReader = createLiveFixturePageReader(ownerRoot, helperBinary);
  prepared = await prepareCodexAttachedLaunch(session, {
    runtimeDirectory: session, waylandDisplay: privateBackend.waylandDisplay,
    libraryPath: env.LD_LIBRARY_PATH ?? "",
  }, ownerSocket, join(app, "ChatGPT"), {
    allowFixture: true,
    fixturePaginatedPageReader: async request => {
      const page = await pageReader(request);
      const data = (page as { data?: unknown[] }).data;
      await writeFile(join(outputRoot, `private-ui-${label}-pages.jsonl`),
        JSON.stringify({ method: request.method, count: Array.isArray(data) ? data.length : null }) + "\n",
        { flag: "a", mode: 0o600 });
      return page;
    },
  });
  const socketArgument = prepared.argv.find(value =>
    value.startsWith("CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET="));
  if (!socketArgument) throw new Error("Private fixture gate socket was omitted");
  const gateSocket = socketArgument.slice("CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET=".length);
  const metadataChild = Bun.spawn(["/usr/bin/python3",
    join(import.meta.dir, "codex-paginated-gate-metadata.py"), gateSocket, threadId],
    { stdout: "pipe", stderr: "pipe" });
  const [metadataText, metadataError, metadataExit] = await Promise.all([
    new Response(metadataChild.stdout).text(), new Response(metadataChild.stderr).text(),
    metadataChild.exited]);
  if (metadataExit !== 0) {
    await writeFile(join(outputRoot, `private-ui-${label}-metadata-error.log`), metadataError,
      { mode: 0o600 });
    throw new Error(`Private projected metadata failed; full diagnostic saved for ${label}`);
  }
  const projectedMetadata = JSON.parse(metadataText);
  await writeFile(join(outputRoot, `private-ui-${label}-projected-metadata.json`),
    JSON.stringify(projectedMetadata), { mode: 0o600 });
  await copyFile(preferences, join(prepared.privateHome, ".config/dconf/user"));
  const policy = { runtime: `/run/user/${process.getuid?.()}`,
    sockets: await privateBackend.socketPolicy("wayland", false),
    privateHome: prepared.privateHome };
  const report = join(session, "attached-report.json");
  const logPath = join(outputRoot, `private-ui-${label}.log`);
  const stderrFd = openSync(logPath, "w", 0o600);
  child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "../src/native/supervise.py"),
    report, "--coredump-filter-zero", "--desktop-mount-policy", JSON.stringify(policy), ...prepared.argv],
    { env: { ...env, GDK_BACKEND: "wayland" }, stdin: "pipe", stdout: "ignore", stderr: stderrFd });
  closeSync(stderrFd);
  let status: { pid?: number; error?: unknown } = {};
  for (let attempt = 0; attempt < 250; attempt++) {
    try { status = JSON.parse(await readFile(report, "utf8")); } catch {}
    if (status.error) throw new Error(`Private Desktop supervisor: ${JSON.stringify(status.error)}`);
    if (status.pid) break;
    if (child.exitCode !== null) throw new Error(`Private Desktop exited ${child.exitCode}`);
    await Bun.sleep(40);
  }
  if (!status.pid) throw new Error("Private Desktop did not launch");
  const processStat = await readFile(`/proc/${status.pid}/stat`, "utf8");
  const pidStartTick = processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  await Bun.sleep(25000);
  await backend.act({ type: "pointer", x: 77, y: 60 });
  await Bun.sleep(500);
  let frame = await backend.observe();
  const menuPath = join(outputRoot, `private-ui-${label}-menu.jpg`);
  await writeFile(menuPath, Buffer.from(frame.image, "base64"));
  const menuRows = ocr(menuPath);
  const codex = menuRows.find(row => row[11]?.toLowerCase() === "codex" &&
    Number(row[6]) < 260 && Number(row[7]) < 500);
  if (!codex) throw new Error("Codex product was not visible in private switcher");
  await backend.act({ type: "pointer", x: Math.round(Number(codex[6]) + Number(codex[8]) / 2),
    y: Math.round(Number(codex[7]) + Number(codex[9]) / 2) });
  await Bun.sleep(4000);
  let target: string[] | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    frame = await backend.observe();
    const sidebarPath = join(outputRoot, `private-ui-${label}-sidebar.jpg`);
    await writeFile(sidebarPath, Buffer.from(frame.image, "base64"));
    const words = ocr(sidebarPath);
    target = words.find(row => row[11]?.toLowerCase() === "conversation" &&
      Number(row[6]) > 20 && Number(row[6]) < 240 && Number(row[7]) > 100 && Number(row[7]) < 600 &&
      words.some(part => part[11]?.toLowerCase() === "private" && part[2] === row[2] &&
        part[3] === row[3] && part[4] === row[4]));
    if (target) break;
    await Bun.sleep(1000);
  }
  if (target) {
    await backend.act({ type: "pointer", x: Math.round(Number(target[6]) + Number(target[8]) / 2),
      y: Math.round(Number(target[7]) + Number(target[9]) / 2) });
  } else {
    // This coordinate is only for the fixed 1280 by 800 disposable fixture.
    // Tesseract can return a blank box for the dark project's nested title.
    await backend.act({ type: "pointer", x: 130, y: 266 });
  }
  await Bun.sleep(2500);
  frame = await backend.observe();
  const opened = join(outputRoot, `private-ui-${label}-opened.jpg`);
  await writeFile(opened, Buffer.from(frame.image, "base64"));
  const words = ocr(opened).map(row => row[11] ?? "").join(" ");
  let scrolledUp: string | null = null;
  let scrolledUpText: string | null = null;
  let scrolledDown: string | null = null;
  let scrolledDownText: string | null = null;
  if (label === "second") {
    await backend.act({ type: "scroll", x: 850, y: 350, deltaY: -20 });
    await Bun.sleep(700);
    const upFrame = await backend.observe();
    scrolledUp = join(outputRoot, "private-ui-second-scrolled-up.jpg");
    await writeFile(scrolledUp, Buffer.from(upFrame.image, "base64"));
    scrolledUpText = ocr(scrolledUp).map(row => row[11] ?? "").join(" ");
    await backend.act({ type: "scroll", x: 850, y: 350, deltaY: 20 });
    await Bun.sleep(700);
    const downFrame = await backend.observe();
    scrolledDown = join(outputRoot, "private-ui-second-scrolled-down.jpg");
    await writeFile(scrolledDown, Buffer.from(downFrame.image, "base64"));
    scrolledDownText = ocr(scrolledDown).map(row => row[11] ?? "").join(" ");
  }
  const gateAudit = join(session, "codex-gate-audit.jsonl");
  if (await Bun.file(gateAudit).exists())
    await copyFile(gateAudit, join(outputRoot, `private-ui-${label}-gate.jsonl`));
  process.stdout.write(JSON.stringify({ label, screenshot: opened, screenshotText: words.slice(0, 3000),
    scrolledUp, scrolledUpText, scrolledDown, scrolledDownText,
    desktopPid: status.pid, desktopPidStartTick: pidStartTick, projectedMetadata,
    privateAuthFile: await Bun.file(join(prepared.privateHome, ".codex/auth.json")).exists(),
    desktopAlive: child.exitCode === null }) + "\n");
} finally {
  if (child?.stdin && typeof child.stdin !== "number") child.stdin.end();
  if (child) {
    await Promise.race([child.exited, Bun.sleep(3000)]);
    if (child.exitCode === null) child.kill();
  }
  await prepared?.release();
  await backend.close();
}

function ocr(path: string): string[][] {
  const result = Bun.spawnSync(["tesseract", path, "stdout", "tsv"]);
  if (result.exitCode !== 0) throw new Error("Private fixture OCR failed");
  return new TextDecoder().decode(result.stdout).split("\n").map(line => line.split("\t"));
}
