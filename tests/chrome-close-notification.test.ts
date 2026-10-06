import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { retryableCleanup } from "../src/owned-cleanup";

async function fixture() {
  // Execute the production close closure with owned-only mocks, without launching a browser.
  const source = await readFile(new URL("../src/chrome.ts", import.meta.url), "utf8");
  const close = /  const close = retryableCleanup\(async \(\) => \{[\s\S]*?\n  \}\);/.exec(source)?.[0];
  const onClose = /      onClose\(listener: \(\) => void\) \{[^\n]+\},/.exec(source)?.[0];
  if (!close || !onClose) throw new Error("Production Chrome close contract was not found");
  let stopFails = false, removalFails = true, stops = 0, removals = 0;
  const owner = { async stop() { stops++; if (stopFails) throw new Error("stop unconfirmed"); } };
  const remove = async () => { removals++; if (removalFails) throw Object.assign(new Error("cleanup denied"), { code: "EACCES" }); };
  const api = new Function("retryableCleanup", "owner", "rm", "temporary", "browser", "socket",
    `let closed = false; const listeners = []; ${close} return { close, ${onClose.replace("listener: () => void", "listener")} };`)(
    retryableCleanup, owner, remove, "owned-temporary-fixture", undefined, undefined,
  ) as { close(): Promise<void>; onClose(listener: () => void): void };
  return { ...api, failStop() { stopFails = true; }, confirmStop() { stopFails = false; },
    allowRemoval() { removalFails = false; }, get stops() { return stops; }, get removals() { return removals; } };
}

test("Chrome cleanup retries notify each close listener once after temporary removal fails", async () => {
  const browser = await fixture();
  let notifications = 0;
  browser.onClose(() => { notifications++; });
  await expect(browser.close()).rejects.toMatchObject({ code: "EACCES" });
  expect(notifications).toBe(1);
  await expect(browser.close()).rejects.toMatchObject({ code: "EACCES" });
  browser.onClose(() => { notifications++; });
  expect(notifications).toBe(2);
  browser.allowRemoval();
  await browser.close();
  await browser.close();
  expect(notifications).toBe(2);
  expect(browser.removals).toBe(3);
});

test("Chrome close listeners wait for confirmed owner stop before cleanup retries", async () => {
  const browser = await fixture();
  let notifications = 0;
  browser.onClose(() => { notifications++; });
  browser.failStop();
  await expect(browser.close()).rejects.toThrow("stop unconfirmed");
  expect(notifications).toBe(0);
  expect(browser.removals).toBe(0);
  browser.confirmStop();
  browser.allowRemoval();
  await browser.close();
  expect(notifications).toBe(1);
  expect(browser.stops).toBe(2);
});
