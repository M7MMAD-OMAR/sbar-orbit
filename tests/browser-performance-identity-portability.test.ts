import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import * as ts from "@typescript/typescript6";

// Compile the actual helper and callback, injecting Windows path semantics.
// This proves source-bound admission behavior, not Windows Bun execution.
const source = ts.createSourceFile("browser-performance-identity.ts",
  readFileSync(new URL("../experiments/browser-performance-identity.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const helper = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "inside");
if (!helper) throw new Error("Actual producer inside helper missing");
let resolveCall: ts.CallExpression | undefined;
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.expression.getText(source) === "build" && node.expression.name.text === "onResolve") {
    if (resolveCall) throw new Error("Ambiguous actual producer onResolve callback");
    resolveCall = node;
  }
  ts.forEachChild(node, visit);
}
visit(source);
const options = resolveCall?.arguments[0], callback = resolveCall?.arguments[1];
if (!options || !ts.isObjectLiteralExpression(options) || !callback || !ts.isArrowFunction(callback))
  throw new Error("Actual producer resolver shape missing");
const filterProperty = options.properties.find((node): node is ts.PropertyAssignment =>
  ts.isPropertyAssignment(node) && node.name.getText(source) === "filter");
const namespaceProperty = options.properties.find((node): node is ts.PropertyAssignment =>
  ts.isPropertyAssignment(node) && node.name.getText(source) === "namespace");
if (!filterProperty || !namespaceProperty) throw new Error("Actual producer resolver options missing");
const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
const inside = new Function("relative", "isAbsolute", "sep",
  transpiler.transformSync(helper.getText(source)) + "\nreturn inside;")(
    win32.relative, win32.isAbsolute, win32.sep) as (root: string, path: string) => boolean;
const filter = new Function("return " + filterProperty.initializer.getText(source))() as RegExp;
const namespace = new Function("return " + namespaceProperty.initializer.getText(source))() as string;
const makeResolver = new Function("realpathSync", "inside", "root", "failures", "isAbsolute",
  transpiler.transformSync("function sourceResolverFactory(){ return (" + callback.getText(source) + "); }") +
  "\nreturn sourceResolverFactory();") as (
    realpath: (path: string) => string, containment: typeof inside, root: string,
    failures: string[], absolute: typeof win32.isAbsolute
  ) => (args: { path: string }) => undefined;

const containment: Array<[string, string, string, boolean]> = [
  ["root itself", "C:\\owned", "C:\\owned", true],
  ["child", "C:\\owned", "C:\\owned\\module.js", true],
  ["nested child", "C:\\owned", "C:\\owned\\nested\\module.js", true],
  ["forward slash child", "C:\\owned", "C:/owned/nested/module.js", true],
  ["sibling", "C:\\owned", "C:\\outside\\module.js", false],
  ["prefix lookalike", "C:\\owned", "C:\\owned-copy\\module.js", false],
  ["parent itself", "C:\\owned", "C:\\", false],
  ["normalized parent escape", "C:\\owned", "C:\\owned\\..\\outside\\module.js", false],
  ["different drive", "C:\\owned", "D:\\owned\\module.js", false],
  ["UNC child", "\\\\server\\share\\owned", "\\\\server\\share\\owned\\module.js", true],
  ["UNC root itself", "\\\\server\\share\\owned", "\\\\server\\share\\owned", true],
  ["UNC sibling", "\\\\server\\share\\owned", "\\\\server\\share\\outside\\module.js", false],
  ["UNC prefix lookalike", "\\\\server\\share\\owned", "\\\\server\\share\\owned-copy\\module.js", false],
  ["UNC parent", "\\\\server\\share\\owned", "\\\\server\\share", false],
  ["UNC different share", "\\\\server\\share\\owned", "\\\\server\\other\\owned\\module.js", false],
  ["UNC different server", "\\\\server\\share\\owned", "\\\\other\\share\\owned\\module.js", false],
];
for (const [name, root, path, admitted] of containment)
  test(`actual producer Windows containment: ${name}`, () => {
    expect(inside(root, path)).toBe(admitted);
  });

const relativeImports = ["playwright", "./module.js", "../module.js", "node:fs", "C:module.js"];
for (const path of relativeImports) test(`actual resolver preserves native relative selection: ${path}`, () => {
  let reads = 0;
  const failures: string[] = [];
  const resolver = makeResolver(() => { reads++; throw new Error("Relative import reached canonical resolver"); },
    inside, "C:\\owned", failures, win32.isAbsolute);
  expect(namespace).toBe("file");
  // Model the real filter-to-callback pipeline for file imports.
  expect(filter.test(path) ? resolver({ path }) : undefined).toBeUndefined();
  expect(reads).toBe(0);
  expect(failures).toEqual([]);
});

const absoluteImports: Array<[string, string]> = [
  ["C:\\owned\\module.js", "C:\\owned"],
  ["C:/owned/module.js", "C:\\owned"],
  ["\\\\server\\share\\owned\\module.js", "\\\\server\\share\\owned"],
];
for (const [path, root] of absoluteImports) test(`actual resolver selects owned Windows absolute: ${path}`, () => {
  const reads: string[] = [], failures: string[] = [];
  const resolver = makeResolver(value => { reads.push(value); return value; }, inside, root, failures, win32.isAbsolute);
  expect(filter.test(path)).toBe(true);
  expect(resolver({ path })).toBeUndefined();
  expect(reads).toEqual([path]);
  expect(failures).toEqual([]);
});

for (const [name, root, outside, admitted] of containment.filter(row => !row[3]))
  test(`actual resolver rejects canonical Windows escape with sticky failure: ${name}`, () => {
    const failures: string[] = [], reads: string[] = [];
    const alias = win32.join(root, "alias.js");
    const resolver = makeResolver(path => { reads.push(path); return outside; }, inside, root, failures, win32.isAbsolute);
    expect(admitted).toBe(false);
    expect(filter.test(alias)).toBe(true);
    expect(() => resolver({ path: alias })).toThrow("Loaded module escaped owned source");
    expect(reads).toEqual([alias]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("Measured resolve rejected: " + alias);
    expect(filter.test("playwright") ? resolver({ path: "playwright" }) : undefined).toBeUndefined();
    expect(failures).toHaveLength(1);
  });

test("actual resolver retains a canonical lookup failure as sticky evidence", () => {
  const failures: string[] = [];
  const path = "C:\\owned\\missing.js";
  const resolver = makeResolver(() => { throw new Error("fixture realpath failure"); },
    inside, "C:\\owned", failures, win32.isAbsolute);
  expect(filter.test(path)).toBe(true);
  expect(() => resolver({ path })).toThrow("fixture realpath failure");
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("fixture realpath failure");
});
