import { expect, test } from "bun:test";
import { join } from "node:path";
import { nativeControlStatus, requireNativeAdapter } from "../src/native-availability";

test("historical incident evidence is not a permanent native adapter prohibition", () => {
  if (process.platform === "linux") {
    expect(() => requireNativeAdapter()).not.toThrow();
    expect(nativeControlStatus().state).toBe("available");
  } else {
    expect(() => requireNativeAdapter()).toThrow("adapter is not implemented");
    expect(nativeControlStatus().state).toBe("unsupported");
  }
});

(process.platform === "linux" ? test : test.skip)("actual plugin source and compositor ABI must match before a claim", async () => {
  const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "native_plugin_compatibility_test.py")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code, err }).toMatchObject({ out: "", code: 0 });
  expect(err).toContain("OK");
});
