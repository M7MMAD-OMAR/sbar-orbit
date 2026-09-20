import { test, expect } from "bun:test";
import { Sessions } from "../src/session";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("an update lease blocks new sessions until its owner releases it", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-update-admission-"));
  const sessions = new Sessions(root);
  try {
    const lease = await sessions.dispatch({ method: "update.begin" }) as { token: string };
    expect(lease.token).toBeString();
    await expect(sessions.create({ backend: "unsupported" })).rejects.toThrow("update");
    await expect(sessions.dispatch({ method: "update.begin" })).rejects.toThrow("update");
    await sessions.dispatch({ method: "update.end", params: { token: "wrong" } });
    await expect(sessions.create({ backend: "unsupported" })).rejects.toThrow("update");
    await sessions.dispatch({ method: "update.end", params: { token: lease.token } });
    await expect(sessions.create({ backend: "unsupported" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
