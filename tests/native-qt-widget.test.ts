import { expect, test } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? test : test.skip)("Qt identity only routes retained UUID widgets and rejects unqualified nodes", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_qt_identity_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, err, code }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("OK");
}, 10000);

const fixture = process.env.ORBIT_QT_WIDGET_TEST_FIXTURE;
(process.platform === "linux" && fixture ? test : test.skip)("Qt helper wire actions retain one widget lifetime and refuse deleted replacement", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_qt_widget_wire_test.py"), fixture!], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, err, code }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("OK");
}, 15000);
