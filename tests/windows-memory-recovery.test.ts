import { expect, test } from "bun:test";
import { budgetHeadroom } from "../src/resource-budget";

test.skipIf(process.platform !== "win32")("Windows admission recovers memory after a bounded child exits", async () => {
  await budgetHeadroom();
  const child = Bun.spawn([process.execPath, "-e", `
    const held = new Uint8Array(256 * 1024 * 1024);
    held.fill(1);
    console.log("ready");
    setInterval(() => { if (held[0] !== 1) process.exit(1); }, 1000);
  `], { stdout: "pipe", stderr: "pipe" });
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = child.stdout.getReader();
    const ready = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { readyTimer = setTimeout(() => reject(new Error("Memory child did not become ready")), 10000); }),
    ]);
    clearTimeout(readyTimer);
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    reader.releaseLock();
    const occupied = await budgetHeadroom();
    child.kill();
    await child.exited;
    let recovered = await budgetHeadroom();
    const deadline = Date.now() + 5000;
    while (occupied.memory.usedBytes - recovered.memory.usedBytes < 128 * 1024 * 1024 && Date.now() < deadline) {
      await Bun.sleep(100);
      recovered = await budgetHeadroom();
    }
    expect(occupied.memory.usedBytes - recovered.memory.usedBytes).toBeGreaterThan(128 * 1024 * 1024);
    expect(recovered.memory.maxBytes).toBe(occupied.memory.maxBytes);
  } finally {
    clearTimeout(readyTimer);
    child.kill();
    await child.exited;
  }
}, 20000);
