import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installService, uninstallService, serviceSocketPath } from "../src/service";
import { autostartStatus, disableAutostart, enableAutostart } from "../src/autostart";

// Installing enables. A person who installs a thing meant to be waiting for their agents should not have
// to discover from documentation that it is not running, and this used to stop short of enabling on the
// reasoning that changing their session should be their own command. Pass --no-autostart to get the old
// behaviour, which writes the units and touches nothing else.
const [command, argument] = process.argv.slice(2);
const unitDirectory = process.env.ORBIT_UNIT_DIR ?? join(homedir(), ".config/systemd/user");
const launcher = argument ?? resolve(import.meta.dir, "../bin/sbar-orbit");

const wanted = !process.argv.includes("--no-autostart");

if (command === "install") {
  const result = await installService(launcher, unitDirectory);
  const autostart = wanted ? await enableAutostart(launcher) : undefined;
  console.log(JSON.stringify({ ...result, socket: serviceSocketPath(), autostart,
    next: wanted ? [] : ["systemctl --user daemon-reload", "systemctl --user enable --now sbar-orbit.service"],
    note: wanted
      ? "Orbit now starts with your desktop. Surviving a full logout additionally needs loginctl enable-linger, which requires elevation."
      : "Nothing was enabled. sbar-orbit autostart enable does that when you want it.",
  }, null, 2));
} else if (command === "uninstall") {
  const autostart = await disableAutostart();
  console.log(JSON.stringify({ ...await uninstallService(unitDirectory), autostart,
    next: ["systemctl --user daemon-reload"] }, null, 2));
} else if (command === "autostart") {
  const verb = argument ?? "status";
  if (verb === "enable") console.log(JSON.stringify(await enableAutostart(resolve(import.meta.dir, "../bin/sbar-orbit")), null, 2));
  else if (verb === "disable") console.log(JSON.stringify(await disableAutostart(), null, 2));
  else if (verb === "status") console.log(JSON.stringify(await autostartStatus(), null, 2));
  else {
    console.error("Usage: sbar-orbit autostart enable|disable|status");
    process.exitCode = 1;
  }
} else {
  console.error("Usage: bun run scripts/service.ts install|uninstall|autostart [LAUNCHER|VERB] [--no-autostart]");
  process.exitCode = 1;
}
