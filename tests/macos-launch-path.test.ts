import { expect, test } from "bun:test";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brokerAgentPlist } from "../src/macos-autostart";
import { fixtureRoot } from "./platform-support";

// Executes only a copied launcher and recorder scripts. This models launchd's
// minimal environment; it does not measure a Mac login or start a broker.
const unixTest = process.getuid ? test : test.skip;
const decodeXml = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g,
  (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity] ?? ""));

for (const customLocation of ["custom runtime/bin", "runtime & tools/bin"]) {
  unixTest(`LaunchAgent keeps the installer Bun in ${customLocation}`, async () => {
    const root = await fixtureRoot("orbit-launch-path-");
    try {
      const home = join(root, "account & spaces");
      const launcher = join(root, "source", "bin", "sbar-orbit");
      const bunDirectory = join(root, customLocation);
      const defaultDirectory = join(home, ".bun", "bin");
      const record = join(root, "chosen-runtime");
      await mkdir(join(root, "source", "bin"), { recursive: true });
      await mkdir(bunDirectory, { recursive: true });
      await mkdir(defaultDirectory, { recursive: true });
      await copyFile(join(import.meta.dir, "..", "bin", "sbar-orbit"), launcher);
      for (const [directory, label] of [[bunDirectory, "installer"], [defaultDirectory, "default"]] as const) {
        if (!directory) throw new Error("Fixture runtime directory missing");
        await writeFile(join(directory, "bun"), `#!/bin/sh\nprintf '%s\\n' '${label}' "$@" > "$ORBIT_FIXTURE_RECORD"\n`, { mode: 0o700 });
      }
      const plist = brokerAgentPlist(launcher, join(root, "broker.sock"), home, bunDirectory);
      const settings = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1];
      if (!settings) throw new Error("LaunchAgent environment missing");
      const environment: Record<string, string> = { PATH: "/usr/bin:/bin", ORBIT_FIXTURE_RECORD: record };
      for (const match of settings.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
        const [, key, value] = match;
        if (key === undefined || value === undefined) throw new Error("Invalid environment entry");
        environment[decodeXml(key)] = decodeXml(value);
      }
      const child = Bun.spawn(["/bin/bash", launcher, "serve", "--managed-socket"], {
        env: environment, stdout: "pipe", stderr: "pipe",
      });
      const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(errors).toBe("");
      expect(code).toBe(0);
      expect((await readFile(record, "utf8")).trim().split("\n")).toEqual([
        "installer", "run", join(root, "source", "scripts", "limited.ts"),
        "bun", "run", join(root, "source", "src", "cli.ts"), "serve", "--managed-socket",
      ]);
      expect(plist).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
