import { expect, test } from "bun:test";
import { linuxOnlySuite } from "./platform-support";
const linuxTest = linuxOnlySuite("Private AT-SPI uses Linux process and bus identities");
import { parseNativeAction } from "../src/fedora";
import { orbitActionSchema } from "../src/mcp";
import { classify } from "../src/policy";

test("private semantic inspection has a strict read-only public contract", () => {
  const action = { type: "inspect", windowId: "session:42" } as const;
  expect(orbitActionSchema.safeParse(action).success).toBe(true);
  expect(classify("inspect")).toBe("read");
  expect(parseNativeAction(action)).toEqual(action);
  for (const invalid of [{ ...action, pid: 42 }, { ...action, windowId: "" }, { ...action, windowId: "x".repeat(129) }]) {
    expect(orbitActionSchema.safeParse(invalid).success).toBe(false);
    expect(() => parseNativeAction(invalid)).toThrow();
  }
  for (const type of ["invoke", "set-text"]) expect(() => parseNativeAction({ type, windowId: action.windowId })).toThrow();
});

test("semantic inspection is classified as read without mutation authority", () => {
  expect(classify("inspect")).toBe("read");
});

import { accessibilityEnvironment, accessibilityProcess, accessibilityReply } from "../src/private-accessibility";
import { FedoraBackend } from "../src/fedora";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

test("accessibility environment cannot inherit owner bus or starter addresses", () => {
  const env = accessibilityEnvironment("/tmp/private", { AT_SPI_BUS_ADDRESS: "unix:path=/owner", DBUS_SESSION_BUS_ADDRESS: "owner", DBUS_STARTER_ADDRESS: "owner", NO_AT_BRIDGE: "1", AT_SPI_REGISTRY: "owner" });
  expect(env.AT_SPI_BUS_ADDRESS).toBe("unix:path=/tmp/private/at-spi/bus");
  expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/tmp/private/bus");
  expect(env.DBUS_STARTER_ADDRESS).toBeUndefined();
  expect(env.AT_SPI_REGISTRY).toBeUndefined();
  expect(env.NO_AT_BRIDGE).toBeUndefined();
});

linuxTest("read-only accessibility rejects foreign senders, ambiguous windows and stale processes", async () => {
  const child = Bun.spawn(["/usr/bin/python3", "tests/private_accessibility_test.py"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
});

const nativeTest = process.platform === "linux" && process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip;
nativeTest("private desktop inspection reads only its exact window and reaps the accessibility bus", async () => {
  const root = await mkdtemp("/tmp/orbit-a11y-test-");
  const script = join(root, "fixture.py"), report = join(root, "report.json");
  await writeFile(script, `import gi,json,os,sys\nfrom pathlib import Path\ngi.require_version("Gtk","3.0")\nfrom gi.repository import Gtk\nw=Gtk.Window(title="Orbit semantic fixture")\nw.add(Gtk.Button(label="Private semantic button"))\nw.connect("destroy",Gtk.main_quit)\nw.show_all()\nPath(sys.argv[1]).write_text(json.dumps({"bus":os.environ.get("AT_SPI_BUS_ADDRESS"),"runtime":os.environ["XDG_RUNTIME_DIR"]}))\nGtk.main()\n`);
  let backend: FedoraBackend | undefined;
  const previous = process.env.AT_SPI_BUS_ADDRESS;
  try {
    process.env.AT_SPI_BUS_ADDRESS = "unix:path=/definitely-not-the-private-accessibility-bus";
    backend = await FedoraBackend.create();
    await backend.act({ type: "launch", argv: ["/usr/bin/python3", script, report], toolkit: "wayland" });
    const windows = await backend.act({ type: "list-windows" }) as { windows: { windowId: string; title: string }[] };
    const window = windows.windows.find(item => item.title === "Orbit semantic fixture");
    expect(window).toBeDefined();
    if (!window) throw new Error("Fixture window missing");
    let result: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { result = await backend.act({ type: "inspect", windowId: window.windowId }) as Record<string, unknown>; break; }
      catch { await Bun.sleep(100); }
    }
    expect(result).toBeDefined();
    expect(JSON.stringify(result)).toContain("Private semantic button");
    expect(result?.mutations).toBe("unsupported");
    await expect(backend.act({ type: "inspect", windowId: "foreign:42" })).rejects.toThrow("private session");
    const environment = await Bun.file(report).json();
    expect(environment.bus).toBe(`unix:path=${environment.runtime}/at-spi/bus`);
    const services = await Bun.file(join(environment.runtime, "accessibility-ready.json")).json();
    process.kill(services.service[0], "SIGTERM");
    for (let attempt = 0; attempt < 100 && backend.capabilities.includes("inspect"); attempt++) await Bun.sleep(20);
    expect(backend.capabilities).not.toContain("inspect");
    await expect(backend.act({ type: "inspect", windowId: window.windowId })).rejects.toThrow("unavailable");
    await expect(backend.act({ type: "pointer", x: 20, y: 20 })).resolves.toBeDefined();
    await expect(backend.act({ type: "list-windows" })).resolves.toBeDefined();
    const afterFailure = join(root, "after-failure.json");
    await backend.act({ type: "launch", argv: ["/usr/bin/python3", script, afterFailure], toolkit: "wayland" });
    expect((await Bun.file(afterFailure).json()).bus).toBeNull();
    await backend.close(); backend = undefined;
    for (const [pid, start] of [services.service, services.launcher, services.registry, services.socket[2]]) {
      expect(await accessibilityProcess(pid).catch(() => undefined)).not.toBe(start);
    }
    await expect(stat(environment.runtime)).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.AT_SPI_BUS_ADDRESS; else process.env.AT_SPI_BUS_ADDRESS = previous;
    await backend?.close(); await rm(root, { recursive: true, force: true });
  }
}, 60_000);

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

test("accessibility waits for final stdout bytes after process exit", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  const reply = accessibilityReply(child);
  child.stdout.write('{"nodes":[]');
  child.emit("exit", 0);
  child.stdout.end(',"truncated":false}');
  child.emit("close", 0);
  expect(await reply).toEqual({ nodes: [], truncated: false });
});

linuxTest("optional accessibility startup failure cleans up without closing the desktop", async () => {
  const directory = await mkdtemp("/tmp/orbit-a11y-failure-");
  let desktopClosed = false;
  const backend = Object.assign(Object.create(FedoraBackend.prototype), {
    directory, env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: directory }, bus: {},
    capabilities: [], children: [], cleanupFailures: [],
    close: async () => { desktopClosed = true; },
    wait: async () => { throw new Error("injected readiness failure"); },
  }) as { startAccessibility(): Promise<void>; capabilities: string[] };
  try {
    await expect(backend.startAccessibility()).resolves.toBeUndefined();
    expect(desktopClosed).toBe(false);
    expect(backend.capabilities).not.toContain("inspect");
  } finally {
    // Only clean up the fixture's captured supervisor if the pre-fix implementation left it running.
    const service = (backend as unknown as { accessibility?: { child: import("node:child_process").ChildProcess } }).accessibility;
    if (service?.child.pid && service.child.exitCode === null && service.child.signalCode === null) {
      const exited = new Promise<void>(resolve => service.child.once("exit", () => resolve()));
      service.child.stdin?.end(); await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
