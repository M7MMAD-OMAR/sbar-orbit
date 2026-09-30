/** Installed Ptyxis command, keyboard, reopen and inherited budget evidence on an owned display. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FedoraBackend } from "../src/fedora";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const root = await mkdtemp("/tmp/orbit-ptyxis-functional-");
const marker = join(root, "executed.txt");
const metadata = join(root, "shell-metadata.txt");
for (const file of [marker, metadata]) await writeFile(file, "pending\n", { mode: 0o600 });
const output = join(process.cwd(), "output", `ptyxis-functional-${new Date().toISOString().slice(0, 10)}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const backend = await FedoraBackend.create();
const report: Record<string, unknown> = { commandExecuted: false, keyboardExecuted: false, reopened: false, inheritedBudget: false };
async function waitFor(probe: () => Promise<boolean>) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    if (await probe()) return true;
    await Bun.sleep(100);
  }
  return false;
}
const launch = (script: string) => backend.act({ type: "launch", toolkit: "wayland", selectedFiles: [marker, metadata],
  argv: ["/usr/bin/ptyxis", "--standalone", "--new-window", "--", "/usr/bin/bash", "--noprofile", "--norc", "-c",
    script, "orbit-probe", marker, metadata] });
try {
  await launch('printf "orbit-shell-executed\\n" > "$1"; cat /proc/self/cgroup > "$2"; printf "%s\\n%s\\n" "$WAYLAND_DISPLAY" "$DBUS_SESSION_BUS_ADDRESS" >> "$2"; exec /usr/bin/bash --noprofile --norc');
  report.commandExecuted = await waitFor(async () => (await readFile(marker, "utf8")) === "orbit-shell-executed\n");
  const [cgroup, wayland, bus] = (await readFile(metadata, "utf8")).trim().split("\n");
  report.inheritedBudget = cgroup === (await readFile("/proc/self/cgroup", "utf8")).trim() && cgroup.includes("/sbarorbit.slice/");
  report.privateDisplay = Boolean(wayland?.startsWith("wayland-"));
  report.privateBus = Boolean(bus?.startsWith("unix:path=/tmp/orbit-native-"));
  await backend.act({ type: "text", text: `printf 'orbit-keyboard-executed\\n' > '${marker}'` });
  await backend.act({ type: "key", key: "Enter" });
  report.keyboardExecuted = await waitFor(async () => (await readFile(marker, "utf8")) === "orbit-keyboard-executed\n");
  await backend.act({ type: "window", command: "close", tab: 1 });
  if (!await waitFor(async () => (await backend.presence()).pageCount === 0)) throw new Error("Private terminal did not close");
  // Window closure precedes lease release by the supervisor. Wait for that bounded reap.
  await Bun.sleep(1000);
  await launch('if [ "$(cat "$1")" = orbit-keyboard-executed ]; then printf "orbit-reopened\\n" > "$1"; fi; exec /usr/bin/bash --noprofile --norc');
  report.reopened = await waitFor(async () => (await readFile(marker, "utf8")) === "orbit-reopened\n");
  report.presence = await backend.presence();
  const frame = await backend.observe();
  await writeFile(join(output, "frame.jpg"), Buffer.from(frame.image, "base64"));
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await backend.close();
  await rm(root, { recursive: true });
}
report.passed = ["commandExecuted", "keyboardExecuted", "reopened", "inheritedBudget", "privateDisplay", "privateBus"].every(key => report[key] === true);
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
