import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export type ArchitectureReport = { filesChecked: number; violations: string[] };

// These leaves must not pull orchestration or another feature into their dependency graph.
const leafDependencies: Record<string, readonly string[]> = {
  "src/runtime-command.ts": [],
  "src/errors.ts": [],
  "src/applications/types.ts": [],
  "src/applications/entries.ts": ["node:fs/promises", "node:path"],
  "src/applications/desktop-entry.ts": ["src/errors.ts"],
  "src/applications/executable.ts": ["node:fs/promises", "node:path", "src/errors.ts"],
  "src/applications/launch-policy.ts": ["node:path", "src/errors.ts"],
  "src/applications/registration.ts": ["node:fs/promises", "node:os", "node:path", "src/errors.ts", "src/applications/entries.ts", "src/applications/desktop-entry.ts"],
};

const portable = (path: string) => path.split(sep).join("/");

/** Check statically discoverable runtime imports, including re-exports and literal dynamic imports. */
export async function inspectArchitecture(root: string): Promise<ArchitectureReport> {
  const directory = resolve(root);
  const files = [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: directory })].sort();
  const sources = new Set(files.map(file => resolve(directory, file)));
  const graph = new Map<string, string[]>();
  const violations: string[] = [];
  const scanners = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };
  if (!files.length) violations.push("No production TypeScript source files found");
  for (const file of files) {
    const name = portable(file);
    const edges = new Set<string>();
    const scanner = file.endsWith(".tsx") ? scanners.tsx : scanners.ts;
    for (const dependency of scanner.scanImports(await Bun.file(resolve(directory, file)).text())) {
      const allowed = leafDependencies[name];
      if (!dependency.path.startsWith(".") && !isAbsolute(dependency.path)) {
        if (allowed && !allowed.includes(dependency.path)) violations.push(`${name}: leaf dependency is forbidden: ${dependency.path}`);
        continue;
      }
      const base = resolve(directory, dirname(file), dependency.path);
      // JSON data is not an executable module and has no runtime import edges.
      if (extname(base) === ".json") continue;
      const candidates = [base, base + ".ts", base + ".tsx", resolve(base, "index.ts"), resolve(base, "index.tsx")];
      if (/\.jsx?$/.test(base)) candidates.push(base.replace(/\.jsx?$/, ".ts"), base.replace(/\.jsx?$/, ".tsx"));
      const target = candidates.find(candidate => sources.has(candidate));
      if (!target) {
        violations.push(`${name}: runtime import cannot resolve to production source: ${dependency.path}`);
        continue;
      }
      const destination = portable(relative(directory, target));
      edges.add(destination);
      if (allowed && !allowed.includes(destination)) violations.push(`${name}: leaf dependency is forbidden: ${destination}`);
    }
    graph.set(name, [...edges].sort());
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  function visit(file: string) {
    if (active.has(file)) {
      violations.push(`Runtime dependency cycle: ${[...path.slice(path.indexOf(file)), file].join(" -> ")}`);
      return;
    }
    if (visited.has(file)) return;
    active.add(file); path.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    path.pop(); active.delete(file); visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return { filesChecked: files.length, violations };
}

if (import.meta.main) {
  const report = await inspectArchitecture(process.cwd());
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.violations.length ? 1 : 0;
}
