import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2]!;
const authorityPath = process.argv[3]!;
const orbitRepo = process.argv[5]!;
const runLabel = process.argv[6] ?? "single";
if (!/^[a-z0-9]{1,16}$/.test(runLabel)) throw new Error("Invalid fixture run label");
const ipcSnapshotOnly = process.argv.includes("ipc-snapshot-only");
const ipcWriteProbe = process.argv.includes("ipc-write-probe");
if (ipcWriteProbe && !ipcSnapshotOnly) throw new Error("IPC write probe needs the scoped snapshot fixture");
const publicAttach = process.argv[7] === "public";
if (publicAttach) {
  process.env.ORBIT_CODEX_AUTHORITY_SOCKET = authorityPath;
  process.env.ORBIT_CODEX_CANDIDATE_EXECUTABLE = join(root, "app/ChatGPT");
  process.env.ORBIT_CODEX_CANDIDATE_MANIFEST_SHA256 = process.argv[8]!;
}
const { FedoraBackend } = await import(join(orbitRepo, "src/fedora.ts"));
const { prepareCodexAttachedLaunch } = await import(join(orbitRepo, "src/native-codex-attach.ts"));
const backend = await FedoraBackend.create({ width: 1280, height: 800 });
const privateBackend = backend as any;
let prepared: Awaited<ReturnType<typeof prepareCodexAttachedLaunch>> | undefined;
let gateAuditSource: string | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
let mountVisibility: Record<string, boolean> | undefined;
let writeImagePath: string | undefined;
let writeTextVisible: boolean | undefined;
let writeAnswerVisible: boolean | undefined;
let writeErrorVisible: boolean | undefined;
try {
  const session = privateBackend.directory as string;
  gateAuditSource = join(session, "codex-gate-audit.jsonl");
  process.env.ORBIT_CODEX_GATE_METHOD_AUDIT = "1";
  let status: any;
  let privateHome: string;
  if (publicAttach) {
    status = await backend.act({ type: "launch-app", app: "codex", profile: "active" });
    const homes = (await readdir(session)).filter(entry => entry.startsWith("codex-attach-"));
    if (homes.length !== 1) throw new Error("Public action did not prepare one private Codex home");
    privateHome = join(session, homes[0]!, "home");
  } else {
  const app = join(session, "fixture-app");
  await mkdir(app, { mode: 0o700 });
  await copyFile(join(root, "app/ChatGPT"), join(app, "ChatGPT"));
  for (const entry of await readdir(join(root, "app"))) {
    if (entry !== "ChatGPT") await symlink(join(root, "app", entry), join(app, entry));
  }
  const env = privateBackend.env as NodeJS.ProcessEnv;
  const { createDisposablePaginatedReader } = await import(join(orbitRepo, "experiments/codex-paginated-bwrap-bridge.ts"));
  const baseReader = await createDisposablePaginatedReader(process.argv[8]!, process.argv[7]!);
  const fixtureDirectory = process.argv[7]!;
  const ownerDirectory = join(root, `owner-codex-orbit-${fixtureDirectory.split("-").at(-1)}`);
  const reader = async (request: any) => {
    const turnStarted = gateAuditSource && await Bun.file(gateAuditSource).exists() &&
      (await readFile(gateAuditSource, "utf8")).includes('"method":"turn/start","outcome":"allow"');
    if (request.method === "thread/turns/list" && turnStarted) {
      const refreshed = Bun.spawnSync(["/usr/bin/python3", join(import.meta.dir, "refresh-page-fixture.py"),
        ownerDirectory, fixtureDirectory, process.argv[9]!]);
      if (refreshed.exitCode !== 0) throw new Error("Fixture page refresh failed");
    }
    return await baseReader(request);
  };
  prepared = await prepareCodexAttachedLaunch(session, {
    runtimeDirectory: session,
    waylandDisplay: privateBackend.waylandDisplay,
    libraryPath: env.LD_LIBRARY_PATH ?? "",
  }, authorityPath, join(app, "ChatGPT"),
  { allowFixture: true, fixturePaginatedPageReader: reader, fixtureTurnThreadId: process.argv[9]!,
    ...(ipcSnapshotOnly ? { fixtureIpcSocketPath: join(ownerDirectory, "ipc", "ipc.sock") } : {}),
    ...(ipcWriteProbe ? { fixtureIpcTextTurn: true } : {}) });
  await copyFile(process.argv[4]!,
    join(prepared.privateHome, ".config/dconf/user"));
  const policy = {
    runtime: `/run/user/${process.getuid?.()}`,
    sockets: await privateBackend.socketPolicy("wayland", false),
    privateHome: prepared.privateHome,
    authoritySocket: prepared.authoritySocket,
    authorityStateSocket: prepared.authorityStateSocket,
    ...(ipcSnapshotOnly ? { maskedIpcDirectory: join(ownerDirectory, "ipc") } : {}),
  };
  if (ipcSnapshotOnly) {
    const probeOutput = join(session, "ipc-mount-visibility.json");
    const probeReport = join(session, "ipc-mount-visibility-report.json");
    const script = `import json,pathlib
pathlib.Path(${JSON.stringify(probeOutput)}).write_text(json.dumps({
 "ownerIpcVisible": pathlib.Path(${JSON.stringify(join(ownerDirectory, "ipc", "ipc.sock"))}).exists(),
 "privateIpcVisible": pathlib.Path(${JSON.stringify(join(process.env.HOME!, ".codex", "ipc", "ipc.sock"))}).is_socket(),
 "fixtureAppVisible": pathlib.Path(${JSON.stringify(join(root, "app", "ChatGPT"))}).is_file()
}))`;
    const probe = Bun.spawn(["/usr/bin/python3", join(orbitRepo, "src/native/supervise.py"),
      probeReport, "--desktop-mount-policy", JSON.stringify(policy), "/usr/bin/python3", "-c", script],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    await probe.exited;
    if (!await Bun.file(probeOutput).exists())
      throw new Error(`Scoped IPC mount probe failed: ${await readFile(probeReport, "utf8")}`);
    const visibility = JSON.parse(await readFile(probeOutput, "utf8"));
    mountVisibility = visibility;
    if (visibility.ownerIpcVisible || !visibility.privateIpcVisible || !visibility.fixtureAppVisible)
      throw new Error(`Scoped IPC mount visibility failed: ${JSON.stringify(visibility)}`);
  }
  const report = join(session, "attached-report.json");
  const stderrFd = openSync(join(root, "orbit-client-stderr.log"), "w", 0o600);
  child = Bun.spawn(["/usr/bin/python3", join(orbitRepo, "src/native/supervise.py"),
    report, "--coredump-filter-zero", "--desktop-mount-policy", JSON.stringify(policy), ...prepared.argv],
  { env: { ...env, GDK_BACKEND: "wayland" }, stdin: "pipe", stdout: "ignore", stderr: stderrFd });
  closeSync(stderrFd);
  for (let attempt = 0; attempt < 250; attempt++) {
    try { status = JSON.parse(await readFile(report, "utf8")); } catch {}
    if (status?.error) throw new Error(`Orbit supervisor: ${JSON.stringify(status.error)}`);
    if (status?.pid) break;
    if (child.exitCode !== null) throw new Error(`Orbit supervisor exited ${child.exitCode}`);
    await Bun.sleep(40);
  }
  if (!status?.pid) throw new Error("Orbit supervisor did not report the attached Desktop");
  privateHome = prepared.privateHome;
  }
  await Bun.sleep(40000);
  await backend.act({ type: "pointer", x: 77, y: 60 });
  await Bun.sleep(600);
  const menuFrame = await backend.observe();
  const menuPath = join(root, "orbit-product-switcher.jpg");
  await writeFile(menuPath, Buffer.from(menuFrame.image, "base64"));
  const menuOcr = Bun.spawnSync(["tesseract", menuPath, "stdout", "tsv"]);
  if (menuOcr.exitCode !== 0) throw new Error("Private product switcher OCR failed");
  const menuRows = new TextDecoder().decode(menuOcr.stdout).split("\n").map(line => line.split("\t"));
  const codex = menuRows.find(row => row[11]?.toLowerCase() === "codex" &&
    Number(row[6]) < 260 && Number(row[7]) < 500);
  if (!codex) throw new Error("Codex product item was not visible in private switcher");
  await backend.act({ type: "pointer", x: Math.round(Number(codex[6]) + Number(codex[8]) / 2),
    y: Math.round(Number(codex[7]) + Number(codex[9]) / 2) });
  await Bun.sleep(5000);
  const statePath = join(privateHome, ".codex/.codex-global-state.json");
  const state = await Bun.file(statePath).exists() ? JSON.parse(await readFile(statePath, "utf8")) : {};
  let frame = await backend.observe();
  const imagePath = join(root, `orbit-client-${runLabel}.${frame.mimeType === "image/png" ? "png" : "jpg"}`);
  const footerOnly = process.argv.includes("footer-only");
  let openedImagePath = imagePath;
  let liveImagePath: string | undefined;
  if (!footerOnly) {
    let target: string[] | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      await writeFile(imagePath, Buffer.from(frame.image, "base64"));
      const ocr = Bun.spawnSync(["tesseract", imagePath, "stdout", "tsv"]);
      if (ocr.exitCode !== 0) throw new Error("Fixture sidebar OCR failed");
      const words = new TextDecoder().decode(ocr.stdout).split("\n")
        .map(line => line.split("\t"));
      target = words.find(row => row[11]?.toLowerCase() === "conversation" &&
        Number(row[6]) > 20 && Number(row[6]) < 240 && Number(row[7]) > 100 && Number(row[7]) < 600);
      if (target && words.some(row => row[11]?.toLowerCase() === "private" &&
        row[2] === target?.[2] && row[3] === target?.[3] && row[4] === target?.[4])) break;
      target = undefined;
      await Bun.sleep(1200);
      frame = await backend.observe();
    }
    if (!target) throw new Error("Fixture conversation title was not visible within 12 seconds after initial observe");
    await backend.act({ type: "pointer", x: Math.round(Number(target[6]) + Number(target[8]) / 2),
      y: Math.round(Number(target[7]) + Number(target[9]) / 2) });
    await Bun.sleep(2500);
    const opened = await backend.observe();
    openedImagePath = join(root, `orbit-client-opened-${runLabel}.${opened.mimeType === "image/png" ? "png" : "jpg"}`);
    await writeFile(openedImagePath, Buffer.from(opened.image, "base64"));
    if (runLabel === "first" && !ipcSnapshotOnly) {
      await backend.act({ type: "pointer", x: 630, y: 710 });
      await backend.act({ type: "text", text: "Orbit private saved-thread follow-up" });
      await backend.act({ type: "key", key: "Enter" });
    }
    if (ipcSnapshotOnly) {
      const ocr = Bun.spawnSync(["tesseract", openedImagePath, "stdout"]);
      const recognized = new TextDecoder().decode(ocr.stdout);
      if (ocr.exitCode !== 0 || !recognized.includes("Private fixture conversation") ||
          !recognized.includes("Orbit completed fixture answer"))
        throw new Error("Scoped IPC fixture conversation was not visible in the private window");
      const suffix = process.argv[7]!.split("-").at(-1);
      const readyPath = join(root, `attached-ipc-ready-${suffix}`);
      const completedPath = join(root, `attached-ipc-turn-complete-${suffix}`);
      await writeFile(readyPath, "ready");
      for (let attempt = 0; attempt < 80 && !await Bun.file(completedPath).exists(); attempt++)
        await Bun.sleep(250);
      if (!await Bun.file(completedPath).exists()) throw new Error("Fixture live turn did not complete");
      let liveVisible = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        await Bun.sleep(500);
        const liveFrame = await backend.observe();
        liveImagePath = join(root, `orbit-client-live-${runLabel}.${liveFrame.mimeType === "image/png" ? "png" : "jpg"}`);
        await writeFile(liveImagePath, Buffer.from(liveFrame.image, "base64"));
        const liveOcr = Bun.spawnSync(["tesseract", liveImagePath, "stdout"]);
        const liveText = new TextDecoder().decode(liveOcr.stdout);
        if (liveOcr.exitCode === 0 && liveText.includes("Second window live update") &&
            liveText.includes("owner preflight answer")) {
          liveVisible = true;
          break;
        }
      }
      if (!liveVisible) throw new Error("Scoped IPC live turn was not visible in the private window");
      if (ipcWriteProbe) {
        if (!liveImagePath) throw new Error("Scoped IPC fixture live image is unavailable");
        const liveOcr = Bun.spawnSync(["tesseract", liveImagePath, "stdout"]);
        if (liveOcr.exitCode !== 0 || !new TextDecoder().decode(liveOcr.stdout).includes("anything"))
          throw new Error("Scoped IPC fixture composer is unavailable");
        await backend.act({ type: "pointer", x: 630, y: 710 });
        await backend.act({ type: "text", text: "Orbit scoped IPC follow-up" });
        await backend.act({ type: "key", key: "Enter" });
        writeTextVisible = false;
        writeAnswerVisible = false;
        writeErrorVisible = false;
        for (let attempt = 0; attempt < 24; attempt++) {
          await Bun.sleep(500);
          const writeFrame = await backend.observe();
          writeImagePath = join(root, `orbit-client-write-${runLabel}.${writeFrame.mimeType === "image/png" ? "png" : "jpg"}`);
          await writeFile(writeImagePath, Buffer.from(writeFrame.image, "base64"));
          const writeOcr = Bun.spawnSync(["tesseract", writeImagePath, "stdout"]);
          const writeText = new TextDecoder().decode(writeOcr.stdout);
          if (/hit a snag|Error submitting message|denied/iu.test(writeText)) writeErrorVisible = true;
          if (writeOcr.exitCode === 0) {
            writeTextVisible ||= writeText.includes("scoped IPC follow-up");
            writeAnswerVisible ||= writeText.includes("Orbit private follow-up answer");
            if (writeTextVisible && writeAnswerVisible && !writeErrorVisible) break;
          }
        }
      }
    } else {
      let afterWritePath = "";
      let answerVisible = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        await Bun.sleep(1500);
        const afterWrite = await backend.observe();
        afterWritePath = join(root, `orbit-client-after-write-${runLabel}.${afterWrite.mimeType === "image/png" ? "png" : "jpg"}`);
        await writeFile(afterWritePath, Buffer.from(afterWrite.image, "base64"));
        const ocr = Bun.spawnSync(["tesseract", afterWritePath, "stdout"]);
        const recognized = new TextDecoder().decode(ocr.stdout);
        if (ocr.exitCode === 0 && recognized.includes("owner preflight answer")) {
          answerVisible = true;
          break;
        }
      }
      process.stdout.write(JSON.stringify({ afterWritePath, answerVisible }) + "\n");
      if (!answerVisible) throw new Error("Saved private answer did not render within 18 seconds");
    }
  } else {
    await writeFile(imagePath, Buffer.from(frame.image, "base64"));
  }
  const auth = await Bun.file(join(privateHome, ".codex/auth.json")).exists();
  print({ report: status, imagePath, openedImagePath, desktopAlive: publicAttach ? status.applied === true : child?.exitCode === null,
    privateStateFile: await Bun.file(statePath).exists(),
    privateProjectCount: Object.keys(state["local-projects"] ?? {}).length,
    privateAuthFile: auth, presence: frame.presence, liveImagePath, writeImagePath,
    writeTextVisible, writeAnswerVisible, writeErrorVisible,
    mountVisibility,
    ipcGateStats: prepared?.ipcGateStats?.() });
} finally {
  if (gateAuditSource && await Bun.file(gateAuditSource).exists())
    await copyFile(gateAuditSource, join(root, `gate-audit-${runLabel}.jsonl`));
  if (child?.stdin && typeof child.stdin !== "number") child.stdin.end();
  if (child) {
    await Promise.race([child.exited, Bun.sleep(3000)]);
    if (child.exitCode === null) child.kill();
  }
  await prepared?.release();
  await backend.close();
}

function print(value: unknown) { process.stdout.write(JSON.stringify(value) + "\n"); }
