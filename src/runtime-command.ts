/**
 * The Bun that is running this code, not whatever `bun` resolves to on PATH.
 *
 * Both launchers already resolve Bun by location, for the reason `bin/sbar-orbit` states: a service
 * or an agent host starts Orbit with its own PATH, which need not carry Bun at all. Spawning a bare
 * "bun" threw that away and failed with `Executable not found in $PATH`, measured on the Windows
 * guest where Bun lives outside PATH. `process.execPath` is the interpreter already in hand.
 */
export function bunExecutable() {
  return process.execPath || Bun.which("bun") || "bun";
}


/**
 * What makes a directory a prepared version: its launcher, which is the file `current` ultimately
 * resolves to. The name differs by platform, and hardcoding the bash one made every Windows
 * activation refuse with "is not a prepared version" even though the directory was complete.
 */
export function launcherName() {
  return process.platform === "win32" ? "bin/sbar-orbit.cmd" : "bin/sbar-orbit";
}
