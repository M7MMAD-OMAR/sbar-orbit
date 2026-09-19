import { test, expect } from "bun:test";
import { workspaceRoot } from "../src/workspace-storage";
import { stateDirectory, serviceSocketPath } from "../src/service";

/**
 * POSIX environment variables do not relocate Orbit's Windows state.
 *
 * The three Windows paths honoured `XDG_CACHE_HOME`, `XDG_STATE_HOME` and `XDG_RUNTIME_DIR` ahead of
 * their own branch, so anything that exported one chose where live session profiles, the diagnostics
 * journal and the BROKER SOCKET landed. A Windows process with those set got them from Git Bash, MSYS2
 * or an agent host, not from a person choosing a location.
 *
 * That mattered because the check that would catch a world readable directory does not run there. The
 * POSIX mode test is disabled on Windows (`createWorkspaceDirectory` skips uid and mode) since Windows
 * stores no mode, and the ACL reasoning that replaces it is about `%LOCALAPPDATA%` specifically.
 * Measured on the guest, `%LOCALAPPDATA%` inherits SYSTEM, Administrators and the owning user, while a
 * directory under a drive root handed down `BUILTIN\Users: ReadAndExecute` and
 * `NT AUTHORITY\Authenticated Users: Modify`. Relocating there kept the reasoning and lost the ACL.
 *
 * `updateRoot` already ignored XDG on Windows. These three now agree with it.
 */

const windowsEnv = {
  LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
  XDG_CACHE_HOME: "/tmp/hijack",
  XDG_STATE_HOME: "/tmp/hijack",
  XDG_RUNTIME_DIR: "/tmp/hijack",
} as NodeJS.ProcessEnv;

test("XDG_CACHE_HOME cannot move the Windows workspace root", () => {
  const root = workspaceRoot(windowsEnv, "win32");
  expect(root).not.toContain("hijack");
  expect(root).toContain("AppData");
  // Linux is unchanged: there XDG is the convention rather than a leak, and honouring it is correct.
  expect(workspaceRoot({ XDG_CACHE_HOME: "/data/cache" } as NodeJS.ProcessEnv, "linux"))
    .toContain("/data/cache");
});

test("XDG_STATE_HOME cannot move the Windows state directory", () => {
  const root = stateDirectory(windowsEnv, "win32");
  expect(root).not.toContain("hijack");
  expect(root).toContain("AppData");
  expect(stateDirectory({ XDG_STATE_HOME: "/data/state" } as NodeJS.ProcessEnv, "linux"))
    .toContain("/data/state");
});

test("XDG_RUNTIME_DIR cannot move the Windows broker socket", () => {
  // The most consequential of the three: the socket's only boundary is the ACL of the directory it
  // binds in, and the control channel behind it takes session.create, session.act and session.observe
  // with no caller authentication.
  const socket = serviceSocketPath(undefined, windowsEnv, "win32");
  expect(socket).not.toContain("hijack");
  expect(socket).toContain("AppData");
  expect(socket).toContain("broker.sock");
});

test("an explicitly passed runtime directory still wins on Windows", () => {
  // A caller STATING a path is different from a POSIX variable leaking in from a shell, and the
  // managed-service code passes one. Refusing both would break that caller.
  const socket = serviceSocketPath("D:\\orbit\\run", windowsEnv, "win32");
  expect(socket).toContain("D:\\orbit\\run");
  expect(socket).not.toContain("hijack");
});

test("Linux still honours XDG_RUNTIME_DIR", () => {
  expect(serviceSocketPath(undefined, { XDG_RUNTIME_DIR: "/run/user/1000" } as NodeJS.ProcessEnv, "linux"))
    .toContain("/run/user/1000");
});

/**
 * Every platform path is built with THAT platform's separator, asked from this host.
 *
 * This is the fifth time in this port that a platform question was answered in the HOST's terms, and
 * the first four were each found by the Windows guest rather than by the compiler. The rule: the moment
 * a function takes `platform`, every path it builds for a platform that is not this one has to use that
 * platform's own join. A single-platform CI never fails on it.
 *
 * Asserted here rather than only on the guest, so the NEXT occurrence is caught on any host.
 */
test("a platform's paths use that platform's separator, whatever host asks", () => {
  const posixEnv = { XDG_RUNTIME_DIR: "/run/user/1000", XDG_STATE_HOME: "/data/state", XDG_CACHE_HOME: "/data/cache" } as NodeJS.ProcessEnv;
  for (const platform of ["linux", "darwin"] as const) {
    // A POSIX answer must never carry a backslash, even when this host is Windows.
    expect(serviceSocketPath(undefined, posixEnv, platform)).not.toContain("\\");
    expect(stateDirectory(posixEnv, platform)).not.toContain("\\");
    expect(workspaceRoot(posixEnv, platform)).not.toContain("\\");
  }
  // And the Windows answers must never carry a forward slash, even when this host is Linux.
  const winEnv = { LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" } as NodeJS.ProcessEnv;
  expect(serviceSocketPath(undefined, winEnv, "win32")).not.toContain("/");
  expect(stateDirectory(winEnv, "win32")).not.toContain("/");
  expect(workspaceRoot(winEnv, "win32")).not.toContain("/");
});
