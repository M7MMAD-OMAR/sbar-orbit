import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEPENDENCY_INVENTORY, MAX_DEPENDENCY_FILE_BYTES, parseWindowsDependencies, validateWindowsDependencies, writeWindowsDependencyInventory, mergeWindowsDependencies } from "../src/windows-dependencies";
const roots: string[] = [], hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
async function root() { const directory = await realpath(await mkdtemp(join(tmpdir(), "orbit-dependencies-"))); roots.push(directory); return directory; }
afterEach(async () => { for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function put(root: string, path: string, text: string) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text); }
async function fixture() {
  const directory = await root(); await put(directory, "node_modules/@modelcontextprotocol/sdk/index.js", "owned synthetic SDK fixture\n"); await put(directory, "node_modules/@modelcontextprotocol/sdk/package.json", "{}");
  const inventory = await writeWindowsDependencyInventory(directory); return { directory, ...inventory };
}
test("shared TAB LF vector is canonical and generated from exact owned bytes", async () => {
  const f = await fixture(), vector = await readFile(new URL("./fixtures/windows-dependencies-v1.tsv", import.meta.url), "utf8");
  expect(f.text).toBe(vector); expect(parseWindowsDependencies(vector)).toEqual(f.entries); expect(await validateWindowsDependencies(f.directory, f.sha256)).toEqual(f.entries);
});
for (const [label, alter] of [
  ["BOM", (text: string) => "\ufeff" + text], ["CRLF", (text: string) => text.replace(/\n/g, "\r\n")],
  ["spaces instead of TAB", (text: string) => text.replace(/\t/g, "  ")], ["missing LF", (text: string) => text.slice(0, -1)],
  ["empty line", (text: string) => text + "\n"], ["reverse order", (text: string) => text.trimEnd().split("\n").reverse().join("\n") + "\n"],
  ["traversal", (text: string) => text.replace("node_modules/", "node_modules/../")], ["backslash", (text: string) => text.replace("node_modules/", "node_modules\\")],
  ["wrong prefix", (text: string) => text.replace(/node_modules/g, "src")], ["duplicate", (text: string) => text + text],
  ["uppercase hash", (text: string) => text.slice(0, 64).toUpperCase() + text.slice(64)],
] as [string, (text: string) => string][]) test("inventory refuses " + label, async () => { const f = await fixture(); expect(() => parseWindowsDependencies(alter(f.text))).toThrow(); });
test("casefold aliases, file-parent conflicts and oversized metadata are rejected", async () => {
  const f = await fixture(), row = (path: string) => "a".repeat(64) + "\t" + path + "\n";
  for (const text of [row("node_modules/A/a") + row("node_modules/a/b") + f.text, row("node_modules/A") + row("node_modules/A/a") + f.text,
    f.text + " ".repeat(2 * 1024 * 1024), row("node_modules/@modelcontextprotocol/sdk/package.json") + Array.from({ length: 8192 }, (_, index) => row("node_modules/z/" + String(index).padStart(5, "0"))).join("")])
    expect(() => parseWindowsDependencies(text)).toThrow();
});
for (const mutation of ["changed", "missing", "extra", "empty-directory", "large", "inventory"] as const) test("exact dependency verification refuses " + mutation, async () => {
  const f = await fixture(), target = join(f.directory, "node_modules/@modelcontextprotocol/sdk/index.js");
  if (mutation === "changed") await writeFile(target, "changed executable dependency");
  if (mutation === "missing") await rm(target);
  if (mutation === "extra") await put(f.directory, "node_modules/extra.js", "unexpected");
  if (mutation === "empty-directory") await mkdir(join(f.directory, "node_modules/unknown-empty"));
  if (mutation === "large") await truncate(target, MAX_DEPENDENCY_FILE_BYTES + 1);
  if (mutation === "inventory") await writeFile(join(f.directory, DEPENDENCY_INVENTORY), f.text.replace(/a/, "b"));
  await expect(validateWindowsDependencies(f.directory, f.sha256)).rejects.toThrow();
});
test("directory redirection cannot supply dependency code", async () => {
  const f = await fixture(), elsewhere = await root(); await rm(join(f.directory, "node_modules/@modelcontextprotocol/sdk"), { recursive: true });
  await put(elsewhere, "package.json", "{}"); await put(elsewhere, "index.js", "owned synthetic SDK fixture\n");
  await symlink(elsewhere, join(f.directory, "node_modules/@modelcontextprotocol/sdk"), process.platform === "win32" ? "junction" : "dir");
  await expect(validateWindowsDependencies(f.directory, f.sha256)).rejects.toThrow();
});
test("inventory hash binds the full second index, never an unsealed caller list", async () => {
  const f = await fixture(); await expect(validateWindowsDependencies(f.directory, "0".repeat(64))).rejects.toThrow();
  const text = f.text.replace(hash("owned synthetic SDK fixture\n"), hash("changed")); await writeFile(join(f.directory, DEPENDENCY_INVENTORY), text);
  await expect(validateWindowsDependencies(f.directory, f.sha256)).rejects.toThrow();
});
test("dependency merge is exclusive and rechecks copied bytes", async () => {
  const f = await fixture(), destination = await root(); await put(destination, DEPENDENCY_INVENTORY, f.text);
  await mergeWindowsDependencies(f.directory, destination, f.sha256); expect(await validateWindowsDependencies(destination, f.sha256)).toEqual(f.entries);
  await writeFile(join(destination, "node_modules/@modelcontextprotocol/sdk/index.js"), "owner changed");
  await expect(mergeWindowsDependencies(f.directory, destination, f.sha256)).rejects.toThrow(); expect(await readFile(join(destination, "node_modules/@modelcontextprotocol/sdk/index.js"), "utf8")).toBe("owner changed");
});
test("producer never overwrites an existing inventory or normalizes unknown empty directories", async () => {
  const f = await fixture(); await expect(writeWindowsDependencyInventory(f.directory)).rejects.toThrow(); expect(await readFile(join(f.directory, DEPENDENCY_INVENTORY), "utf8")).toBe(f.text);
  const directory = await root(); await mkdir(join(directory, "node_modules/unknown-empty"), { recursive: true }); await expect(writeWindowsDependencyInventory(directory)).rejects.toThrow();
});
test("scoped npm names remain ordinary bounded paths, never traversal or arbitrary @ locations", async () => {
  const f = await fixture(); expect(await validateWindowsDependencies(f.directory, f.sha256)).toEqual(f.entries);
  for (const bad of ["node_modules/@../sdk/index.js", "node_modules/@scope./sdk/index.js", "node_modules/@scope/sdk/../index.js", "node_modules/a/@scope/index.js", "desktop/@scope/file.js"])
    expect(() => parseWindowsDependencies("a".repeat(64) + "\t" + bad + "\n" + f.text)).toThrow();
});
