import { startBroker, call } from "../../src/ipc";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { OrbitError } from "../../src/errors";

const work = process.argv[2];
if (!work || !process.env.XDG_RUNTIME_DIR?.startsWith("/tmp/gl-")
    || !process.env.DBUS_SESSION_BUS_ADDRESS?.startsWith("unix:path=/tmp/gl-") || process.env.DISPLAY)
  throw new Error("Native broker fixture requires its private lab");
const wait = async (probe: () => Promise<boolean>, label: string) => {
  const end = Date.now() + 12_000;
  while (!await probe()) {
    assert(Date.now() < end, label);
    await Bun.sleep(20);
  }
};
const exists = async (path: string) => Bun.file(path).exists();
const broker = await startBroker({ native: { planPath: join(work, "host.json"), controlDirectory: join(work, "control") } });
const checks: string[] = [];
try {
  const doctor = await call(broker.socket, "doctor") as { backends: string[]; backendAliases: unknown };
  assert(doctor.backends.includes("native"));
  assert.deepEqual(doctor.backendAliases, { system: "fedora" });
  const policy = { mode: "autonomous", origins: "any", allow: ["read", "write"], deny: ["irreversible"] };
  await assert.rejects(() => call(broker.socket, "session.create", {
    backend: "native", policy: { ...policy, origins: ["https://example.com"] },
  }), /Native network origin enforcement/);
  const sessions: { sessionId: string }[] = [];
  for (const label of ["A", "B"]) {
    const created = await call(broker.socket, "session.create", {
    backend: "native", agentName: "Native broker fixture " + label, taskName: "Owned target routing", policy,
    }) as { sessionId: string };
    sessions.push({ sessionId: created.sessionId });
  }
  const first = sessions[0], second = sessions[1];
  assert(first && second);
  await assert.rejects(() => call(broker.socket, "session.narrow", { ...first, origins: ["https://example.com"] }),
    /Native network origin enforcement/);
  checks.push("unsupported native network origin limits refused at creation and narrowing");
  const act = (session: { sessionId: string }, action: unknown, requestId = crypto.randomUUID()) =>
    call(broker.socket, "session.act", { ...session, action, requestId });
  const argv = (index: number) => ["/usr/bin/python3", join(import.meta.dir, "native_broker_application.py"), join(work, `app-${index}.json`)];
  await assert.rejects(() => act(first, { type: "launch", argv: argv(0) }), /private worker journal/);
  await writeFile(join(work, "ready-for-full"), "ready");
  await wait(() => exists(join(work, "full-ready")), "Owner fixture did not configure full mode");
  checks.push("native backend discovered; protected launch refused before application resources");
  const targets: { appId: string; windowId: string }[] = [];
  for (const [index, session] of sessions.entries()) {
    const app = await act(session, { type: "launch", argv: argv(index) }) as { appId: string };
    let windows: { windowId: string }[] = [];
    await wait(async () => {
      windows = (await act(session, { type: "windows", appId: app.appId }) as { windows: { windowId: string }[] }).windows;
      return windows.length > 0;
    }, "Owned native application did not map");
    assert.equal(windows.length, 1);
    const window = windows[0]; assert(window);
    targets.push({ appId: app.appId, windowId: window.windowId });
    for (const action of [{ type: "cursor", x: 40.5, y: 30.25 }, { type: "click", x: 40.5, y: 30.25 },
      { type: "text", text: `Broker native ${index}` }]) await act(session, { ...targets[index], ...action });
    await wait(async () => JSON.parse(await readFile(join(work, `app-${index}.json`), "utf8")).text === `Broker native ${index}`,
      "Native broker text did not reach the owned target");
  }
  checks.push("two public broker sessions launch and address only their own real GTK targets");
  assert(targets[0] && targets[1]);
  await assert.rejects(() => act(first, { ...targets[1], type: "key", key: "Return" }), /another session/);
  await assert.rejects(() => call(broker.socket, "session.create", { backend: "native", planPath: join(work, "host.json") }), /cannot select host paths/);
  await assert.rejects(() => act(first, { type: "configure", mode: "full" }), /Unknown native action/);
  checks.push("foreign target, agent host selection and mode changes refused");
  const frame = await call(broker.socket, "session.observe", { ...first, ...targets[0] }) as Record<string, unknown>;
  assert.equal(frame.appId, targets[0].appId);
  assert.deepEqual(frame.pointer, { x: 40.5, y: 30.25 });
  await writeFile(join(work, "view-frame.json"), JSON.stringify(frame), { mode: 0o600 });
  await writeFile(join(import.meta.dir, "evidence/native-broker-target.png"), Buffer.from(String(frame.image), "base64"));
  const requestId = crypto.randomUUID();
  const action = { ...targets[0], type: "text", text: " once" };
  const result = await act(first, action, requestId);
  assert.deepEqual(await act(first, action, requestId), result);
  await wait(async () => JSON.parse(await readFile(join(work, "app-0.json"), "utf8")).text === "Broker native 0 once", "Broker request replay repeated text");
  checks.push("explicit target capture and broker request deduplication preserve the native contract");
  await call(broker.socket, "session.pause", first);
  await assert.rejects(() => act(first, { ...targets[0], type: "key", key: "Return" }), /paused/);
  await call(broker.socket, "session.resume", first);
  await call(broker.socket, "session.narrow", { ...first, allow: [] });
  await assert.rejects(() => call(broker.socket, "session.observe", { ...first, ...targets[0] }),
    (error: unknown) => error instanceof OrbitError && error.code === "POLICY_DENIED");
  const presence = await call(broker.socket, "session.presence", second) as { sampled: string };
  assert.equal(presence.sampled, "acknowledged metadata");
  checks.push("pause and read-policy narrowing enforced; presence uses acknowledged metadata without capture");
  await call(broker.socket, "session.stop", first);
  assert.equal((await call(broker.socket, "session.list") as { sessionId: string; state: string }[]).find(s => s.sessionId === second.sessionId)?.state, "running");
  checks.push("stopping one native session preserves its sibling");
} finally { await broker.close(); }
await writeFile(join(work, "broker-result.json"), JSON.stringify({ checks, owner_activation: "not performed", comparative_performance: "not measured" }));
