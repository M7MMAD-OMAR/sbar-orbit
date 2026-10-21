import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as childProcess from "node:child_process";
import { FedoraBackend, parseNativeAction } from "../src/fedora";
import { call, startBroker } from "../src/ipc";
import { NativeBackend } from "../src/hyprland";
import { NativeWorker } from "../src/native-worker";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "orbit-visibility-"));
  const keys = ["XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "WAYLAND_DISPLAY"] as const;
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  await mkdir(join(root, "sbar-orbit"));
  const socket = Bun.serve({ unix: join(root, "wayland-test"), fetch: () => new Response("") });
  Object.assign(process.env, { XDG_CONFIG_HOME: root, XDG_RUNTIME_DIR: root, WAYLAND_DISPLAY: "wayland-test" });
  try { await run(root); }
  finally {
    socket.stop(true);
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function attemptedBackend(visible?: boolean) {
  let backend: string | undefined;
  const intercepted = new Error("compositor intercepted before launch");
  const spawn = spyOn(childProcess, "spawn").mockImplementation((_file, _args?, options?) => {
    backend = (options as childProcess.SpawnOptions).env?.WLR_BACKENDS;
    throw intercepted;
  });
  try {
    await expect(FedoraBackend.create(undefined, undefined, visible)).rejects.toThrow(intercepted);
    return backend;
  } finally { spawn.mockRestore(); }
}

test("desktop creation is visible when no setting or visible option was supplied", async () => {
  await fixture(async () => { expect(await attemptedBackend()).toBe("wayland"); });
});

test("an explicit hidden request is refused before compositor creation without the setting", async () => {
  await fixture(async () => {
    const spawn = spyOn(childProcess, "spawn").mockImplementation(() => { throw new Error("must not launch"); });
    try {
      await expect(FedoraBackend.create(undefined, undefined, false)).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); }
  });
});

test("only an enabled settings choice permits hidden mode, and visible true still wins", async () => {
  await fixture(async root => {
    await writeFile(join(root, "sbar-orbit/panel.json"), JSON.stringify({ hiddenSessions: true }));
    expect(await attemptedBackend()).toBe("headless");
    expect(await attemptedBackend(false)).toBe("headless");
    expect(await attemptedBackend(true)).toBe("wayland");
  });
});

test("malformed settings cannot enable hidden mode", async () => {
  await fixture(async root => {
    await writeFile(join(root, "sbar-orbit/panel.json"), "{");
    expect(await attemptedBackend()).toBe("wayland");
  });
});

test("disabling hidden mode blocks further input to an already hidden desktop", async () => {
  await fixture(async root => {
    await writeFile(join(root, "sbar-orbit/panel.json"), JSON.stringify({ hiddenSessions: false }));
    const backend = Object.assign(Object.create(FedoraBackend.prototype), {
      visible: false, closed: false, parseAction: parseNativeAction,
    }) as FedoraBackend;
    await expect(backend.act({ type: "key", key: "Enter" })).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });
});

test("public system and fedora requests cannot bypass the settings gate", async () => {
  await fixture(async () => {
    const broker = await startBroker();
    try {
      for (const backend of ["system", "fedora"])
        await expect(call(broker.socket, "session.create", { backend, visible: false }))
          .rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(await call(broker.socket, "session.list")).toEqual([]);
    } finally { await broker.close(); }
  });
});

test("a missing visible display refuses without a headless fallback", async () => {
  await fixture(async () => {
    process.env.WAYLAND_DISPLAY = "missing-socket";
    const spawn = spyOn(childProcess, "spawn").mockImplementation(() => { throw new Error("must not launch"); });
    try {
      await expect(FedoraBackend.create()).rejects.toMatchObject({ code: "UNSUPPORTED" });
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); }
  });
});

test("the experimental native workspace cannot bypass the hidden-session setting", async () => {
  await fixture(async () => {
    const worker = spyOn(NativeWorker, "create").mockRejectedValue(new Error("must not start worker"));
    try {
      await expect(NativeBackend.create("/unused", {} as Parameters<typeof NativeBackend.create>[1]))
        .rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(worker).not.toHaveBeenCalled();
    } finally { worker.mockRestore(); }
  });
});
