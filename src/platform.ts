import { readFile } from "node:fs/promises";

export async function distributionName(): Promise<{ id: string; versionId: string }> {
  const release = await readFile("/etc/os-release", "utf8").catch(() => "");
  const field = (key: string) => (new RegExp(`^${key}="?([^"\n]*)"?$`, "m").exec(release)?.[1] ?? "").slice(0, 32);
  return { id: field("ID"), versionId: field("VERSION_ID") };
}
