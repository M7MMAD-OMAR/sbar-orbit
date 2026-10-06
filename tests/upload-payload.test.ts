import { expect, test } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUploadBytes, readUploadPayloads } from "../src/upload-payload";

test("selected upload bytes share a budget and accept its exact boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-upload-payload-"));
  try {
    const a = join(root, "a.txt"), b = join(root, "b.txt");
    await writeFile(a, "alpha"); await writeFile(b, "beta");
    const files = [{ path: a, bytes: 5 }, { path: b, bytes: 4 }];
    const payloads = await readUploadPayloads(files, 9);
    expect(payloads.map(file => [file.name, file.buffer.toString()])).toEqual([["a.txt", "alpha"], ["b.txt", "beta"]]);
    await expect(readUploadPayloads(files, 8)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a selected file growing after path validation cannot bypass the byte budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-upload-payload-"));
  try {
    const path = join(root, "growing.txt");
    await writeFile(path, "a");
    const selected = [{ path, bytes: 1 }];
    await writeFile(path, "a much larger file");
    await expect(readUploadPayloads(selected, 4)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("growth after a descriptor read is refused without reading past the overflow byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-upload-payload-"));
  const path = join(root, "append.txt");
  await writeFile(path, "alpha");
  const handle = await open(path, "r");
  try {
    let reads = 0;
    const requested: number[] = [];
    const reader = { async read(buffer: Buffer, offset: number, length: number, position: null) {
      requested.push(length);
      const result = await handle.read(buffer, offset, length, position);
      if (++reads === 1) await writeFile(path, " appended data", { flag: "a" });
      return result;
    } };
    await expect(readUploadBytes(reader, 5)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(requested).toEqual([6, 1]);
    expect(reads).toBe(2);
  } finally { await handle.close(); await rm(root, { recursive: true, force: true }); }
});

test("an empty selected file and a replaced non-file have explicit outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbit-upload-payload-"));
  try {
    const path = join(root, "empty.txt");
    await writeFile(path, "");
    expect((await readUploadPayloads([{ path, bytes: 0 }], 0)).map(file => file.buffer.length)).toEqual([0]);
    await expect(readUploadPayloads([{ path: root, bytes: 0 }], 4)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
