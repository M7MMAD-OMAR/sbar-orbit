import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startBroker, call } from "../src/ipc";

(process.env.ORBIT_TEST_NATIVE === "1" ? test : test.skip)("registered application maps and accepts text on an isolated desktop", async () => {
  const root = await mkdtemp("/tmp/orbit-installed-native-");
  const previousData = process.env.XDG_DATA_HOME;
  const broker = await startBroker();
  try {
    const session = await call(broker.socket, "session.create", { backend: "system" }) as { sessionId: string };
    await mkdir(join(root, "applications"));
    const applicationId = `org.orbit.Fixture-${crypto.randomUUID()}.desktop`;
    const report = join(root, "state.json");
    await writeFile(join(root, "applications", applicationId),
      `[Desktop Entry]\nType=Application\nName=Disposable editor\nExec=/usr/bin/python3 "${resolve("experiments/fedora-display/fixture.py")}" "${report}"\nPath=${root}\n`);
    process.env.XDG_DATA_HOME = root;
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    expect(await act({ type: "launch-installed", applicationId })).toMatchObject({
      applied: true, applicationId, applicationState: "new", runtimeHome: "private",
    });
    if (previousData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousData;
    await act({ type: "text", text: "registered launch verified" });
    const deadline = Date.now() + 5000;
    let observed: { text?: string } = {};
    do {
      observed = JSON.parse(await readFile(report, "utf8"));
      if (observed.text === "registered launch verified") break;
      await Bun.sleep(50);
    } while (Date.now() < deadline);
    expect(observed.text).toBe("registered launch verified");
    const presence = await call(broker.socket, "session.presence", session);
    expect(presence).toMatchObject({ pageCount: 1 });
    await call(broker.socket, "session.stop", session);
  } finally {
    if (previousData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousData;
    await broker.close(); await rm(root, { recursive: true, force: true });
  }
}, 60000);
