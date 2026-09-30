import { linuxOnlySuite } from "./platform-support";
import { expect } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { FedoraBackend } from "../src/fedora";

const test = linuxOnlySuite("Fedora private display cleanup has no backend on other platforms");

test("private display close waits for an already running application release", async () => {
  const directory = await mkdtemp("/tmp/orbit-zen-cleanup-");
  const clone = join(directory, "zen-clone");
  await mkdir(clone);
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const supervised = {
    child: { exitCode: 0, signalCode: null },
    release: async () => { await gate; await rm(clone, { recursive: true }); },
  };
  const backend = Object.assign(Object.create(FedoraBackend.prototype), {
    directory, children: [supervised], compositor: { exitCode: 0, signalCode: null },
    listeners: [], listenersNotified: false, cleanupFailures: [], closed: false,
  }) as FedoraBackend;
  try {
    const reaping = (backend as unknown as { reap: (item: typeof supervised) => Promise<void> }).reap(supervised);
    let finished = false;
    const closing = backend.close().then(() => { finished = true; });
    await Bun.sleep(20);
    expect(finished).toBe(false);
    expect(await stat(clone).then(() => true, () => false)).toBe(true);
    release();
    await Promise.all([reaping, closing]);
    expect(await stat(directory).then(() => true, () => false)).toBe(false);
  } finally {
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("private display close reports release failure after notifying listeners and can retry", async () => {
  const directory = await mkdtemp("/tmp/orbit-zen-cleanup-failure-");
  const clone = await mkdtemp("/tmp/orbit-zen-cleanup-clone-");
  let notified = 0;
  let releases = 0;
  const supervised = {
    child: { exitCode: 0, signalCode: null },
    release: async () => {
      releases++;
      if (releases === 1) throw new Error("release failed");
      await rm(clone, { recursive: true });
    },
  };
  const backend = Object.assign(Object.create(FedoraBackend.prototype), {
    directory, children: [supervised], compositor: { exitCode: 0, signalCode: null },
    listeners: [() => { notified++; }], listenersNotified: false, cleanupFailures: [], closed: false,
  }) as FedoraBackend;
  try {
    await expect(backend.close()).rejects.toMatchObject({ code: "BACKEND_FAILED" });
    expect(notified).toBe(1);
    expect(releases).toBe(1);
    expect(await stat(directory).then(() => true, () => false)).toBe(false);
    expect(await stat(clone).then(() => true, () => false)).toBe(true);
    await backend.close();
    expect(notified).toBe(1);
    expect(releases).toBe(2);
    expect(await stat(clone).then(() => true, () => false)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(clone, { recursive: true, force: true });
  }
});

test("private display close reports removal failure and retries removal", async () => {
  const root = await mkdtemp("/tmp/orbit-zen-removal-failure-");
  const directory = join(root, "display");
  await mkdir(directory);
  let notified = 0;
  const backend = Object.assign(Object.create(FedoraBackend.prototype), {
    directory, children: [], compositor: { exitCode: 0, signalCode: null },
    listeners: [() => { notified++; }], listenersNotified: false, cleanupFailures: [], closed: false,
  }) as FedoraBackend;
  try {
    await chmod(root, 0o500);
    await expect(backend.close()).rejects.toMatchObject({ code: "BACKEND_FAILED" });
    expect(notified).toBe(1);
    expect(await stat(directory).then(() => true, () => false)).toBe(true);
    await chmod(root, 0o700);
    await backend.close();
    expect(notified).toBe(1);
    expect(await stat(directory).then(() => true, () => false)).toBe(false);
  } finally {
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});
