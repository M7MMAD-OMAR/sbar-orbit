import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Sessions } from "../src/session";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const dialog = process.argv.includes("--dialog");
const root = await mkdtemp("/tmp/orbit-editor-");
const file = join(root, "document.txt");
const untouched = join(root, "untouched.txt");
await writeFile(file, "Replace this disposable text\n");
await writeFile(untouched, "Must remain unchanged\n");
for (const name of ["config", "data", "cache", "state"]) await mkdir(join(root, name));
const sessions = new Sessions(root);
const report: Record<string, unknown> = { status: "running", application: "GNOME Text Editor", openMethod: dialog ? "file-dialog" : "launch-argument" };
let pid: number | undefined;
try {
  const session = await sessions.dispatch({ method: "session.create", params: { backend: "fedora" } }) as { sessionId: string };
  const act = (action: unknown) => sessions.dispatch({ method: "session.act", params: { ...session, requestId: crypto.randomUUID(), action } });
  const app = await act({ type: "launch", toolkit: "wayland", argv: ["/usr/bin/env",
    `XDG_CONFIG_HOME=${root}/config`, `XDG_DATA_HOME=${root}/data`, `XDG_CACHE_HOME=${root}/cache`, `XDG_STATE_HOME=${root}/state`,
    "/usr/bin/gnome-text-editor", "--standalone", ...(dialog ? [] : [file])] }) as { pid: number };
  pid = app.pid;
  // Mapping does not prove the asynchronous file load has finished.
  // This application-specific probe uses a settle period, not a readiness API.
  await Bun.sleep(1000);
  if (dialog) {
    await act({ type: "key", key: "Ctrl+O" });
    await Bun.sleep(500);
    await act({ type: "key", key: "Ctrl+L" });
    await Bun.sleep(100);
    await act({ type: "paste", text: file });
    await Bun.sleep(250);
    const chooser = await sessions.dispatch({ method: "session.observe", params: session }) as { image: string };
    await mkdir("output/native", { recursive: true });
    await Bun.write("output/native/file-dialog.jpg", Buffer.from(chooser.image, "base64"));
    await act({ type: "key", key: "Enter" });
    await Bun.sleep(1000);
  }
  await act({ type: "pointer", x: 240, y: 100 });
  await Bun.sleep(100);
  await act({ type: "key", key: "Ctrl+A" });
  await Bun.sleep(100);
  const text = "مرحبا من Orbit 🌍\nA real application saved this file.";
  const expected = text + "\n";
  await act({ type: "paste", text });
  // Paste is asynchronous. This probe allows a short settle before a single save.
  await Bun.sleep(250);
  await act({ type: "key", key: "Ctrl+S" });
  let actual = "";
  for (let i = 0; i < 100; i++) {
    actual = await readFile(file, "utf8");
    if (actual === expected) break;
    await Bun.sleep(50);
  }
  const frame = await sessions.dispatch({ method: "session.observe", params: session }) as { image: string };
  await mkdir("output/native", { recursive: true });
  await Bun.write(`output/native/${dialog ? "editor-dialog-result" : "editor"}.jpg`, Buffer.from(frame.image, "base64"));
  report.actualText = actual;
  if (actual !== expected) throw new Error("Editor did not save the expected text");
  if (await readFile(untouched, "utf8") !== "Must remain unchanged\n") throw new Error("Unselected file changed");
  Object.assign(report, { status: "passed", fileContent: actual, unselectedFileUnchanged: true,
    limitations: ["One selected temporary file in GNOME Text Editor; not a concurrent-edit or all-application proof.", "Uses application-specific focus coordinates and settle delays, including 1 second after mapping and 250 ms before save; general application readiness remains open."] });
} catch (error) { report.status = "failed"; report.error = error instanceof Error ? error.message : String(error); throw error; }
finally {
  await sessions.close();
  report.applicationExited = pid === undefined || !await Bun.file(`/proc/${pid}/stat`).exists();
  await Bun.write(`output/native-editor${dialog ? "-dialog" : ""}.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
