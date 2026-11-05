import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { platformNativeEntry, resolvePlatformNativeApplication } from "../src/platform-native";

test("native helper entry never resolves a caller command from PATH", () => {
  expect(platformNativeEntry("darwin").slice(0, 2)).toEqual(["/usr/bin/python3", "-I"]);
  const windows = platformNativeEntry("win32", { SystemRoot: "C:\\Windows" });
  expect(windows[0]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  expect(windows).toContain("-NoProfile");
  expect(windows.at(-1)).toEndWith("platform_windows.ps1");
  expect(() => platformNativeEntry("win32", { SystemRoot: "relative" })).toThrow();
  expect(() => platformNativeEntry("win32", { SystemRoot: "\\\\remote\\system" })).toThrow();
  expect(() => platformNativeEntry("linux")).toThrow();
});

test("platform-native helpers have no global pointer key or focus injection route", async () => {
  const [windows, macos] = await Promise.all([Bun.file("src/native/platform_windows.ps1").text(), Bun.file("src/native/platform_macos.py").text()]);
  for (const text of [windows, macos]) for (const forbidden of ["SendInput(", "SetCursorPos(", "SetForegroundWindow(", "CGEventPost(", "CGWarpMouseCursorPosition("])
    expect(text).not.toContain(forbidden);
  expect(windows).toContain("CREATE_BREAKAWAY");
  expect(macos).toContain('"AXUIElementPerformAction"');
  expect(macos).toContain('"CGPreflightScreenCaptureAccess"');
});

test.skipIf(process.platform !== "linux")("native registered launch resolves exact bundles and App Paths rather than arbitrary executables", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-platform-registration-"));
  try {
    const executable = join(root, "editor.exe"); await copyFile("/usr/bin/printenv", executable);
    const windows = await resolvePlatformNativeApplication("editor.exe", "win32", { registryEntries: [{ id: "editor.exe", executable }], env: {}, home: root });
    expect(windows).toEqual({ applicationId: "editor.exe", executable });
    await expect(resolvePlatformNativeApplication(executable, "win32", { registryEntries: [{ id: "editor.exe", executable }], env: {}, home: root })).rejects.toThrow();
    const bundle = join(root, "Owned.app"), contents = join(bundle, "Contents");
    await mkdir(join(contents, "MacOS"), { recursive: true }); await copyFile(executable, join(contents, "MacOS", "editor"));
    const lt = String.fromCharCode(60), gt = String.fromCharCode(62);
    const element = (tag: string, value: string) => `${lt}${tag}${gt}${value}${lt}/${tag}${gt}`;
    await writeFile(join(contents, "Info.plist"), element("plist", element("dict", element("key", "CFBundleExecutable") + element("string", "editor") + element("key", "CFBundleIdentifier") + element("string", "org.example.Owned"))));
    const macos = await resolvePlatformNativeApplication("org.example.Owned", "darwin", { bundleRoots: [root], home: root, env: {} });
    expect(macos).toEqual({ applicationId: "org.example.Owned", executable: join(contents, "MacOS", "editor"), bundlePath: bundle });
    await expect(resolvePlatformNativeApplication("org.example.Missing", "darwin", { bundleRoots: [root], home: root, env: {} })).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("owned native protocol fixtures validate retained targets authority and uncertain delivery", async () => {
  const child = Bun.spawn(["/usr/bin/python3", "-B", "tests/platform_native_protocol_test.py"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
  expect(stderr).toContain("Ran 14 tests");
  expect(stderr).toContain("OK");
});

test.skipIf(process.platform !== "win32" && process.platform !== "darwin")("target-platform helper loads native API bindings and returns an exact framed status without desktop actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-platform-load-"));
  try {
    const requestId = "f".repeat(32);
    const child = Bun.spawn([...platformNativeEntry(), root, root, join(root, "unused-plan.json")], {
      stdin: new Blob([JSON.stringify({ requestId, method: "status", params: {} }) + "\n"]), stdout: "pipe", stderr: "pipe", timeout: 15000,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    const reply = JSON.parse(stdout.trim());
    expect(reply.requestId).toBe(requestId);
    expect(typeof reply.ok).toBe("boolean");
    if (reply.ok) expect(reply.result.nativeAcceptance).toBe("unmeasured");
    else expect(["ACCESSIBILITY_PERMISSION_REQUIRED", "NATIVE_PERMISSION_REQUIRED"]).toContain(reply.error.code);
  } finally { await rm(root, { recursive: true, force: true }); }
});
