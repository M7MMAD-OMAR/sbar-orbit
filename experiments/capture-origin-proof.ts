import { startBroker, call } from "../src/ipc";
import { nativeOptionsFromEnv } from "../src/native-worker";

/**
 * Live proof that image pixels and input coordinates share one origin on a window with a client side
 * margin (Firefox). Opens a new window, loads experiments/web-flows/index.html from localhost, saves a
 * capture and waits for ORBIT_PROOF_OUT/click.json ({"x": px, "y": px}, read straight off that image),
 * clicks there and saves the capture and the page address after it.
 *
 *   ORBIT_PROOF_WORKSPACE=6 ORBIT_PROOF_APPLICATION=org.mozilla.firefox.desktop ORBIT_PROOF_OUT=/some/empty/dir \
 *     bun run scripts/limited.ts bun experiments/capture-origin-proof.ts
 */
const workspace = Number(process.env.ORBIT_PROOF_WORKSPACE), application = process.env.ORBIT_PROOF_APPLICATION, out = process.env.ORBIT_PROOF_OUT;
if (!workspace || !application || !out) throw new Error("Set ORBIT_PROOF_WORKSPACE, ORBIT_PROOF_APPLICATION and ORBIT_PROOF_OUT");
const page = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(Bun.file(new URL("web-flows/index.html", import.meta.url)), { headers: { "content-type": "text/html" } }) });
const broker = await startBroker({ native: nativeOptionsFromEnv() });
const rpc = (method: string, params: unknown = {}) => call(broker.socket, method, params) as Promise<any>;
let sessionId: string | undefined, target: { appId: string; windowId: string } | undefined;
type Monitor = { name: string; workspace: number; focused: boolean };
const before = (await rpc("native.monitors")).monitors as Monitor[];
// Show the workspace on whichever output the owner is not using right now; a new window there is not in their way.
async function present() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const quiet = ((await rpc("native.monitors")).monitors as Monitor[]).find(entry => !entry.focused);
    if (!quiet) throw new Error("Every output is focused");
    try { return await rpc("native.present", { requestId: crypto.randomUUID(), workspace, monitor: quiet.name }); }
    catch (error) { if ((error as { code?: string }).code !== "PRESENTATION_NOT_READY") throw error; await Bun.sleep(1000); }
  }
  throw new Error("No output stayed unfocused long enough to present the workspace");
}
try {
  if (process.env.ORBIT_PROOF_PRESENT !== "0") await present();
  // A window this run launched whose open came back uncertain can be named exactly, never guessed.
  const named = process.env.ORBIT_PROOF_ADDRESS && process.env.ORBIT_PROOF_STABLE
    ? { address: process.env.ORBIT_PROOF_ADDRESS, stableId: process.env.ORBIT_PROOF_STABLE } : undefined;
  const opened = named ? undefined : await rpc("native.open", { requestId: crypto.randomUUID(), workspace, applicationId: application });
  const launched = named ?? (opened.opened === true ? opened : opened.candidate);
  if (!launched) throw new Error("Application did not open as a new window: " + JSON.stringify(opened));
  const session = await rpc("session.create", { backend: "native", taskName: "Capture origin proof", handoff: { workspace, address: launched.address, stableId: launched.stableId } });
  sessionId = session.sessionId;
  const appId = session.handoff.appId;
  const listed = await rpc("session.act", { sessionId, requestId: crypto.randomUUID(), action: { type: "windows", appId } });
  target = { appId, windowId: listed.windows[0].windowId };
  const goal = target;
  const act = (action: object) => rpc("session.act", { sessionId, requestId: crypto.randomUUID(), action: { ...goal, ...action } });
  const observe = () => rpc("session.observe", { sessionId, ...goal });
  await Bun.sleep(4000);
  for (const step of [{ type: "key", key: "ctrl+l" }, { type: "text", text: `http://localhost:${page.port}/` }, { type: "key", key: "Return" }]) await act(step);
  await Bun.sleep(4000);
  const shot = await observe();
  const { image: _image, ...meta } = shot;
  await Bun.write(`${out}/before.png`, Buffer.from(shot.image, "base64"));
  await Bun.write(`${out}/before.json`, JSON.stringify({ state: await act({ type: "state" }), frame: meta }));
  console.log("Saved before.png; write click.json with the image pixel to click");
  // A fresh handle each time: a Bun file object remembers that it did not exist.
  while (!(await Bun.file(`${out}/click.json`).exists())) await Bun.sleep(500);
  const pixel = await Bun.file(`${out}/click.json`).json() as { x: number; y: number };
  const scale = shot.width / shot.surfaceWidth;
  const at = { x: Math.round(pixel.x / scale), y: Math.round(pixel.y / scale) };
  const result = await act({ type: "click", ...at });
  await Bun.sleep(600);
  const after = await observe();
  await Bun.write(`${out}/after.png`, Buffer.from(after.image, "base64"));
  await Bun.write(`${out}/after.json`, JSON.stringify({ pixel, scale, input: at, result }));
  console.log("Clicked", at, "from image pixel", pixel);
} catch (error) {
  console.error("Proof failed:", error);
  process.exitCode = 1;
} finally {
  if (sessionId && target) await rpc("session.act", { sessionId, requestId: crypto.randomUUID(), action: { type: "close-window", ...target } }).catch(() => {});
  if (sessionId) await rpc("session.stop", { sessionId }).catch(() => {});
  for (const entry of before) {
    const now = ((await rpc("native.monitors").catch(() => ({ monitors: [] }))).monitors as Monitor[]).find(other => other.name === entry.name);
    if (now && now.workspace !== entry.workspace && !now.focused)
      await rpc("native.present", { requestId: crypto.randomUUID(), workspace: entry.workspace, monitor: entry.name }).catch(() => {});
  }
  page.stop(true);
  process.exit(process.exitCode ?? 0);
}
