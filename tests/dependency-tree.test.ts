import { test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The dependency tree, asserted rather than audited once.
 *
 * An audit of the 98 installed packages found three properties worth keeping, and a property that is
 * only true until someone bumps a dependency is not a property, it is a snapshot. So each one is a
 * test: zero install-time code execution, zero copyleft in a tree that ships as a source archive,
 * and zero native addons to have an ABI on Windows.
 *
 * These read node_modules, which the suite already requires to run at all. If it is absent the tests
 * skip loudly rather than passing vacuously, because "not measured" is not a pass.
 */

const modules = join(import.meta.dir, "..", "node_modules");
const installed = existsSync(modules);

/** Every installed manifest, including one level of scope directories. */
function manifests(): { name: string; json: Record<string, unknown> }[] {
  const out: { name: string; json: Record<string, unknown> }[] = [];
  const read = (dir: string, name: string) => {
    const file = join(dir, "package.json");
    if (!existsSync(file)) return;
    try {
      out.push({ name, json: JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> });
    } catch {
      // A manifest that does not parse is not a licensing or lifecycle risk by itself.
    }
  };
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith(".")) continue;
    const path = join(modules, entry);
    if (!statSync(path).isDirectory()) continue;
    if (entry.startsWith("@")) {
      for (const scoped of readdirSync(path)) read(join(path, scoped), `${entry}/${scoped}`);
      continue;
    }
    read(path, entry);
  }
  return out;
}

test.skipIf(!installed)("no installed package runs code at install time", () => {
  const all = manifests();
  // The scan has to have found the tree, or the assertions below are vacuously true.
  expect(all.length).toBeGreaterThan(50);

  const offenders: string[] = [];
  for (const { name, json } of all) {
    const scripts = json.scripts as Record<string, string> | undefined;
    if (!scripts) continue;
    // `prepare` is excluded on purpose: it does not run for a registry tarball dependency, only for a
    // git or link install. `prepublish` is author-side and never runs on install at all.
    for (const hook of ["preinstall", "install", "postinstall"])
      if (scripts[hook]) offenders.push(`${name} (${hook}: ${scripts[hook]})`);
  }
  // Every documented install path passes --ignore-scripts, so this is defence in depth rather than
  // the only guard. It is still worth pinning: playwright is the classic package whose browser
  // download arrives as a postinstall, and a future minor could reintroduce one. It has none today.
  expect(offenders).toEqual([]);
});

test.skipIf(!installed)("nothing in the tree is copyleft or unlicensed", () => {
  const all = manifests();
  expect(all.length).toBeGreaterThan(50);

  const problems: string[] = [];
  for (const { name, json } of all) {
    const raw = json.license ?? json.licenses;
    const text = typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw.map((entry) => (typeof entry === "object" && entry && "type" in entry ? String((entry as { type: unknown }).type) : String(entry))).join(" OR ")
        : typeof raw === "object" && raw && "type" in raw
          ? String((raw as { type: unknown }).type)
          : "";
    if (!text) {
      problems.push(`${name}: no license field`);
      continue;
    }
    // LGPL is included: this project ships a source archive, so a copyleft transitive dependency is a
    // real distribution obligation and not a theoretical one. Apache-2.0 is fine and its NOTICE
    // obligation is met by the NOTICE file at the repository root.
    if (/\b(A?GPL|LGPL)\b/i.test(text) || /^(UNLICENSED|UNKNOWN)$/i.test(text))
      problems.push(`${name}: ${text}`);
  }
  expect(problems).toEqual([]);
});

test.skipIf(!installed)("no native addon ships in the tree, so there is no ABI to match on Windows", () => {
  // A compiled .node addon has to match the host ABI and, on Windows, a Visual C++ runtime. The tree
  // has none, which is why a Windows install needs no toolchain and no rebuild step.
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || found.length > 0) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let directory = false;
      try {
        directory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (directory) walk(path, depth + 1);
      else if (entry.endsWith(".node")) found.push(path.slice(modules.length + 1));
      if (found.length > 0) return;
    }
  };
  walk(modules, 0);
  expect(found).toEqual([]);
});

test("the project never asks Playwright to download a browser", () => {
  // Playwright's bundled browsers are never used: Orbit finds the browser Windows already has
  // (src/runtime-paths.ts) and drives it over CDP with connectOverCDP. `playwright install` would pull
  // several hundred MB of browser binaries that nothing launches, so the absence of that command is
  // load-bearing and not an omission. This test exists so a future contributor does not add it as a
  // perceived fix for a skipped postinstall.
  const roots = ["src", "scripts", "bin", "docs"];
  const hits: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|js|mjs|cmd|sh|md)$/.test(entry)) continue;
      const text = readFileSync(path, "utf8");
      // The string as a command, not as prose about it: a doc line saying it must never be run is
      // fine, a line that actually invokes it is not.
      for (const pattern of [/playwright\s+install/i, /npx\s+playwright/i])
        if (pattern.test(text)) hits.push(`${path}: ${pattern.source}`);
    }
  };
  const root = join(import.meta.dir, "..");
  for (const dir of roots) walk(join(root, dir));
  // install.cmd and install.sh sit at the root rather than in a scanned directory.
  for (const file of ["install.cmd", "install.sh"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    if (/playwright\s+install/i.test(readFileSync(path, "utf8"))) hits.push(`${file}`);
  }
  expect(hits).toEqual([]);
});

test("every install path refuses to re-resolve the lockfile", () => {
  // Caret ranges in package.json carry no drift risk only because the lockfile is committed and every
  // install passes --frozen-lockfile, which fails rather than silently resolving a new version. If a
  // path loses the flag, the ranges start floating and a Windows build stops being reproducible.
  const root = join(import.meta.dir, "..");
  const unfrozen: string[] = [];
  for (const file of ["src/install.ts", "src/update.ts", "src/preflight.ts"]) {
    const text = readFileSync(join(root, file), "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      // Only lines that actually FORM an install command: an argv array containing "install", or a
      // literal `bun install` command string. A line merely mentioning the words, such as the failure
      // message `"bun install failed"`, is not an install path and must not be flagged.
      const argv = /["']install["']\s*,/.test(line);
      const literal = /bun install\s+--/.test(line);
      if (!argv && !literal) continue;
      if (!line.includes("--frozen-lockfile"))
        unfrozen.push(`${file}:${index + 1}: ${line.trim().slice(0, 90)}`);
    }
  }
  expect(unfrozen).toEqual([]);
});
