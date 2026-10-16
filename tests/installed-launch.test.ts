import { expect, spyOn, test } from "bun:test";
import { FedoraBackend, parseNativeAction } from "../src/fedora";
import { orbitActionSchema } from "../src/mcp";
import * as resolver from "../src/application-launch";
import * as childProcess from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { classify } from "../src/policy";
import { linuxOnlySuite } from "./platform-support";
const linuxTest = linuxOnlySuite("Private launch environment fixture uses Linux executables");

test("installed launch selects a registration without a caller installation path", () => {
  const action = { type: "launch-installed", applicationId: "org.example.RandomEditor.desktop" } as const;
  expect(parseNativeAction(action)).toEqual(action);
  expect(orbitActionSchema.parse(action)).toEqual(action);
  expect(classify(action.type)).toBe("write");
});

linuxTest("registered launch preserves resolved arguments and cwd with private runtime HOME", async () => {
  const root = await mkdtemp("/tmp/orbit-registered-launch-");
  const prepare = spyOn(resolver, "resolveInstalledApplication").mockResolvedValue({
    applicationId: "org.example.Editor.desktop", argv: ["/usr/bin/true", "argument with spaces"], cwd: root,
  });
  let actualArgs: readonly string[] | undefined;
  let actualOptions: childProcess.SpawnOptions | undefined;
  const intercepted = new Error("Supervisor intercepted");
  const launch = spyOn(childProcess, "spawn").mockImplementation((_file, args?, options?) => {
    actualArgs = Array.isArray(args) ? args : undefined;
    actualOptions = options as childProcess.SpawnOptions; throw intercepted;
  });
  try {
    const backend = Object.assign(Object.create(FedoraBackend.prototype), {
      parseAction: parseNativeAction, closed: false, children: [], directory: root,
      env: { ...process.env, HOME: "/not-the-application-home" }, socketPolicy: async () => [],
    }) as FedoraBackend;
    await expect(backend.act({ type: "launch-installed", applicationId: "org.example.Editor.desktop" }))
      .rejects.toBe(intercepted);
    expect(prepare).toHaveBeenCalledWith("org.example.Editor.desktop");
    expect(actualArgs?.slice(-2)).toEqual(["/usr/bin/true", "argument with spaces"]);
    expect(actualOptions?.cwd).toBe(root);
    expect(actualOptions?.env?.HOME).toBe(join(root, "home"));
  } finally { launch.mockRestore(); prepare.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("registration resolution failure never invokes a guessed executable", async () => {
  const unavailable = new Error("Registration no longer exists");
  const prepare = spyOn(resolver, "resolveInstalledApplication").mockRejectedValue(unavailable);
  const launch = spyOn(childProcess, "spawn").mockImplementation(() => { throw new Error("Must not launch"); });
  try {
    const backend = Object.assign(Object.create(FedoraBackend.prototype), {
      parseAction: parseNativeAction, closed: false,
    }) as FedoraBackend;
    await expect(backend.act({ type: "launch-installed", applicationId: "org.example.Missing.desktop" }))
      .rejects.toBe(unavailable);
    expect(launch).not.toHaveBeenCalled();
  } finally { launch.mockRestore(); prepare.mockRestore(); }
});

test("installed launch cannot silently accept an existing-window or owner-profile request", () => {
  for (const fields of [{ intent: "existing" }, { windowId: "owner-window" },
    { profile: "active" }, { argv: ["/arbitrary/program"] }, { applicationId: "../editor.desktop" }]) {
    const action = { type: "launch-installed", applicationId: "org.example.Editor.desktop", ...fields };
    expect(() => parseNativeAction(action)).toThrow();
    expect(orbitActionSchema.safeParse(action).success).toBe(false);
  }
});
