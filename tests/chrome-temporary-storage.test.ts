import { expect, test } from "bun:test";
import { access, chmod, lstat, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultChromeExecutable, launchChrome } from "../src/chrome";
import { createWorkspaceDirectory } from "../src/workspace-storage";

const linux = process.platform === "linux";

async function expectOwnedDisk(directory: string) {
  expect(directory.startsWith(`/var/tmp/orbit-chrome-${process.getuid?.()}/chrome-`)).toBe(true);
  const info = await lstat(directory);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Private temporary storage requires a user identity");
  expect(info.uid).toBe(uid);
  if (info.mode === undefined) throw new Error("Private temporary directory has no permission mode");
  expect(info.mode & 0o777).toBe(0o700);
  expect(info.isSymbolicLink()).toBe(false);
  expect([0x01021994, 0x858458f6]).not.toContain((await statfs(directory)).type);
}

test.skipIf(!linux)("failed Chrome startup removes its private temporary files", async () => {
  const profile = await createWorkspaceDirectory("chrome-temp-failure");
  const executable = join(profile, "exit-browser");
  const marker = join(profile, "temporary-path");
  try {
    await writeFile(executable, '#!/bin/sh\nprintf "%s" "$TMPDIR" > "$ORBIT_TEMP_PROBE"\ntouch "$TMPDIR/child-owned-file"\nexit 7\n');
    await chmod(executable, 0o700);
    const inherited = process.env.ORBIT_TEMP_PROBE;
    process.env.ORBIT_TEMP_PROBE = marker;
    try {
      await expect(launchChrome(profile, undefined, { executable })).rejects.toMatchObject({ code: "BACKEND_FAILED" });
    } finally {
      if (inherited === undefined) delete process.env.ORBIT_TEMP_PROBE;
      else process.env.ORBIT_TEMP_PROBE = inherited;
    }
    const directory = await readFile(marker, "utf8");
    expect(directory.startsWith(`/var/tmp/orbit-chrome-${process.getuid?.()}/chrome-`)).toBe(true);
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(profile, { recursive: true, force: true }); }
}, 15000);

test.skipIf(!linux || !defaultChromeExecutable())("Chrome renders with an inherited long TMPDIR and cleans its own short storage", async () => {
  const profile = await createWorkspaceDirectory("chrome-temp-success");
  const inherited = process.env.TMPDIR;
  process.env.TMPDIR = join(profile, "inherited-temporary-directory-with-a-path-longer-than-the-unix-socket-limit", "another-long-segment");
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    browser = await launchChrome(profile);
    const owner = JSON.parse(await readFile(join(profile, "owner.json"), "utf8")) as { pid: number };
    const environment = (await readFile(`/proc/${owner.pid}/environ`, "utf8")).split("\0");
    const directory = environment.find(value => value.startsWith("TMPDIR="))?.slice(7);
    expect(directory).toBeDefined();
    if (!directory) throw new Error("Chrome lacks private temporary storage");
    await expectOwnedDisk(directory);
    await browser.page.setContent("<h1>Private temporary storage</h1>");
    expect(await browser.page.locator("h1").textContent()).toBe("Private temporary storage");
    await browser.close();
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (inherited === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = inherited;
    await browser?.close();
    await rm(profile, { recursive: true, force: true });
  }
}, 30000);

test.skipIf(!linux || !defaultChromeExecutable())("automatic Chrome exit still notifies listeners when temporary removal fails", async () => {
  const profile = await createWorkspaceDirectory("chrome-temp-cleanup");
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let directory: string | undefined;
  try {
    browser = await launchChrome(profile);
    const owner = JSON.parse(await readFile(join(profile, "owner.json"), "utf8")) as { pid: number };
    directory = (await readFile(`/proc/${owner.pid}/environ`, "utf8")).split("\0")
      .find(value => value.startsWith("TMPDIR="))?.slice(7);
    if (!directory) throw new Error("Chrome lacks private temporary storage");
    await writeFile(join(directory, "cleanup-denied"), "owned test file");
    await chmod(directory, 0o500);
    let notifications = 0;
    browser.onClose(() => { notifications++; });
    await browser.browser.close();
    const deadline = Date.now() + 6000;
    while (!notifications && Date.now() < deadline) await Bun.sleep(25);
    expect(notifications).toBe(1);
    await expect(browser.close()).rejects.toMatchObject({ code: "EACCES" });
    browser.onClose(() => { notifications++; });
    expect(notifications).toBe(2);
  } finally {
    if (directory) {
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
    await browser?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
  }
}, 15000);
