import { expect, test } from "bun:test";
import { join } from "node:path";
import { connectorEntry } from "../src/connector-entry";

test("an agent host is handed the launcher, not an interpreter and a source file", () => {
  expect(connectorEntry({ launcher: "/prefix/bin/sbar-orbit", source: "/opt/orbit", platform: "linux" }))
    .toEqual({ command: "/prefix/bin/sbar-orbit", args: ["mcp"] });
});

test("the entry names no checkout, no version and no interpreter", () => {
  const entry = connectorEntry({ launcher: "/prefix/bin/sbar-orbit", source: "/srv/checkouts/sbar-orbit-0.1.0", platform: "linux" });
  const printed = JSON.stringify(entry);
  expect(printed).not.toContain("checkouts");
  expect(printed).not.toContain("0.1.0");
  expect(printed).not.toContain("bun");
});

test("the same source under two prefixes gives two entries, which is what an upgrade switches", () => {
  const source = "/opt/orbit";
  expect(connectorEntry({ launcher: "/a/bin/sbar-orbit", source, platform: "linux" }).command)
    .not.toBe(connectorEntry({ launcher: "/b/bin/sbar-orbit", source, platform: "linux" }).command);
});

test("a run with no launcher linked still produces a usable entry", () => {
  expect(connectorEntry({ source: "/opt/orbit", platform: "linux", interpreter: "/usr/bin/bun" }))
    .toEqual({ command: "/usr/bin/bun", args: [join("/opt/orbit", "src/mcp.ts")] });
});

test("Windows names its own launcher, and the suffix is added once", () => {
  expect(connectorEntry({ launcher: "C:\\orbit\\bin\\sbar-orbit", source: "C:\\orbit", platform: "win32" }))
    .toEqual({ command: "C:\\orbit\\bin\\sbar-orbit.cmd", args: ["mcp"] });
  expect(connectorEntry({ launcher: "C:\\orbit\\bin\\sbar-orbit.cmd", source: "C:\\orbit", platform: "win32" }).command)
    .toBe("C:\\orbit\\bin\\sbar-orbit.cmd");
});

test("a Windows host that cannot spawn a .cmd is given the interpreter and the module", () => {
  expect(connectorEntry({ launcher: "C:\\orbit\\bin\\sbar-orbit", source: "C:\\orbit", platform: "win32",
    interpreter: "C:\\orbit\\bun.exe", windowsFallback: true }))
    .toEqual({ command: "C:\\orbit\\bun.exe", args: [join("C:\\orbit", "src/mcp.ts")] });
});
