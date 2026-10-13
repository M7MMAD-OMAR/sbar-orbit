import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute, extname, dirname, sep } from "node:path";
import { createHash } from "node:crypto";
import { Module, createRequire, isBuiltin } from "node:module";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const commonjsWrapper = ["(function(exports,require,module,__filename,__dirname){return (function(exports,require,module,__filename,__dirname){", "\n}).call(this,exports,module[Symbol.for(\"orbit.performance.measured-require\")],module,__filename,__dirname);\n})"] as const;
const commonjsWrapperBytes = Buffer.from(JSON.stringify(commonjsWrapper), "utf8");
const commonjsWrapperProof = { wrapperSha256: sha(commonjsWrapperBytes), wrapperBytes: commonjsWrapperBytes.length };
export const sameIdentity = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export async function fileIdentity(path: string) {
  const canonical = await realpath(path), bytes = await readFile(canonical);
  return { path: canonical, sha256: sha(bytes), bytes: bytes.length };
}
function inside(root: string, path: string) {
  const held = relative(root, path);
  return held !== ".." && !held.startsWith(`..${sep}`) && !isAbsolute(held);
}
type MeasuredLoader = "js" | "jsx" | "ts" | "tsx" | "json";
function measuredLoader(path: string, supplied: unknown): MeasuredLoader {
  // Runtime onLoad in Bun 1.3.14 can omit the loader advertised by its typings.
  const extension = extname(path);
  let fallback: MeasuredLoader;
  switch (extension) {
    case ".cjs": case ".mjs": fallback = "js"; break;
    case ".js": case ".jsx": fallback = "jsx"; break;
    case ".ts": case ".mts": case ".cts": fallback = "ts"; break;
    case ".tsx": fallback = "tsx"; break;
    case ".json": fallback = "json"; break;
    default: throw new Error(`Unsupported measured module extension: ${extension}`);
  }
  if (supplied === undefined) return fallback;
  switch (supplied) {
    case "js": return "js";
    case "jsx": return "jsx";
    case "ts": return "ts";
    case "tsx": return "tsx";
    case "json": return "json";
    default: throw new Error(`Unsupported measured module loader: ${String(supplied)}`);
  }
}
async function dependencyTree(root: string) {
  const rows: Awaited<ReturnType<typeof fileIdentity>>[] = [], seen = new Set<string>();
  async function walk(path: string): Promise<void> {
    const canonical = await realpath(path);
    if (!inside(root, canonical)) throw new Error("Dependency resolution escaped the owned dependency tree");
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const info = await stat(canonical);
    if (info.isDirectory()) {
      for (const name of (await readdir(canonical)).sort()) await walk(join(canonical, name));
    } else if (info.isFile()) rows.push(await fileIdentity(canonical));
    else throw new Error("Unsupported dependency file type");
  }
  await walk(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

export async function sharedRuntimeSnapshot(browser: string) {
  const root = await realpath(resolve(import.meta.dir, ".."));
  const dependenciesRoot = await realpath(join(root, "node_modules"));
  if (!inside(root, dependenciesRoot)) throw new Error("Dependencies must be owned by this source checkout");
  return { bun: await fileIdentity(process.execPath), browser: await fileIdentity(browser),
    lock: await fileIdentity(join(root, "bun.lock")), package: await fileIdentity(join(root, "package.json")),
    dependencies: await dependencyTree(dependenciesRoot), source: await dependencyTree(join(root, "src")) };
}
export async function beginRuntimeIdentity(browser: string, shared: unknown) {
  const root = await realpath(resolve(import.meta.dir, ".."));
  const dependenciesRoot = await realpath(join(root, "node_modules"));
  const before = await sharedRuntimeSnapshot(browser);
  if (!sameIdentity(before, shared)) throw new Error("Worker differs from the shared paired runtime snapshot");
  const entry = await realpath(Bun.resolveSync("playwright", import.meta.dir));
  if (!inside(dependenciesRoot, entry)) throw new Error("Playwright did not resolve from owned locked dependencies");
  type LoadedRow = { path: string; sha256: string; bytes: number; loader: string;
    delivery: "bun-source-contents" | "commonjs-module-compile" | "commonjs-json-parse" | "commonjs-typescript-compile";
    argumentSha256: string; argumentBytes: number; completed: boolean;
    wrapperSha256?: string; wrapperBytes?: number; compilerFilename?: string;
    transform?: { tool: "Bun.Transpiler"; bun: Awaited<ReturnType<typeof fileIdentity>>;
      bunVersion: string; bunRevision: string; options: { loader: "ts"; target: "bun" };
      input: { path: string; sha256: string; bytes: number }; output: { sha256: string; bytes: number; contents: string } } };
  const loaded = new Map<string, LoadedRow>();
  const commonjs = new Map<string, Module>();
  const attempts: LoadedRow[] = [];
  const failures: string[] = [];
  // Capture and validate the base once. Track installed wrappers explicitly for
  // nested synchronous compilations because Bun's getter can return defaults.
  const baseWrapper: unknown = Reflect.get(Module, "wrapper");
  if (!Array.isArray(baseWrapper) || baseWrapper.length !== 2 ||
      baseWrapper[0] !== "(function(exports,require,module,__filename,__dirname){" || baseWrapper[1] !== "})") {
    throw new Error("Bun CommonJS base wrapper differs from the measured boundary");
  }
  let activeWrapper: readonly [string, string] = [baseWrapper[0], baseWrapper[1]];

  const producer = { experiment: await fileIdentity(join(root, "experiments/browser-performance.ts")),
    identity: await fileIdentity(import.meta.path), runner: await fileIdentity(join(root, "scripts/limited.ts")) };
  const pinned = new Map([...before.dependencies, ...before.source, ...Object.values(producer), before.package].map(row => [row.path, row]));
  function readPinned(requested: string, supplied: unknown) {
    const path = realpathSync(requested);
    if (!inside(root, path)) throw new Error("Loaded module escaped owned source");
    const loader = measuredLoader(requested, supplied);
    const bytes = readFileSync(path), expected = pinned.get(path);
    const sha256 = sha(bytes);
    if (!expected || expected.sha256 !== sha256 || expected.bytes !== bytes.length) throw new Error("Loaded module differs from its pinned source or dependency snapshot");
    const contents = bytes.toString("utf8");
    if (!Buffer.from(contents, "utf8").equals(bytes)) throw new Error("Measured module is not exact UTF8 content");
    const previous = loaded.get(path);
    if (previous && (previous.sha256 !== sha256 || previous.bytes !== bytes.length || previous.loader !== loader)) throw new Error("Loaded module changed");
    return { path, loader, bytes: bytes.length, sha256, contents };
  }
  function commonjsSource(file: ReturnType<typeof readPinned>) {
    const extension = extname(file.path);
    if (extension === ".cjs" || extension === ".cts") return true;
    if ([".mjs", ".mts", ".ts", ".tsx", ".json"].includes(extension)) return false;
    let directory = dirname(file.path);
    while (inside(root, directory)) {
      const packagePath = join(directory, "package.json");
      try {
        const packageFile = readPinned(packagePath, undefined);
        const packageValue: unknown = JSON.parse(packageFile.contents);
        if (packageValue !== null && typeof packageValue === "object" && "type" in packageValue) {
          const type: unknown = packageValue.type;
          if (type === "module") return false;
          if (type !== "commonjs") throw new Error("Unsupported measured package module type");
          return true;
        }
        // In an implicit/default package scope, use Bun's parser metadata for ESM syntax.
        // JSON keeps its authenticated JSON delivery path and never enters the JS parser.
        if (file.loader === "json") return false;
        const scan = new Bun.Transpiler({ loader: file.loader }).scan(file.contents);
        return scan.exports.length === 0 && !scan.imports.some(row => row.kind === "import-statement");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (directory === root) break;
      directory = dirname(directory);
    }
    throw new Error("Measured module has no owned package scope");
  }
  function evaluate(file: ReturnType<typeof readPinned>, parent?: Module): unknown {
    const nativeRequire = createRequire(file.path);
    const cached = nativeRequire.cache[file.path];
    const known = commonjs.get(file.path);
    if (cached) {
      if (cached !== known) {
        failures.push("CommonJS cache entry lacks its owned compilation record: " + file.path);
        if (!loaded.has(file.path)) throw new Error("CommonJS module was loaded before measured source admission");
      }
      return cached.exports;
    }
    // require.cache deletion intentionally invalidates our retained identity as well.
    commonjs.delete(file.path);
    const module = new Module(file.path, parent);
    module.filename = file.path;
    commonjs.set(file.path, module);
    nativeRequire.cache[file.path] = module;
    const row: LoadedRow = { path: file.path, sha256: file.sha256, bytes: file.bytes, loader: file.loader,
      delivery: file.loader === "json" ? "commonjs-json-parse" : "commonjs-module-compile",
      argumentSha256: file.sha256, argumentBytes: file.bytes, completed: false };
    loaded.set(file.path, row);
    attempts.push(row);
    const measuredResolve = Object.assign(function (...args: Parameters<typeof nativeRequire.resolve>): string {
      try {
        const target = nativeRequire.resolve(...args);
        const specifier = args[0];
        if (isBuiltin(specifier) || specifier === "bun" || specifier.startsWith("bun:")) return target;
        // Resolution alone has the same canonical owned-byte admission as execution.
        readPinned(target, undefined);
        return target;
      } catch (error) {
        failures.push("Measured resolve rejected: " + args[0] + ": " + String(error));
        throw error;
      }
    }, { paths: nativeRequire.resolve.paths });
    const measuredRequire = function (specifier: string): unknown {
      try {
      if (isBuiltin(specifier) || specifier === "bun" || specifier.startsWith("bun:")) return nativeRequire(specifier);
      const target = measuredResolve(specifier);
      const dependency = readPinned(target, undefined);
      if (dependency.loader === "json" || commonjsSource(dependency)) return evaluate(dependency, module);
      // The ESM dependency still passes through the authenticated real Bun onLoad callback.
      const value: unknown = nativeRequire(dependency.path);
      if (!loaded.has(dependency.path)) throw new Error("ESM dependency bypassed measured source delivery");
      return value;
      } catch (error) {
        failures.push("Measured require rejected: " + specifier + ": " + String(error));
        throw error;
      }
    };
    // Preserve the original require interface used by Bun's native CJS wrapper.
    Object.assign(measuredRequire, {
      resolve: measuredResolve,
      cache: nativeRequire.cache,
      main: nativeRequire.main,
      extensions: nativeRequire.extensions,
    });
    module.require = measuredRequire;
    try {
      if (file.loader === "json") module.exports = JSON.parse(file.contents);
      else {
        const compile: unknown = Reflect.get(module, "_compile");
        if (typeof compile !== "function") throw new Error("Bun CommonJS exact source compile is unavailable");
        // CTS requires Bun's typed transform before the native JS compiler.
        // Keep original source, transform output and compiler argument identities separate.
        let argument = file.contents;
        if (extname(file.path) === ".cts") {
          if (file.loader !== "ts") throw new Error("Measured CTS source requires the typed loader");
          argument = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(file.contents);
          const bytes = Buffer.from(argument, "utf8");
          row.delivery = "commonjs-typescript-compile";
          row.compilerFilename = file.path;
          row.argumentSha256 = sha(bytes);
          row.argumentBytes = bytes.length;
          row.transform = { tool: "Bun.Transpiler", bun: before.bun,
            bunVersion: Bun.version, bunRevision: Bun.revision, options: { loader: "ts", target: "bun" },
            input: { path: file.path, sha256: file.sha256, bytes: file.bytes },
            output: { sha256: row.argumentSha256, bytes: row.argumentBytes, contents: argument } };
        }
        // Plain CJS uses original bytes; typed CJS uses the separately bound output.
        // Bun resets module.require inside _compile. Its explicit wrapper hook supplies
        // the measured require to an inner native CJS wrapper, preserving directives.
        const requireKey = Symbol.for("orbit.performance.measured-require");
        Object.defineProperty(module, requireKey, { value: measuredRequire });
        const previousWrapper = activeWrapper;
        row.wrapperSha256 = commonjsWrapperProof.wrapperSha256;
        row.wrapperBytes = commonjsWrapperProof.wrapperBytes;
        if (!Reflect.set(Module, "wrapper", commonjsWrapper)) throw new Error("Bun CommonJS wrapper boundary cannot be installed");
        activeWrapper = commonjsWrapper;
        try {
          compile.call(module, argument, file.path);
        } finally {
          if (!Reflect.set(Module, "wrapper", previousWrapper)) {
            throw new Error("Bun CommonJS wrapper boundary cannot be restored");
          }
          activeWrapper = previousWrapper;
        }
      }
      module.loaded = true;
      row.completed = true;
      return module.exports;
    } catch (error) {
      failures.push("CommonJS evaluation failed: " + file.path + ": " + String(error));
      commonjs.delete(file.path);
      if (nativeRequire.cache[file.path] === module) delete nativeRequire.cache[file.path];
      throw error;
    }
  }
  function objectExports(value: unknown): Record<string, unknown> {
    const exports: Record<string, unknown> = {};
    const object = value !== null && (typeof value === "object" || typeof value === "function");
    // Bun exposes own function data properties such as length/name, and hides
    // the __esModule marker when it selects the annotated default boundary.
    const flagged = object && Reflect.get(value, "__esModule") === true;
    if (object) {
      for (const key of Object.getOwnPropertyNames(value)) {
        if (key === "default" || (flagged && key === "__esModule")) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        // Native Bun excludes nonenumerable accessor properties in this path.
        if (descriptor?.enumerable === false && !Object.hasOwn(descriptor, "value")) continue;
        let held: unknown;
        try { held = Reflect.get(value, key); } catch { held = undefined; }
        Object.defineProperty(exports, key, { enumerable: true, value: held });
      }
    }
    let defaultValue: unknown = value;
    if (flagged && object && Object.hasOwn(value, "default")) defaultValue = Reflect.get(value, "default");
    Object.defineProperty(exports, "default", { enumerable: true, value: defaultValue });
    return exports;
  }
  await Bun.plugin({ name: "orbit-performance-loaded-byte-identity", setup(build) {
    build.onResolve({ filter: /.*/, namespace: "file" }, args => {
      if (!isAbsolute(args.path)) return undefined;
      try {
        const path = realpathSync(args.path);
        if (!inside(root, path)) throw new Error("Loaded module escaped owned source");
        // Keep Bun's native resolution for authenticated owned absolute paths.
        return undefined;
      } catch (error) {
        failures.push("Measured resolve rejected: " + args.path + ": " + String(error));
        throw error;
      }
    });
    build.onLoad({ filter: /.*/, namespace: "file" }, args => {
      try {
      const file = readPinned(args.path, args.loader);
      if (file.loader === "json" || commonjsSource(file)) return { exports: objectExports(evaluate(file)), loader: "object" };
      const row: LoadedRow = { path: file.path, sha256: file.sha256, bytes: file.bytes, loader: file.loader,
        delivery: "bun-source-contents", argumentSha256: file.sha256, argumentBytes: file.bytes, completed: true };
      loaded.set(file.path, row);
      attempts.push(row);
      return { contents: file.contents, loader: file.loader };
      } catch (error) {
        failures.push("Measured onLoad rejected: " + args.path + ": " + String(error));
        throw error;
      }
    });
  } });
  return { async finish() {
    try {
      const after = await sharedRuntimeSnapshot(browser);
      const loadedRows = [...loaded.values()].sort((a, b) => a.path.localeCompare(b.path));
      const loadedAfter = await Promise.all(loadedRows.map(row => fileIdentity(row.path)));
      const loadedStable = failures.length === 0 && attempts.every(attempt => attempt.completed) && loadedRows.every((row, index) => {
        const held = loadedAfter[index];
        return held?.path === row.path && held.sha256 === row.sha256 && held.bytes === row.bytes && row.completed && (row.delivery === "commonjs-typescript-compile"
          ? typedCompileProofValid(row, before.bun, Bun.version, Bun.revision)
          : row.argumentSha256 === row.sha256 && row.argumentBytes === row.bytes);
      });
      const producerAfter = { experiment: await fileIdentity(join(root, "experiments/browser-performance.ts")),
        identity: await fileIdentity(import.meta.path), runner: await fileIdentity(join(root, "scripts/limited.ts")) };
      return { schema: 2, workerPid: process.pid, bunVersion: Bun.version, bunRevision: Bun.revision,
        entry, before, after, loaded: loadedRows, loadedAfter, loadedStable, attempts, failures,
        producer, producerAfter, stable: sameIdentity(before, after) && sameIdentity(producer, producerAfter) && loadedStable,
        entryLoaded: loaded.has(entry) };
    } finally { /* The private worker exits after writing its receipt; plugin scope is process lifetime. */ }
  } };
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function typedCompileProofValid(row: Record<string, unknown>, bunValue: unknown, version: unknown, revision: unknown): boolean {
  const transform = record(row.transform), input = record(transform.input), output = record(transform.output), options = record(transform.options), bun = record(bunValue);
  if (row.delivery !== "commonjs-typescript-compile" || row.loader !== "ts" || typeof row.path !== "string" || !row.path.endsWith(".cts") ||
      row.compilerFilename !== row.path || row.wrapperSha256 !== commonjsWrapperProof.wrapperSha256 || row.wrapperBytes !== commonjsWrapperProof.wrapperBytes ||
      typeof bun.path !== "string" || !bun.path || typeof bun.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(bun.sha256) || !Number.isSafeInteger(bun.bytes) || Number(bun.bytes) <= 0 ||
      typeof version !== "string" || !version || typeof revision !== "string" || !revision ||
      transform.tool !== "Bun.Transpiler" || !sameIdentity(transform.bun, bunValue) || transform.bunVersion !== version || transform.bunRevision !== revision ||
      options.loader !== "ts" || options.target !== "bun" || Object.keys(options).length !== 2 ||
      input.path !== row.path || input.sha256 !== row.sha256 || input.bytes !== row.bytes || typeof output.contents !== "string") return false;
  const bytes = Buffer.from(output.contents, "utf8");
  return sha(bytes) === output.sha256 && bytes.length === output.bytes &&
    row.argumentSha256 === output.sha256 && row.argumentBytes === output.bytes;
}

export function runtimeAdmission(runtimeValue: unknown, treeValue: unknown, binariesValue: unknown, sharedValue: unknown) {
  const runtime = record(runtimeValue), tree = record(treeValue), binaries = record(binariesValue);
  const before = record(runtime.before), after = record(runtime.after);
  const python = record(tree.pythonBefore), witness = record(record(tree.browserIdentity).witness);
  const shared = record(sharedValue), loaded = runtime.loaded, loadedAfter = runtime.loadedAfter;
  if (runtime.schema !== 2 || !Array.isArray(runtime.failures) || runtime.failures.length !== 0 || !Array.isArray(runtime.attempts) || runtime.attempts.length === 0) return false;
  if (!Array.isArray(shared.dependencies) || !Array.isArray(shared.source) || !Array.isArray(loaded) || !Array.isArray(loadedAfter) || loaded.length !== loadedAfter.length) return false;
  const pinned = new Map([...shared.dependencies, ...shared.source, ...Object.values(record(binaries.producer)), shared.package].map(value => {
    const row = record(value); return [row.path, row] as const;
  }));
  function deliveryValid(row: Record<string, unknown>) {
    if (typeof row.loader !== "string" || !["js", "jsx", "ts", "tsx", "json"].includes(row.loader) || row.completed !== true) return false;
    const wrapperValid = row.wrapperSha256 === commonjsWrapperProof.wrapperSha256 && row.wrapperBytes === commonjsWrapperProof.wrapperBytes;
    if (row.delivery === "commonjs-typescript-compile") {
      return typedCompileProofValid(row, before.bun, runtime.bunVersion, runtime.bunRevision);
    }
    if (row.argumentSha256 !== row.sha256 || row.argumentBytes !== row.bytes) return false;
    if (row.delivery === "bun-source-contents") return true;
    if (row.delivery === "commonjs-module-compile") return ["js", "jsx", "ts"].includes(row.loader) && wrapperValid;
    return row.delivery === "commonjs-json-parse" && row.loader === "json";
  }
  const lastAttempt = new Map<unknown, Record<string, unknown>>();
  for (const value of runtime.attempts) {
    const row = record(value), expected = pinned.get(row.path);
    if (typeof row.path !== "string" || !expected || expected.sha256 !== row.sha256 || expected.bytes !== row.bytes || !deliveryValid(row)) return false;
    lastAttempt.set(row.path, row);
  }
  const seen = new Set<unknown>();
  for (let index = 0; index < loaded.length; index++) {
    const row = record(loaded[index]), afterRow = record(loadedAfter[index]), expected = pinned.get(row.path);
    if (typeof row.path !== "string" || seen.has(row.path) || !expected || expected.sha256 !== row.sha256 || expected.bytes !== row.bytes ||
        afterRow.path !== row.path || afterRow.sha256 !== row.sha256 || afterRow.bytes !== row.bytes || !deliveryValid(row) ||
        !sameIdentity(lastAttempt.get(row.path), row)) return false;
    seen.add(row.path);
  }
  if (lastAttempt.size !== seen.size) return false;
  if (!seen.has(runtime.entry)) return false;
  return sameIdentity(before, shared) && sameIdentity(after, shared) && runtime.stable === true && runtime.entryLoaded === true && runtime.loadedStable === true &&
    Array.isArray(runtime.loaded) && runtime.loaded.length > 0 && runtime.workerPid === tree.worker && witness.workerPid === tree.worker &&
    typeof runtime.bunVersion === "string" && runtime.bunVersion.length > 0 && typeof witness.browserVersion === "string" && witness.browserVersion.length > 0 &&
    sameIdentity(before, after) && sameIdentity(runtime.producer, runtime.producerAfter) &&
    sameIdentity(runtime.producer, binaries.producer) && sameIdentity(before.bun, binaries.bun) && sameIdentity(before.browser, binaries.browser) &&
    sameIdentity(tree.pythonBefore, tree.pythonAfter) && python.executable === record(binaries.python).path &&
    python.sha256 === record(binaries.python).sha256 && Object.keys(record(python.loadedModules)).length > 0 && typeof python.version === "string" &&
    tree.cleanup === "wait returned ECHILD" && tree.sampleFailures === 0 && tree.timedOut === false && tree.exitCode === 0;
}
