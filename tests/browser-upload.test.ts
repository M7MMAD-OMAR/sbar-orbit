import { test, expect } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, startBroker } from "../src/ipc";
import { classify } from "../src/policy";

// A page with the two shapes real upload pages use: a plain file input, and a styled button that opens
// the chooser of a hidden one. Whatever the page receives is read back into #got.
const page = `<!doctype html><title>Upload</title>
<input id="plain" type="file" multiple>
<input id="hidden" type="file" style="display:none">
<button id="pick" onclick="document.getElementById('hidden').click()">Select files</button>
<button id="nothing">Does nothing</button>
<pre id="got"></pre>
<script>
for (const input of document.querySelectorAll("input[type=file]")) input.addEventListener("change", async () => {
  const parts = [];
  for (const file of input.files) parts.push(input.id + ":" + file.name + ":" + (await file.text()));
  document.getElementById("got").textContent = parts.join("|");
});
</script>`;

test("upload is irreversible, so a default session refuses it", async () => {
  expect(classify("upload")).toBe("irreversible");
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(page, { headers: { "Content-Type": "text/html" } }) });
  const dir = await mkdtemp(join(tmpdir(), "orbit-upload-"));
  const broker = await startBroker();
  try {
    const file = join(dir, "note.txt"); await writeFile(file, "secret");
    const session = await call(broker.socket, "session.create", { backend: "browser" }) as { sessionId: string };
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/` });
    await expect(act({ type: "upload", selector: "#plain", files: [file] })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(await act({ type: "read", selector: "#got" })).toEqual({ text: "" });
  } finally { await broker.close(); fixture.stop(true); await rm(dir, { recursive: true, force: true }); }
}, 30000);

test("a session allowed irreversible actions hands files to an input or to the chooser a button opens", async () => {
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(page, { headers: { "Content-Type": "text/html" } }) });
  const dir = await mkdtemp(join(tmpdir(), "orbit-upload-"));
  const broker = await startBroker();
  try {
    const a = join(dir, "a.txt"), b = join(dir, "b.txt"), link = join(dir, "link.txt");
    await writeFile(a, "alpha"); await writeFile(b, "beta"); await symlink(a, link);
    const session = await call(broker.socket, "session.create", { backend: "browser", policy: { origins: "any", allow: ["read", "navigate", "write", "irreversible"], deny: [] } }) as { sessionId: string };
    const act = (action: unknown) => call(broker.socket, "session.act", { ...session, requestId: crypto.randomUUID(), action });
    const got = async () => { for (let i = 0; i < 60; i++) { const r = await act({ type: "read", selector: "#got" }) as { text: string }; if (r.text) return r.text; await Bun.sleep(25); } return ""; };
    await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/` });

    expect(await act({ type: "upload", selector: "#plain", files: [a, b] })).toEqual({ applied: true, via: "input", files: [{ name: "a.txt", bytes: 5 }, { name: "b.txt", bytes: 4 }] });
    expect(await got()).toBe("plain:a.txt:alpha|plain:b.txt:beta");

    // The page is reloaded so #got starts empty; the styled button path resolves the symlink it was given.
    await act({ type: "navigate", url: `http://127.0.0.1:${fixture.port}/again` });
    expect(await act({ type: "upload", selector: "#pick", files: [link] })).toEqual({ applied: true, via: "chooser", files: [{ name: "a.txt", bytes: 5 }] });
    expect(await got()).toBe("hidden:a.txt:alpha");

    // Refused before the page sees anything: a relative path, a missing file, a directory.
    await expect(act({ type: "upload", selector: "#plain", files: ["a.txt"] })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(act({ type: "upload", selector: "#plain", files: [join(dir, "missing.txt")] })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(act({ type: "upload", selector: "#plain", files: [dir] })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // A click that opens no chooser is a failure, not a delivered upload.
    await expect(act({ type: "upload", selector: "#nothing", files: [a] })).rejects.toBeDefined();
  } finally { await broker.close(); fixture.stop(true); await rm(dir, { recursive: true, force: true }); }
}, 40000);
