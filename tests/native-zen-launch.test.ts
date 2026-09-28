import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseNativeAction } from "../src/fedora";
import { discoverZenInstallation, prepareZenLaunch } from "../src/native-zen-launch";

async function fixture() {
  const root = await mkdtemp("/tmp/orbit-zen-launch-");
  const home = join(root, "home");
  const profileBase = join(home, ".var/app/app.zen_browser.zen/config/zen");
  const profile = join(profileBase, "Profiles", "fixture.default");
  const deploymentFiles = join(root, "deployment", "files");
  const session = join(root, "session");
  const libraries = join(root, "libraries");
  await mkdir(profile, { recursive: true });
  await mkdir(join(deploymentFiles, "zen"), { recursive: true });
  await mkdir(session, { mode: 0o700 });
  await mkdir(libraries);
  await writeFile(join(profileBase, "profiles.ini"),
    "[Profile0]\nName=Default\nIsRelative=1\nPath=Profiles/fixture.default\nDefault=1\n[Installfixture]\nDefault=Profiles/fixture.default\n");
  await writeFile(join(deploymentFiles, "zen", "zen"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const wayland = join(session, "wayland-0");
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(wayland, resolve));
  return { root, home, profileBase, profile, deploymentFiles, session, libraries, wayland, server };
}

test("Zen launch-app accepts no caller paths or executable arguments", () => {
  expect(parseNativeAction({ type: "launch-app", app: "zen", profile: "active" }))
    .toEqual({ type: "launch-app", app: "zen", profile: "active" });
  for (const extra of [
    { argv: ["/usr/bin/zen"] }, { sourceProfile: "/tmp/other" }, { url: "https://example.com" },
    { openPath: "/tmp/file" }, { extensions: [] },
  ]) expect(() => parseNativeAction({ type: "launch-app", app: "zen", profile: "active", ...extra })).toThrow();
});

test("Zen launcher discovers its own profile and prepares an offline mount root", async () => {
  const f = await fixture();
  let prepared: Awaited<ReturnType<typeof prepareZenLaunch>> | undefined;
  try {
    const install = await discoverZenInstallation({ home: f.home, deploymentFiles: f.deploymentFiles });
    expect(install.profile).toBe(f.profile);
    prepared = await prepareZenLaunch(f.session, f.wayland, f.libraries,
      { home: f.home, deploymentFiles: f.deploymentFiles });
    expect(prepared.zenSnapshot.network).toBe("offline");
    expect(prepared.zenSnapshot.hostFiles).toBe("unavailable");
    expect(prepared.argv).toContain("--unshare-net");
    expect(prepared.argv).toContain("--clearenv");
    expect(prepared.argv).toContain("--dev");
    expect(prepared.argv).not.toContain("--dev-bind");
    expect(prepared.argv).not.toContain("/");
    expect(prepared.argv).not.toContain(f.profile);
    expect(prepared.argv).not.toContain(f.home);
    expect(prepared.argv.at(-4)).toBe("/app/zen/zen");
    expect(prepared.argv.at(-3)).toBe("--no-remote");
    expect(prepared.argv.at(-2)).toBe("--profile");
    expect(prepared.argv.at(-1)?.startsWith("/orbit/zen/zen-profile-")).toBe(true);
  } finally {
    await prepared?.release();
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Zen discovery rejects a default profile outside its Flatpak state", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.profileBase, "profiles.ini"), "[Installfixture]\nDefault=../../../../outside\n");
    await expect(discoverZenInstallation({ home: f.home, deploymentFiles: f.deploymentFiles })).rejects.toThrow();
    expect(await readdir(f.session)).toEqual(["wayland-0"]);
  } finally {
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});
