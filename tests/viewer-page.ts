import { rm } from "node:fs/promises";
import { Sessions } from "../src/session";
import type { BrowserBackend } from "../src/browser";
import { createWorkspaceDirectory } from "../src/workspace-storage";

/**
 * A page to look at the viewer with, inside a private Orbit session.
 *
 * Every viewer test needs the same six lines: a workspace, a `Sessions` of its own, one browser
 * session, the reach into its backend for the page Playwright can drive, and the teardown. They were
 * copied into each suite, which put the shape of a private field in three places and meant a viewer
 * test could not be written without knowing how a session is built. The collected page errors are
 * part of it, because a viewer test that does not assert them is not testing the viewer.
 */
export async function openViewerPage(taskName: string, options: { language?: string; viewport?: { width: number; height: number } } = {}) {
  const root = await createWorkspaceDirectory("viewer-qa");
  const viewing = new Sessions(root);
  const close = async () => {
    try { await viewing.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  };
  try {
    const session = await viewing.dispatch({ method: "session.create", params: { backend: "browser", agentName: "Codex", taskName } }) as { sessionId: string };
    const backend = (viewing as unknown as { sessions: Map<string, { backend: BrowserBackend }> }).sessions.get(session.sessionId)?.backend;
    const page = backend?.context.pages()[0];
    if (!page) throw new Error("Private Orbit page missing");
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    if (options.viewport) await page.setViewportSize(options.viewport);
    // The viewer follows the languages the browser asks for, so a test that wants one says so rather
    // than inheriting whatever the machine running it happens to be set to.
    if (options.language) await page.addInitScript(`Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify([options.language])}, configurable: true });`);
    return { page, errors, close };
  } catch (error) {
    await close();
    throw error;
  }
}
