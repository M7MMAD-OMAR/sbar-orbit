import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installService, uninstallService, serviceSocketPath } from "../src/service";

// Writing the units is all this does. Enabling, starting and stopping stay with systemctl,
// so the user runs the commands that change their session, and can see exactly what changed.
const [command, argument] = process.argv.slice(2);
const unitDirectory = process.env.ORBIT_UNIT_DIR ?? join(homedir(), ".config/systemd/user");
const launcher = argument ?? resolve(import.meta.dir, "../bin/sbar-orbit");

if (command === "install") {
  const result = await installService(launcher, unitDirectory);
  console.log(JSON.stringify({ ...result, socket: serviceSocketPath(),
    next: ["systemctl --user daemon-reload", "systemctl --user enable --now sbar-orbit.service"],
    note: "Enable starts the broker at login. Surviving logout additionally needs loginctl enable-linger, which requires elevation.",
  }, null, 2));
} else if (command === "uninstall") {
  console.log(JSON.stringify({ ...await uninstallService(unitDirectory),
    next: ["systemctl --user disable --now sbar-orbit.service", "systemctl --user daemon-reload"] }, null, 2));
} else {
  console.error("Usage: bun run scripts/service.ts install|uninstall [LAUNCHER]");
  process.exitCode = 1;
}
