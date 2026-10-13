/** Linux x64 and arm64 use the generic little endian Btrfs ioctl ABI. */
export const snapshotIoctl = 0x50009417;
export function snapshotArguments(sourceFd: number, name: string): Uint8Array {
  const encoded = new TextEncoder().encode(name);
  if (!Number.isSafeInteger(sourceFd) || sourceFd < 0 || !encoded.length || encoded.length > 255 ||
      name === "." || name === ".." || name.includes("/") || name.includes("\0"))
    throw new Error("Invalid snapshot descriptor or basename");
  // struct btrfs_ioctl_vol_args_v2: fd 0, transid 8, flags 16, unused 24, name 56.
  const bytes = new Uint8Array(4096);
  const view = new DataView(bytes.buffer);
  view.setBigInt64(0, BigInt(sourceFd), true);
  view.setBigUint64(16, 2n, true); // BTRFS_SUBVOL_RDONLY, no asynchronous creation.
  bytes.set(encoded, 56);
  return bytes;
}
export type SnapshotResult =
  | { status: "created" }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; phase: "validation" | "open" | "ioctl" | "worker"; reason: string; errno?: number };
export type SnapshotRequest = { id: number; sourceFd: number; destinationFd: number; name: string };
export type SnapshotReply = { id: number; result: SnapshotResult };
