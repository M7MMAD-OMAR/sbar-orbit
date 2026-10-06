import { AccountLease } from "../src/profiles";
import { BrowserBackend } from "../src/browser";
import { Diagnostics } from "../src/diagnostics";
import { chromium } from "playwright";
const started = performance.now();
let next = 0;
const phase = (name: string, call: number, outcome: string) => console.error(JSON.stringify({ profileBoundary: name, call, outcome, elapsedMs: Math.round(performance.now() - started) }));
function observe(target: object, key: string, label: string) {
  const methods = target as Record<string, unknown>;
  const original = methods[key];
  if (typeof original !== "function") throw new Error(`Missing boundary ${label}`);
  methods[key] = function (this: unknown, ...args: unknown[]) {
    const call = ++next;
    phase(label, call, "start");
    try {
      const result = Reflect.apply(original, this, args);
      const then = result && (typeof result === "object" || typeof result === "function")
        ? (result as { then?: unknown }).then : undefined;
      if (typeof then === "function")
        void Reflect.apply(then, result, [() => phase(label, call, "done"), () => phase(label, call, "failed")]);
      else phase(label, call, "done");
      return result;
    } catch (error) { phase(label, call, "failed"); throw error; }
  };
}
observe(AccountLease, "acquire", "account.acquire");
for (const method of ["restore", "save", "release"]) observe(AccountLease.prototype, method, `account.${method}`);
observe(BrowserBackend, "create", "browser.create");
observe(BrowserBackend.prototype, "close", "browser.close");
observe(chromium, "connectOverCDP", "browser.cdp");
observe(Diagnostics.prototype, "record", "diagnostics.record");
process.on("exit", () => phase("probe.exit", ++next, "done"));
