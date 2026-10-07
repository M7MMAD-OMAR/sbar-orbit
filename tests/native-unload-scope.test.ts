import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixturePhases } from "./fixture-phases";

(process.platform === "linux" ? test : test.skip)("native population readiness rejects incomplete and malformed kernel evidence", async () => {
  const trace = fixturePhases("population-parser-child");
  try {
    trace.phase("child-spawn", "start");
    const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "../experiments/ghost-cursor/native_unload_scope_test.py")],
      { stdout: "pipe", stderr: "pipe" });
    trace.phase("child-spawn", "done");
    let partial = "";
    const stderr = child.stderr.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        try {
          partial = (partial + new TextDecoder().decode(chunk)).slice(-2048);
          const lines = partial.split("\n");
          partial = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith('{"populationParserPhase":')) continue;
            const value: unknown = JSON.parse(line);
            if (!value || typeof value !== "object") continue;
            const record = value as Record<string, unknown>;
            if (typeof record.populationParserPhase === "string" &&
                ["budget-check", "actual-parser-read", "temporary-source-write", "actual-compiler", "compiled-probe", "ten-parser-assertions"].includes(record.populationParserPhase) &&
                (record.outcome === "start" || record.outcome === "done"))
              trace.phase(`python.${record.populationParserPhase}`, record.outcome);
          }
        } catch {}
      },
    }));
    const [output, error, code] = await Promise.all([
      trace.observe("stdout-eof", new Response(child.stdout).text()),
      trace.observe("stderr-eof", new Response(stderr).text()),
      trace.observe("child-exit", child.exited),
    ]);
    expect({ code, output }).toEqual({ code: 0, output: "" });
    expect(error).toContain("Ran 1 test");
  } finally { trace.finish(); }
});
