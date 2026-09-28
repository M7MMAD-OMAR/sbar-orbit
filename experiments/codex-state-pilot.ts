import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { FedoraBackend } from "../src/fedora";

async function privateLogSummary(previousHomes: Set<string>) {
  const root = join(homedir(), ".cache", "sbar-orbit", "codex-private");
  const homes = (await readdir(root)).filter(name => name.startsWith("codex-") && !previousHomes.has(name));
  const summary: { path: string; bytes: number; errors: Record<string, number> }[] = [];
  const databaseLogs: unknown[] = [];
  for (const name of homes) {
    const home = join(root, name, "home");
    const databasePath = join(home, ".codex", "logs_2.sqlite");
    if (await Bun.file(databasePath).exists()) {
      const database = new Database(databasePath, { readonly: true });
      try {
        const levels = database.query("SELECT level, count(*) AS count FROM logs GROUP BY level").all();
        const targets = database.query("SELECT level, target, count(*) AS count FROM logs WHERE level IN ('ERROR', 'WARN') GROUP BY level, target ORDER BY count DESC LIMIT 15").all();
        const body = database.query("SELECT feedback_log_body FROM logs WHERE level IN ('ERROR', 'WARN')").all()
          .map(row => String((row as { feedback_log_body?: unknown }).feedback_log_body ?? ""));
        const terms = Object.fromEntries(["401", "403", "ENOENT", "ECONN", "timeout", "thread/read", "rollout", "history", "cwd"]
          .map(term => [term, body.filter(value => value.toLowerCase().includes(term.toLowerCase())).length]));
        databaseLogs.push({ levels, targets, terms });
      } finally { database.close(); }
    }
    for (const relative of [".config/Codex/logs", ".codex/log", ".codex/logs"]) {
      const directory = join(home, relative);
      for (const entry of await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile() || !/\.log$/i.test(entry.name)) continue;
        const path = join(entry.parentPath, entry.name);
        const info = await stat(path);
        if (info.size > 4 * 1024 * 1024) continue;
        const content = await readFile(path, "utf8");
        const errors = Object.fromEntries(["401", "403", "ENOENT", "ECONN", "timeout", "error", "failed"]
          .map(term => [term, content.toLowerCase().split(term.toLowerCase()).length - 1]));
        summary.push({ path: path.slice(home.length + 1), bytes: info.size, errors });
      }
    }
  }
  return { files: summary, databaseLogs };
}

const backend = await FedoraBackend.create();
try {
  const storage = join(homedir(), ".cache", "sbar-orbit", "codex-private");
  const previousHomes = new Set(await readdir(storage).catch(() => []));
  const projectPath = process.env.ORBIT_CODEX_PROJECT_PATH;
  const launch = await backend.act({ type: "launch-app", app: "codex", profile: "active",
    ...(projectPath === undefined ? {} : { projectPath }) });
  await Bun.sleep(18000);
  if (projectPath && process.env.ORBIT_CODEX_OPEN_PROJECT) {
    await backend.act({ type: "key", key: "Ctrl+O" });
    await Bun.sleep(1500);
    if (["home", "select"].includes(process.env.ORBIT_CODEX_OPEN_PROJECT)) {
      await backend.act({ type: "pointer", x: 698, y: 107 });
      await Bun.sleep(2000);
      if (process.env.ORBIT_CODEX_OPEN_PROJECT === "select") {
        await backend.act({ type: "pointer", x: 935, y: 140 });
        await backend.act({ type: "pointer", x: 1210, y: 779 });
        await Bun.sleep(12000);
      }
    }
    if (process.env.ORBIT_CODEX_OPEN_PROJECT === "1") {
      await backend.act({ type: "key", key: "Ctrl+L" });
      await backend.act({ type: "paste", text: projectPath });
      await backend.act({ type: "key", key: "Enter" });
      await Bun.sleep(12000);
    }
  }
  if (process.env.ORBIT_CODEX_OPEN_PINNED) {
    const selected = Number(process.env.ORBIT_CODEX_OPEN_PINNED);
    if (!Number.isInteger(selected) || selected < 1 || selected > 2) throw new Error("Invalid pinned choice");
    await backend.act({ type: "pointer", x: 116, y: selected === 1 ? 390 : 430 });
    await Bun.sleep(Number(process.env.ORBIT_CODEX_WAIT_MS ?? 45000));
  }
  const frame = await backend.observe();
  const imagePath = `/tmp/orbit-codex-state-${crypto.randomUUID()}.jpg`;
  await writeFile(imagePath, Buffer.from(frame.image, "base64"), { mode: 0o600 });
  console.log(JSON.stringify({
    imagePath, presence: frame.presence,
    state: (launch as { profileSnapshot?: unknown }).profileSnapshot,
    logs: await privateLogSummary(previousHomes),
  }));
} finally {
  await backend.close();
}
