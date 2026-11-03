import { isPublicSourcePath } from "./public-paths";

/** Ref archives are canonical only on the explicitly supported GNU tar/Linux path. */
export async function immutableTarArguments(tar: string, archive: string, directory: string, name: string): Promise<string[]> {
  if (process.platform !== "linux") throw new Error("Immutable ref archives require GNU tar on Linux");
  const child = Bun.spawn([tar, "--version"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TAR_OPTIONS: undefined, GZIP: undefined } });
  const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0 || !out.startsWith("tar (GNU tar)")) throw new Error("Immutable ref archives require GNU tar on Linux");
  return [tar, "--sort=name", "--format=ustar", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
    "--mode=u+rwX,go+rX,go-w", "--use-compress-program=gzip -n", "-cf", archive, "-C", directory, name];
}

export type CommittedFile = { path: string; bytes: Buffer; executable: boolean };
export type CommittedSource = { sourceCommit: string; version: string; files: CommittedFile[] };

/** Only an explicit complete commit ID is accepted, never a moving branch or tag. */
export function packageRefArguments(args: string[], positional = false): { ref?: string; destination?: string } {
  let ref: string | undefined, destination: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--ref" && ref === undefined) {
      const value = args[++index];
      if (!value || !/^[a-fA-F0-9]{40}$/.test(value)) throw new Error("--ref requires a full 40-hex commit ID");
      ref = value.toLowerCase();
    } else if (positional && destination === undefined && !arg.startsWith("-")) destination = arg;
    else throw new Error("Invalid package arguments");
  }
  if (positional && !destination) throw new Error("A package output directory is required");
  return { ...(ref === undefined ? {} : { ref }), ...(destination === undefined ? {} : { destination }) };
}

async function git(root: string, args: string[], input?: string): Promise<Buffer> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } });
  if (input !== undefined) child.stdin.write(input);
  child.stdin.end();
  const [out, , code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error("Cannot read immutable package commit");
  return Buffer.from(out);
}

/** Git objects only. No index, filesystem input files, checkout, or application code is executed. */
export async function readCommittedSource(root: string, ref: string, options: { filterPrivate?: boolean } = {}): Promise<CommittedSource> {
  if (typeof ref !== "string" || !/^[a-fA-F0-9]{40}$/.test(ref)) throw new Error("--ref requires a full 40-hex commit ID");
  const sourceCommit = ref.toLowerCase();
  if ((await git(root, ["cat-file", "-t", sourceCommit])).toString().trim() !== "commit")
    throw new Error("Package ref must identify a commit object");
  const rawListing = await git(root, ["ls-tree", "-rz", "--full-tree", sourceCommit]);
  const listing = rawListing.toString("utf8");
  if (!Buffer.from(listing).equals(rawListing)) throw new Error("Committed package paths must be UTF-8");
  const entries: { path: string; oid: string; executable: boolean; size: number }[] = [];
  for (const entry of listing.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t"), meta = entry.slice(0, tab).split(" "), path = entry.slice(tab + 1);
    if (tab < 0 || !isPublicSourcePath(path)) {
      if (options.filterPrivate && tab >= 0) continue;
      throw new Error("Private or invalid committed package input");
    }
    if ((meta[0] !== "100644" && meta[0] !== "100755") || meta[1] !== "blob" || !/^[a-f0-9]{40}$/.test(meta[2] ?? ""))
      throw new Error("Committed package inputs must be regular blobs");
    entries.push({ path, oid: meta[2]!, executable: meta[0] === "100755", size: 0 });
  }
  if (!entries.length || entries.length > 5000) throw new Error("Committed package file count is invalid");
  const requests = entries.map(entry => entry.oid + "\n").join("");
  const sizes = (await git(root, ["cat-file", "--batch-check"], requests)).toString().trimEnd().split("\n");
  let total = 0;
  for (const [index, entry] of entries.entries()) {
    const fields = sizes[index]?.split(" ");
    const size = Number(fields?.[2]);
    if (fields?.[0] !== entry.oid || fields?.[1] !== "blob" || !Number.isSafeInteger(size) || size < 0 || size > 10 * 1024 * 1024)
      throw new Error("Committed package blob exceeds bounds");
    entry.size = size; total += size;
    if (total > 64 * 1024 * 1024) throw new Error("Committed package exceeds total bounds");
  }
  if (sizes.length !== entries.length) throw new Error("Invalid committed package size response");
  const bodies = await git(root, ["cat-file", "--batch"], requests);
  let offset = 0;
  const files = entries.map(entry => {
    const end = bodies.indexOf(10, offset);
    if (end < 0 || bodies.subarray(offset, end).toString() !== `${entry.oid} blob ${entry.size}`) throw new Error("Invalid committed blob response");
    offset = end + 1;
    const bytes = Buffer.from(bodies.subarray(offset, offset + entry.size));
    offset += entry.size;
    if (bytes.length !== entry.size || bodies[offset++] !== 10) throw new Error("Incomplete committed blob response");
    return { path: entry.path, bytes, executable: entry.executable };
  });
  if (offset !== bodies.length) throw new Error("Trailing committed blob data");
  const pkg = JSON.parse(files.find(file => file.path === "package.json")?.bytes.toString() ?? "null");
  if (!pkg || pkg.name !== "sbar-orbit" || typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version))
    throw new Error("Invalid committed package identity");
  return { sourceCommit, version: pkg.version, files };
}
