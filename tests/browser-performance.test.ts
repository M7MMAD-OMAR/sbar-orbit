import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { distribution, threshold, ownedRss, actionMean, collector } from "../experiments/browser-performance";

test("five observations use a nearest-rank p95 and signed paired differences", () => {
  expect(distribution([100, 1, 5, 10, 2])).toEqual({ median: 5, p95: 100, count: 5 });
  expect(distribution([-10, -5, 0, 1, 20]).median).toBe(0);
  expect(distribution([4, 2]).median).toBe(3);
  for (const values of [[], [NaN], [Infinity]]) expect(() => distribution(values)).toThrow();
});

test("unmeasured and boundary metrics cannot pass strict provisional targets", () => {
  for (const value of [null, NaN, Infinity]) expect(threshold(value, 100)).toBe("not measured");
  expect(threshold(99.9, 100)).toBe("passed");
  expect(threshold(100, 100)).toBe("failed");
  expect(threshold(101, 100)).toBe("failed");
  expect(threshold(-20, 20)).toBe("passed");
});

test("tree RSS excludes an unrelated sibling and includes reordered descendants", () => {
  const processes = [
    { pid: 4, parent: 3, start: "4", rssBytes: 20 },
    { pid: 5, parent: 1, start: "5", rssBytes: 1000 },
    { pid: 2, parent: 1, start: "2", rssBytes: 10 },
    { pid: 3, parent: 2, start: "3", rssBytes: 30 },
  ];
  expect(ownedRss(2, processes)).toBe(60);
  expect(ownedRss(99, processes)).toBe(0);
});

test("action workload averages all three operations and rejects unmatched counts", () => {
  expect(actionMean({ fill: [1, 1], click: [100, 100], read: [1, 1] })).toBe(34);
  const invalid: Record<string, number[]>[] = [{ fill: [1], click: [2] }, { fill: [1, 2], click: [2], read: [3] },
    { fill: [0], click: [2], read: [3] }, { fill: [NaN], click: [2], read: [3] }];
  for (const values of invalid)
    expect(() => actionMean(values)).toThrow();
});

test.skipIf(process.platform !== "linux")("collector waits for adopted grandchildren and records owned CPU and RSS", async () => {
  const root = await mkdtemp("/var/tmp/orbit-perf-test-");
  try {
    // The intermediary exits without waiting. The subreaper must adopt and wait
    // for the busy memory-holding grandchild before claiming cleanup or CPU.
    const program = `import os,time\nif os.fork(): os._exit(0)\na=bytearray(24*1024*1024)\nend=time.process_time()+0.15\nwhile time.process_time()<end: pass\ntime.sleep(0.15)\nos._exit(0)`;
    const child = Bun.spawn(["/usr/bin/python3", "-c", collector, join(root, "tree.json"),
      "/usr/bin/python3", "-c", program], { stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    const report = JSON.parse(await readFile(join(root, "tree.json"), "utf8"));
    expect(report.cleanup).toBe("wait returned ECHILD");
    expect(report.cpuSeconds).toBeGreaterThanOrEqual(0.15);
    expect(report.sampleFailures).toBe(0);
    expect(report.samples.some((sample: { processes: import("../experiments/browser-performance").ProcessSample[] }) =>
      ownedRss(report.root, sample.processes) > 24 * 1048576)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);

test.skipIf(process.platform !== "linux")("collector excludes Chrome child process titles rewritten into one argv string", async () => {
  const root = await mkdtemp("/var/tmp/orbit-perf-title-");
  try {
    const executable = await realpath("/usr/bin/python3");
    const child = Bun.spawn(["/usr/bin/python3", "-c", collector, join(root, "tree.json"),
      executable, "-c", "import time; time.sleep(0.2)",
      `${executable} --type=renderer --headless`, executable], { stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    const report = JSON.parse(await readFile(join(root, "tree.json"), "utf8"));
    expect(Object.keys(report.browserCommands).some(identity => identity.startsWith(`${report.worker}:`))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);

test.skipIf(process.platform !== "linux")("collector splits an owned executable command line at NUL boundaries", async () => {
  const root = await mkdtemp("/var/tmp/orbit-perf-wrapper-");
  try {
    const executable = await realpath("/usr/bin/python3");
    const child = Bun.spawn(["/usr/bin/python3", "-c", collector, join(root, "tree.json"),
      executable, "-c", "import time; time.sleep(0.2)", "--headless", `--user-data-dir=${root}/profile`, executable],
      { stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    const report = JSON.parse(await readFile(join(root, "tree.json"), "utf8"));
    const observation = Object.entries(report.browserObservations as Record<string, { argv: string[] }>).find(([identity]) => identity.startsWith(`${report.worker}:`))?.[1];
    expect(observation?.argv.includes("--headless")).toBe(true);
    expect(report.browserIdentity.status).toBe("invalid");
    expect(Object.keys(report.browserCommands)).toHaveLength(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);

async function collectRootWitnessFixture(mode = "valid") {
  const root = await mkdtemp("/var/tmp/orbit-perf-root-witness-");
  try {
    const executable = await realpath("/usr/bin/python3");
    const program = `import json,os,subprocess,sys,time
from pathlib import Path
executable=sys.argv[-1]
mode=sys.argv[2]
browser=subprocess.Popen([executable,"-c","import time;time.sleep(0.5)","--window-size=800,600" if mode=="unknown-headless" else "--headless=false" if mode=="false-headless" else "--headless"])
# Replay the erased prefix and retained renderer suffix from the rejected Chrome census.
renderer_program="""import ctypes,time
from pathlib import Path
raw=Path('/proc/self/cmdline').read_bytes()
address=ctypes.c_void_p.in_dll(ctypes.CDLL(None),'program_invocation_name').value
assert address and ctypes.string_at(address,len(raw))==raw
tail=b'-dev-shm-usage --remote-debugging-port=0 --renderer-client-id=8'
ctypes.memset(address,0,len(raw))
ctypes.memmove(address+len(raw)-len(tail)-1,tail,len(tail))
held=bytearray(24*1024*1024)
end=time.process_time()+0.1
while time.process_time()<end: pass
time.sleep(0.4)
"""
renderer=subprocess.Popen([executable,"-c",renderer_program,"x"*2048])
def identity(pid):
    fields=Path(f"/proc/{pid}/stat").read_text().rsplit(")",1)[1].split()
    return {"pid":pid,"start":fields[19],"parent":int(fields[1])}
held=identity(browser.pid)
ancestry=[held,identity(os.getpid())]
witness={**held,"workerPid":os.getpid(),"executable":executable,"cdpPid":browser.pid,"source":"owned-browser-cdp","ancestry":ancestry}
if mode=="wrong-start": witness["start"]="0"
if mode=="wrong-pid": witness["pid"]=renderer.pid
if mode=="wrong-executable": witness["executable"]="/missing/browser"
if mode=="wrong-worker": witness["workerPid"]=os.getppid()
if mode=="wrong-ancestry": witness["ancestry"][0]={**held,"parent":os.getppid()}
if mode=="unknown-source": witness["source"]="guessed-command"
if mode=="wrong-cdp": witness["cdpPid"]=renderer.pid
if mode!="missing-witness": Path(sys.argv[1]).write_text(json.dumps(witness))
browser.wait();renderer.wait()`;
    const child = Bun.spawn(["/usr/bin/python3", "-c", collector, join(root, "tree.json"),
      executable, "-c", program, join(root, "browser.json"), mode, executable], { stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    return JSON.parse(await readFile(join(root, "tree.json"), "utf8"));
  } finally { await rm(root, { recursive: true, force: true }); }
}

test.skipIf(process.platform !== "linux")("erased renderer command lines cannot replace the exact owned browser root", async () => {
  const report = await collectRootWitnessFixture();
  expect(Object.keys(report.browserCommands)).toHaveLength(1);
  expect(report.browserIdentity.status).toBe("verified");
  expect(report.browserIdentity.witness.cdpPid).toBe(report.browserIdentity.witness.pid);
  expect(report.browserIdentity.witness.start).toMatch(/^[0-9]+$/);
  expect(report.cleanup).toBe("wait returned ECHILD");
  expect(report.sampleFailures).toBe(0);
  expect(report.cpuSeconds).toBeGreaterThanOrEqual(0.1);
  const erased = Object.entries(report.browserObservations as Record<string, { argv: string[] }>).find(([, observation]) =>
    observation.argv[0] === "" && observation.argv.at(-1)?.includes("--renderer-client-id=8"));
  expect(erased).toBeDefined();
  const rendererPid = Number(erased?.[0].split(":")[0]);
  expect(report.samples.some((sample: { processes: import("../experiments/browser-performance").ProcessSample[] }) =>
    sample.processes.some(process => process.pid === rendererPid && process.rssBytes >= 24 * 1048576))).toBe(true);
}, 10000);

for (const mode of ["missing-witness", "wrong-start", "wrong-pid", "wrong-executable", "wrong-worker", "wrong-ancestry", "unknown-source", "wrong-cdp", "unknown-headless", "false-headless"]) {
  test.skipIf(process.platform !== "linux")(`browser root witness refuses ${mode}`, async () => {
    const report = await collectRootWitnessFixture(mode);
    expect(report.browserIdentity.status).toBe("invalid");
    expect(Object.keys(report.browserCommands)).toHaveLength(0);
    expect(report.cleanup).toBe("wait returned ECHILD");
    expect(report.sampleFailures).toBe(0);
  }, 10000);
}
