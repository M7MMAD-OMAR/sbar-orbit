import type { BrowserContext, Page } from "playwright";

/** Observe trusted pointer events in an isolated world, without modifying page content. */
export async function observeBrowserPointer(context: BrowserContext, page: Page) {
  const channel = await context.newCDPSession(page);
  let mainFrame = "", executionContext: number | undefined;
  channel.on("Page.frameNavigated", ({ frame }) => {
    if (!frame.parentId) { mainFrame = frame.id; executionContext = undefined; }
  });
  channel.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.name === "sbar-orbit-pointer" && context.auxData?.frameId === mainFrame) executionContext = context.id;
  });
  channel.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
    if (executionContext === executionContextId) executionContext = undefined;
  });
  await channel.send("Page.enable");
  mainFrame = (await channel.send("Page.getFrameTree")).frameTree.frame.id;
  await channel.send("Runtime.enable");
  await channel.send("Page.addScriptToEvaluateOnNewDocument", {
    worldName: "sbar-orbit-pointer", runImmediately: true,
    source: `globalThis.orbitPointer = null;
      for (const name of ['pointermove', 'pointerdown']) addEventListener(name, event => {
        if (event.isTrusted) globalThis.orbitPointer = {x:event.clientX,y:event.clientY};
      }, true);`,
  });
  return async () => {
    if (executionContext === undefined) return null;
    try {
      const { result } = await channel.send("Runtime.evaluate", { contextId: executionContext, expression: "globalThis.orbitPointer", returnByValue: true });
      const value = result.value;
      return value && Number.isFinite(value.x) && Number.isFinite(value.y) && value.x >= 0 && value.x < 1280 && value.y >= 0 && value.y < 800
        ? { x: value.x as number, y: value.y as number } : null;
    } catch { return null; }
  };
}
