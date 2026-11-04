import { resolve } from "node:path";
import { packageRefArguments } from "./package-source";
import { registryPackageDirectory } from "./registry-package";

/** Directory materialization is never a fallback for public canonical archive generation. */
export function registryStageArguments(args: string[]) {
  const parsed = packageRefArguments(args, true);
  if (!parsed.ref) throw new Error("Registry directory staging requires --ref FULL_COMMIT_SHA");
  return { destination: resolve(parsed.destination!), ref: parsed.ref };
}
if (import.meta.main) {
  const { destination, ref } = registryStageArguments(process.argv.slice(2));
  console.log(await registryPackageDirectory(destination, undefined, { ref }));
}
