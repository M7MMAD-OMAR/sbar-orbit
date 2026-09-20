/** Run only inside the disposable systemd container after install --managed. */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { activateVersion, prepareVersion, currentVersion, setAutomaticUpdates, automaticUpdates } from "../../src/update";
import { call } from "../../src/ipc";
import { serviceSocketPath } from "../../src/service";
import { requireResourceBudget } from "../../src/resource-budget";
await requireResourceBudget();
if (basename(homedir()) !== "orbit" || process.env.ORBIT_UPDATE_CONTAINER !== "1")
  throw new Error("This destructive fixture belongs only in the disposable update container");
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); console.log(`PASS: ${message}`); };
const socket = serviceSocketPath();
const initial = await currentVersion();
if (initial !== "0.1.0-alpha.8") throw new Error("Expected managed alpha.8 release");
assert(true, "managed release is current");
const sentinel = join(homedir(), ".local/state/sbar-orbit/update-sentinel");
await mkdir(join(homedir(), ".local/state/sbar-orbit"), { recursive: true });
await writeFile(sentinel, "retained user state");
async function candidate(version: string, broken = false) {
  const fixture = `/tmp/orbit-candidate-${version}`;
  await cp(join(homedir(), "release"), join(fixture, "package"), { recursive: true, filter: path => !path.includes("node_modules") });
  const pkgPath = join(fixture, "package/package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  pkg.version = version;
  await writeFile(pkgPath, JSON.stringify(pkg));
  if (broken) await writeFile(join(fixture, "package/src/cli.ts"), 'throw new Error("intentional rollback fixture");\n');
  const archive = join(fixture, "release.tgz");
  const tar = Bun.spawn(["tar", "czf", archive, "-C", fixture, "package"]);
  assert(await tar.exited === 0, `packed controlled fixture ${version}`);
  const bytes = await Bun.file(archive).arrayBuffer();
  const result = await prepareVersion({ version, tarball: "fixture://local", publishedAt: "2026-09-01T00:00:00Z",
    integrity: `sha512-${createHash("sha512").update(Buffer.from(bytes)).digest("base64")}` }, { download: async () => bytes });
  assert(result.prepared, `real dependency preparation for ${version}`);
}
await candidate("0.1.0-alpha.9");
const session = await call(socket, "session.create", { backend: "browser", agentName: "release-verification", taskName: "managed upgrade" }) as { sessionId: string };
assert(Boolean(session.sessionId), "real private browser session created");
const busy = await activateVersion("0.1.0-alpha.9");
assert(!busy.activated && "openSessions" in busy && busy.openSessions === 1, "upgrade refuses a live session");
assert(await currentVersion() === initial, "busy refusal leaves current unchanged");
await call(socket, "session.stop", { sessionId: session.sessionId });
const upgrade = await activateVersion("0.1.0-alpha.9");
console.log(JSON.stringify(upgrade));
assert(upgrade.activated, "real systemd upgrade answers doctor with the new version");
await candidate("0.1.0-alpha.10", true);
const rollback = await activateVersion("0.1.0-alpha.10");
console.log(JSON.stringify(rollback));
assert(!rollback.activated && "rollbackHealthy" in rollback && rollback.rollbackHealthy, "broken version rolls back to a healthy broker");
assert(await currentVersion() === "0.1.0-alpha.9", "rollback restores current pointer");
assert(await readFile(sentinel, "utf8") === "retained user state", "user state survives upgrade and rollback");
const on = await setAutomaticUpdates(true);
assert(on.automatic && on.timer === "enabled", "real daily systemd timer enabled");
const off = await setAutomaticUpdates(false);
assert(!off.automatic && !await automaticUpdates(), "automatic update kill switch disabled");
const back = await activateVersion(initial);
assert(back.activated, "explicit rollback to shipped release works");
console.log("All upgrade fixtures passed. alpha.9 and alpha.10 are local test fixtures, not published releases.");
