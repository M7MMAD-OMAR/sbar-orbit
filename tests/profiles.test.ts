import { createWorkspaceDirectory } from "../src/workspace-storage";
import { test, expect } from "bun:test";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Sessions } from "../src/session";

test("saved account survives a fresh browser, has an exclusive lease and stays private", async () => {
  const root = await createWorkspaceDirectory("account-test");
  const accounts = join(root, "accounts");
  const aRoot = await mkdtemp(join(root, "broker-a-"));
  const bRoot = await mkdtemp(join(root, "broker-b-"));
  const a = new Sessions(aRoot, accounts), b = new Sessions(bRoot, accounts);
  const syntheticToken = crypto.randomUUID();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => {
    const url = new URL(req.url);
    if (url.pathname === "/login") return new Response("ok", { headers: { "Set-Cookie": `fixture=${syntheticToken}; HttpOnly; SameSite=Strict; Path=/` } });
    const authenticated = req.headers.get("cookie")?.includes(`fixture=${syntheticToken}`);
    return new Response(`<h1>${authenticated ? "Signed in" : "Signed out"}</h1><button onclick="fetch('/login').then(()=>{localStorage.setItem('fixture-theme','blue');document.querySelector('h1').textContent='Signed in'})">Connect fixture</button><output></output><script>document.querySelector('output').textContent=localStorage.getItem('fixture-theme')||'none'</script>`, { headers: { "Content-Type": "text/html" } });
  } });
  const run = (owner: Sessions, method: string, params: unknown = {}) => owner.dispatch({ method, params });
  const act = (owner: Sessions, session: object, action: unknown) => run(owner, "session.act", { ...session, requestId: crypto.randomUUID(), action });
  const nav = { type: "navigate", url: `http://127.0.0.1:${server.port}` };
  try {
    await expect(run(a, "session.create", { backend: "browser", accountName: "../outside" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const first = await run(a, "session.create", { backend: "browser", accountName: "fixture" }) as { sessionId: string };
    await expect(run(b, "session.create", { backend: "browser", accountName: "fixture" })).rejects.toMatchObject({ code: "PROFILE_BUSY" });
    await act(a, first, nav);
    expect(await act(a, first, { type: "read", selector: "h1" })).toEqual({ text: "Signed out" });
    await act(a, first, { type: "click", selector: "button" });
    for (let i = 0; i < 50; i++) {
      if ((await act(a, first, { type: "read", selector: "h1" }) as { text: string }).text === "Signed in") break;
      await Bun.sleep(20);
    }
    await expect(run(a, "session.account.save", first)).rejects.toMatchObject({ code: "NOT_PAUSED" });
    await run(a, "session.pause", first);
    expect(await run(a, "session.account.save", first)).toEqual({ saved: true, accountName: "fixture" });
    expect((await stat(join(accounts, "fixture", "state.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(accounts, "fixture"))).mode & 0o777).toBe(0o700);
    await a.close();
    const second = await run(b, "session.create", { backend: "browser", accountName: "fixture" }) as { sessionId: string };
    await act(b, second, nav);
    expect(await act(b, second, { type: "read", selector: "h1" })).toEqual({ text: "Signed in" });
    expect(await act(b, second, { type: "read", selector: "output" })).toEqual({ text: "blue" });
    const blank = await run(b, "session.create", { backend: "browser", accountName: "other" }) as { sessionId: string };
    await act(b, blank, nav);
    expect(await act(b, blank, { type: "read", selector: "h1" })).toEqual({ text: "Signed out" });
    const profileA = (await readdir(aRoot)).filter(v => v.startsWith("profile-"));
    const profileB = (await readdir(bRoot)).filter(v => v.startsWith("profile-"));
    expect(profileA.length).toBe(1); expect(profileB.length).toBe(2);
    expect(join(aRoot, profileA[0]!)).not.toBe(join(bRoot, profileB[0]!));
    await run(b, "session.stop", second);
    await writeFile(join(accounts, "fixture", "state.json"), "invalid fixture state", { mode: 0o600 });
    await expect(run(b, "session.create", { backend: "browser", accountName: "fixture" })).rejects.toMatchObject({ code: "ACCOUNT_STATE_INVALID" });
    // A restore failure must release the lock for the next attempt.
    await writeFile(join(accounts, "fixture", "state.json"), '{"cookies":[],"origins":[]}', { mode: 0o600 });
    expect(await run(b, "session.create", { backend: "browser", accountName: "fixture" })).toMatchObject({ state: "running" });
  } finally { await a.close(); await b.close(); server.stop(true); }
}, 30000);
