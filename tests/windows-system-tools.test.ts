import { expect, test } from "bun:test";
import { systemArgv, tarExecutable } from "../src/platform";

const env = { SystemRoot: "C:\\Windows" };

test("Windows system tools resolve to System32 so a Git for Windows PATH cannot shadow them", () => {
  expect(systemArgv(["whoami.exe", "/user"], env, "win32")).toEqual(["C:\\Windows\\System32\\whoami.exe", "/user"]);
  expect(systemArgv(["SCHTASKS.EXE", "/Query"], env, "win32")).toEqual(["C:\\Windows\\System32\\SCHTASKS.EXE", "/Query"]);
  expect(systemArgv(["powershell.exe", "-NoProfile"], env, "win32")[0]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("other programs and other platforms pass through unchanged", () => {
  expect(systemArgv(["bun.exe", "x"], env, "win32")).toEqual(["bun.exe", "x"]);
  expect(systemArgv(["whoami.exe", "/user"], env, "linux")).toEqual(["whoami.exe", "/user"]);
  expect(systemArgv([], env, "win32")).toEqual([]);
});

test("tar is the System32 bsdtar on Windows and the PATH tar elsewhere", () => {
  expect(tarExecutable(env, "win32")).toBe("C:\\Windows\\System32\\tar.exe");
  expect(tarExecutable(env, "darwin")).toBe("tar");
  expect(tarExecutable({}, "win32")).toBe("C:\\Windows\\System32\\tar.exe");
});
