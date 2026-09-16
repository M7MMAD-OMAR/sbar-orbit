import { mkdir, writeFile, rename, rm, symlink, readlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const say = (m: string) => console.log("[linux] " + m);
const base = join(tmpdir(), "orbit-lin-" + Math.random().toString(36).slice(2, 8));
await mkdir(join(base, "v1"), { recursive: true });
await mkdir(join(base, "v2"), { recursive: true });
await writeFile(join(base, "v1", "which"), "one");
await writeFile(join(base, "v2", "which"), "two");
await symlink(join(base, "v1"), join(base, "current"));
await symlink(join(base, "v2"), join(base, "current.new"));
try { await rename(join(base, "current.new"), join(base, "current")); say("rename over live SYMLINK: ok, now " + (await readlink(join(base, "current"))).slice(-2)); }
catch (e) { say("rename over live SYMLINK: FAILED " + (e as {code?:string}).code); }
await mkdir(join(base, "d1"), { recursive: true }); await mkdir(join(base, "d2"), { recursive: true });
try { await rename(join(base, "d2"), join(base, "d1")); say("rename over empty plain DIRECTORY: ok"); }
catch (e) { say("rename over empty plain DIRECTORY: FAILED " + (e as {code?:string}).code); }
await rm(base, { recursive: true, force: true });
