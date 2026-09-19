import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createWorkspaceDirectory } from "../src/workspace-storage";

test("failed viewer setup removes its private workspace before rejecting", async () => {
  const root = await createWorkspaceDirectory("viewer-setup-test");
  try {
    const code = `
      import { readdir } from "node:fs/promises";
      import { openViewerPage } from ${JSON.stringify(new URL("./viewer-page.ts", import.meta.url).href)};
      import { workspaceRoot } from ${JSON.stringify(new URL("../src/workspace-storage.ts", import.meta.url).href)};
      let rejected = false;
      try { await openViewerPage("Setup failure cleanup", { viewport: { width: -1, height: 100 } }); }
      catch { rejected = true; }
      const remaining = (await readdir(workspaceRoot())).filter(name => name.startsWith("viewer-qa-"));
      console.log(JSON.stringify({ rejected, remaining: remaining.length }));
      process.exit(0);
    `;
    const child = Bun.spawn([process.execPath, "-e", code], {
      env: { ...process.env, XDG_CACHE_HOME: root, LOCALAPPDATA: root },
      stdout: "pipe", stderr: "pipe", timeout: 30000,
    });
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exit, err }).toEqual({ exit: 0, err: "" });
    expect(JSON.parse(out)).toEqual({ rejected: true, remaining: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 45000);
