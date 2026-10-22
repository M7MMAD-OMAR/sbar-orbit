import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectArchitecture } from "../scripts/check-architecture";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "orbit-architecture-"));
  temporary.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

test("production runtime dependencies are acyclic and respect module boundaries", async () => {
  const report = await inspectArchitecture(join(import.meta.dir, ".."));
  expect(report.filesChecked).toBeGreaterThan(0);
  expect(report.violations).toEqual([]);
});

test("runtime cycles include re-exports and literal dynamic imports", async () => {
  const root = await fixture({
    "src/a.ts": 'export { b } from "./nested";',
    "src/nested/index.ts": 'export const b = () => import("../a.js");',
  });
  expect((await inspectArchitecture(root)).violations).toEqual([
    "Runtime dependency cycle: src/a.ts -> src/nested/index.ts -> src/a.ts",
  ]);
});

test("shared dependencies and type-only cycles do not become runtime cycles", async () => {
  const root = await fixture({
    "src/a.ts": 'import { c } from "./c"; import type { B } from "./b"; export const a = c;',
    "src/b.ts": 'import { c } from "./c"; import type { A } from "./a"; export const b = c;',
    "src/c.ts": 'export const c = 1;',
  });
  expect((await inspectArchitecture(root)).violations).toEqual([]);
});

test("application leaves cannot depend on discovery orchestration", async () => {
  const root = await fixture({
    "src/applications/desktop-entry.ts": 'export { discoverApplications } from "../application-discovery";',
    "src/application-discovery.ts": 'export const discoverApplications = () => [];',
  });
  expect((await inspectArchitecture(root)).violations).toEqual([
    "src/applications/desktop-entry.ts: leaf dependency is forbidden: src/application-discovery.ts",
  ]);
});

test("production source cannot import tooling or unresolved relative modules", async () => {
  const root = await fixture({
    "src/a.ts": 'import "../tests/helper"; import "./missing";',
    "tests/helper.ts": 'export {};',
  });
  expect((await inspectArchitecture(root)).violations).toEqual([
    "src/a.ts: runtime import cannot resolve to production source: ../tests/helper",
    "src/a.ts: runtime import cannot resolve to production source: ./missing",
  ]);
});

test("an empty source tree does not silently pass", async () => {
  expect((await inspectArchitecture(await fixture({}))).violations).toEqual(["No production TypeScript source files found"]);
});

test("pure parsing leaves cannot gain filesystem or package side effects", async () => {
  const root = await fixture({
    "src/applications/desktop-entry.ts": 'import { readFile } from "node:fs/promises"; import "some-package"; export const parse = readFile;',
  });
  expect((await inspectArchitecture(root)).violations).toEqual([
    "src/applications/desktop-entry.ts: leaf dependency is forbidden: node:fs/promises",
    "src/applications/desktop-entry.ts: leaf dependency is forbidden: some-package",
  ]);
});
