import { expect, spyOn, test } from "bun:test";
import { BrowserBackend } from "../src/browser";
import { startBroker, call } from "../src/ipc";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp";
import { DesktopSessions } from "../src/desktop-session";
import * as legacyPlatform from "../src/platform";
import * as hostBrowsers from "../src/host-browsers";
import * as childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { linuxOnlySuite } from "./platform-support";
import { FedoraBackend, parseNativeAction } from "../src/fedora";

linuxOnlySuite("Private HOME application launches use the Linux Fedora backend")("generic desktop launches use a private HOME instead of locking the owner's profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-home-regression-"));
  const session = join(root, "session"), owner = join(root, "owner");
  await mkdir(session, { mode: 0o700 });
  await mkdir(join(owner, ".zen"), { recursive: true });
  const lock = join(owner, ".zen", "lock");
  await writeFile(lock, "owner profile stays untouched");
  let launchedEnv: NodeJS.ProcessEnv | undefined;
  const intercepted = new Error("Launch intercepted before the supervisor");
  const launch = spyOn(childProcess, "spawn").mockImplementation((_file, _args?, options?) => {
    launchedEnv = (options as childProcess.SpawnOptions).env;
    throw intercepted;
  });
  try {
    const backend = Object.assign(Object.create(FedoraBackend.prototype), {
      parseAction: parseNativeAction, closed: false, children: [], directory: session,
      env: { ...process.env, HOME: owner }, socketPolicy: async () => [],
    }) as FedoraBackend;
    await expect(backend.act({ type: "launch", argv: ["/usr/bin/true"], toolkit: "wayland" }))
      .rejects.toBe(intercepted);
    expect(launchedEnv?.HOME).toBe(join(session, "home"));
    expect((await stat(join(session, "home"))).mode & 0o777).toBe(0o700);
    // A real child resolves a HOME-based profile, as Zen does, without starting a browser.
    const probe = Bun.spawn(["/usr/bin/python3", "-c", [
      "from pathlib import Path",
      "profile = Path.home() / '.zen'",
      "profile.mkdir()",
      "(profile / 'lock').write_text('private profile')",
      "print(profile)",
    ].join("\n")], { env: launchedEnv, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited,
    ]);
    expect({ code, err, out: out.trim() }).toEqual({ code: 0, err: "", out: join(session, "home", ".zen") });
    expect(await readFile(lock, "utf8")).toBe("owner profile stays untouched");
  } finally { launch.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("public broker refuses browser creation before launching an application", async () => {
  const launch = spyOn(BrowserBackend, "create").mockRejectedValue(new Error("Browser must never launch"));
  const broker = await startBroker();
  try {
    await expect(call(broker.socket, "session.create", { backend: "browser" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(launch).not.toHaveBeenCalled();
    expect(await call(broker.socket, "session.list")).toEqual([]);
  } finally { launch.mockRestore(); await broker.close(); }
});

test("browser profile discovery and saved account APIs are retired", async () => {
  const broker = await startBroker();
  try {
    for (const method of ["profiles.list", "session.account.save"])
      await expect(call(broker.socket, method, {})).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(call(broker.socket, "session.create", { backend: "system", cloneOf: "/not/read" }))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(call(broker.socket, "session.act", { sessionId: "unused", requestId: "retired-profile", action: {
      type: "launch-app", app: "zen", profile: "active",
    } })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally { await broker.close(); }
});

test("direct public session admission has no browser fallback", async () => {
  const sessions = new DesktopSessions("/unused-desktop-rejection-test");
  await expect(sessions.create({ backend: "browser" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await expect(sessions.create({ backend: "unknown" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await expect(sessions.create({ backend: "native", accountName: "retired" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
});


test("desktop health never invokes the legacy browser profile probe", async () => {
  const probe = spyOn(legacyPlatform, "describeMachine").mockRejectedValue(new Error("Legacy profile probe forbidden"));
  const broker = await startBroker();
  try {
    const doctor = await call(broker.socket, "doctor");
    expect(doctor).toMatchObject({ sessionMode: "desktop-only", machine: {
      report: "orbit-desktop-capabilities", browserBackendSupported: false, browsers: [],
    } });
    expect(probe).not.toHaveBeenCalled();
  } finally { probe.mockRestore(); await broker.close(); }
});

test("standalone health reports desktop capability without browser profiles", async () => {
  const child = Bun.spawn([process.execPath, "src/cli.ts", "doctor", "--report"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ err, code }).toEqual({ err: "", code: 0 });
  expect(JSON.parse(out)).toMatchObject({ report: "orbit-desktop-capabilities", sessionMode: "desktop-only", browsers: [] });
});

test("MCP exposes desktop backends and no DOM or profile-copy contract", async () => {
  const server = createMcpServer("/unused-for-schema-test");
  const client = new Client({ name: "desktop-contract", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const tools = (await client.listTools()).tools;
    expect(tools.some(tool => tool.name === "orbit_profiles")).toBe(false);
    const create = tools.find(tool => tool.name === "orbit_create");
    const properties = create?.inputSchema.properties as Record<string, { enum?: string[]; default?: string }>;
    expect(properties.backend?.default).toBe("system");
    expect(properties.backend?.enum).toEqual(["system", "fedora", "native"]);
    for (const name of ["cloneOf", "cloneExtensions", "accountName"])
      expect(properties[name]).toBeUndefined();
    const act = tools.find(tool => tool.name === "orbit_act");
    expect(JSON.stringify(act?.inputSchema)).not.toMatch(/"(?:navigate|fill|upload|open-tab|select-tab|close-tab|selector)"/);
    expect(client.getInstructions()).toContain("desktop-only");
    const refused = await client.callTool({ name: "orbit_create", arguments: { backend: "browser" } });
    expect(refused.isError).toBe(true);
  } finally { await client.close(); await server.close(); }
});

test("CLI session create defaults to system on the wire", async () => {
  let received: unknown;
  const { mkdtemp, rm } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "orbit-cli-desktop-"));
  const socket = join(directory, "rpc.sock");
  const server = Bun.serve({ unix: socket, async fetch(request) {
    received = await request.json();
    return Response.json({ ok: true, result: { fixture: true } });
  } });
  try {
    const child = Bun.spawn([process.execPath, "src/cli.ts", "session", "create"], {
      env: { ...process.env, ORBIT_SOCKET: socket }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ out, err, code }).toMatchObject({ code: 0 });
    expect(received).toMatchObject({ method: "session.create", params: { backend: "system" } });
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("browser viewer entrypoints refuse before host browser discovery or launch", async () => {
  const launch = spyOn(hostBrowsers, "openViewer").mockResolvedValue({ opened: false, browser: "", appWindow: false });
  const discover = spyOn(hostBrowsers, "listHostBrowsers").mockResolvedValue([]);
  const preference = spyOn(hostBrowsers, "viewerPreference").mockResolvedValue({ browser: "", appWindow: false });
  const broker = await startBroker();
  try {
    for (const [method, params] of [
      ["preview.open", {}], ["preview.open", { launch: true }],
      ["preview.open", { launch: true, view: "settings", browser: "fixture-browser" }],
      ["viewer.browsers", {}],
    ] as const) {
      await expect(call(broker.socket, method, params)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    }
    expect(launch).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(preference).not.toHaveBeenCalled();
  } finally {
    launch.mockRestore(); discover.mockRestore(); preference.mockRestore(); await broker.close();
  }
});

test("desktop panel and shell launch routes stay native", async () => {
  const child = Bun.spawn(["python3", "tests/desktop_browser_retirement_test.py"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, err, code }).toMatchObject({ code: 0 });
  expect(err).toContain("Ran 8 tests");
});

test("CLI refuses retired viewer commands without contacting a broker", async () => {
  for (const args of [["preview"], ["preview", "open"], ["preview", "browsers"]]) {
    const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
      env: { ...process.env, ORBIT_SOCKET: "/unused-retired-viewer-broker.sock" }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).not.toBe(0);
    expect(out + err).toContain("UNSUPPORTED");
    expect(out + err).toContain("Browser viewers are retired");
  }
});
