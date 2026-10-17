import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { startBroker, call } from "../src/ipc";

test.each([true, false])("CI runner preserves a desktop test result: passing=%s", async passing => {
  const outputDirectory = join(process.cwd(), "output");
  await mkdir(outputDirectory, { recursive: true });
  const root = await mkdtemp(join(outputDirectory, "ci-result-"));
  try {
    const fixture = join(root, "result.test.ts");
    await writeFile(fixture, `import { test, expect } from "bun:test"; test("CI result fixture", () => expect(${passing}).toBe(true));\n`);
    // Bun treats Windows absolute paths outside the checkout as name filters.
    const testPath = "./" + relative(process.cwd(), fixture).replaceAll("\\", "/");
    const child = Bun.spawn([process.execPath, "experiments/verify-with-resources.ts", testPath], {
      stdout: "pipe", stderr: "pipe", timeout: 20000,
      env: { ...process.env, ORBIT_VERIFICATION_OUTPUT_DIR: root },
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, output: out + err }).toMatchObject({ code: passing ? 0 : 1 });
    expect(out + err).toContain("CI result fixture");
    expect(out + err).toMatch(passing ? /1 pass/ : /1 fail/);
    expect(JSON.parse(await readFile(join(root, "verification-result.json"), "utf8")))
      .toMatchObject({ suite: "desktop", exitCode: code, retiredBrowserFlow: "not run" });
    const samples = (await readFile(join(root, "verification-resources.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(samples.at(-1)).toMatchObject({ event: "end", exitCode: code });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

test("installed desktop smoke checks the broker without creating a browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-ci-desktop-"));
  const broker = await startBroker();
  try {
    const output = join(root, "contracts.json");
    const launcher = join(process.cwd(), "bin", process.platform === "win32" ? "sbar-orbit.cmd" : "sbar-orbit");
    const child = Bun.spawn([process.execPath, "experiments/installed-desktop-smoke.ts", launcher, output], {
      stdout: "pipe", stderr: "pipe", timeout: 20000,
      env: { ...process.env, ORBIT_SOCKET: broker.socket },
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, output: out + err }).toMatchObject({ code: 0 });
    expect(JSON.parse(await readFile(output, "utf8")))
      .toMatchObject({ ok: true, nativeApplicationControl: "not measured", browserLaunches: 0 });
    expect(await call(broker.socket, "session.list")).toEqual([]);
  } finally { await broker.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);
