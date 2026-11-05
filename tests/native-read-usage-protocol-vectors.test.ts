import { expect } from "bun:test";
import { join } from "node:path";
import { linuxOnlySuite } from "./platform-support";

const test = linuxOnlySuite("finite Python canonical wire vector checks, no process interop qualification");
test("Python actual parser and encoder validate the same literal wire fixtures", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_read_usage_protocol_vectors.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, err, code }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("Ran 6 tests"); expect(err).toContain("OK"); expect(err).not.toContain("skipped");
}, 10000);
