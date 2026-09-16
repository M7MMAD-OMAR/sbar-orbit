import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { startBroker, call } from "../src/ipc";
import { tmpdir } from "node:os";

(process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip)("two brokers reserve an editor file until its application session stops", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-file-editors-"));
  const file = join(root, "document.txt");
  await writeFile(file, "Replace this text\n");
  for (const name of ["a", "b"]) for (const dir of ["config", "data", "cache", "state"]) await mkdir(join(root, name, dir), { recursive: true });
  const a = await startBroker(), b = await startBroker();
  const act = (socket: string, sessionId: string, action: unknown) => call(socket, "session.act", { sessionId, requestId: crypto.randomUUID(), action });
  const launch = (name: string) => ({ type: "launch", toolkit: "wayland", selectedFiles: [file], argv: ["/usr/bin/env",
    `XDG_CONFIG_HOME=${root}/${name}/config`, `XDG_DATA_HOME=${root}/${name}/data`, `XDG_CACHE_HOME=${root}/${name}/cache`, `XDG_STATE_HOME=${root}/${name}/state`,
    "/usr/bin/gnome-text-editor", "--standalone", file] });
  try {
    const first = await call(a.socket, "session.create", { backend: "fedora" }) as { sessionId: string };
    const second = await call(b.socket, "session.create", { backend: "fedora" }) as { sessionId: string };
    const opened = await act(a.socket, first.sessionId, launch("a")) as { pid: number; selectedFiles: string[] };
    expect(opened.selectedFiles).toEqual([file]);
    await expect(act(b.socket, second.sessionId, launch("b"))).rejects.toMatchObject({ code: "FILE_BUSY" });
    await Bun.sleep(1000);
    await act(a.socket, first.sessionId, { type: "pointer", x: 240, y: 100 });
    await act(a.socket, first.sessionId, { type: "key", key: "Ctrl+A" });
    await act(a.socket, first.sessionId, { type: "paste", text: "Reserved Orbit file محفوظ" });
    await Bun.sleep(250);
    await act(a.socket, first.sessionId, { type: "key", key: "Ctrl+S" });
    let actual = "";
    for (let i = 0; i < 100; i++) { actual = await readFile(file, "utf8"); if (actual === "Reserved Orbit file محفوظ\n") break; await Bun.sleep(30); }
    expect(actual).toBe("Reserved Orbit file محفوظ\n");
    await expect(act(b.socket, second.sessionId, launch("b"))).rejects.toMatchObject({ code: "FILE_BUSY" });
    await call(a.socket, "session.stop", first);
    expect(await Bun.file(`/proc/${opened.pid}/stat`).exists()).toBe(false);
    const reopened = await act(b.socket, second.sessionId, launch("b")) as { pid: number; selectedFiles: string[] };
    expect(reopened.selectedFiles).toEqual([file]);
    await call(b.socket, "session.stop", second);
    expect(await Bun.file(`/proc/${reopened.pid}/stat`).exists()).toBe(false);
  } finally { await a.close(); await b.close(); }
}, 30000);
