import { readVerifiedSource } from "./source-manifest";
import { requireResourceBudget } from "../src/resource-budget";

const [root, ...extra] = process.argv.slice(2);
if (!root || extra.length) throw new Error("Usage: verify-source.ts EXTRACTED_SOURCE_DIRECTORY");
await requireResourceBudget();
const source = await readVerifiedSource(root);
console.log(JSON.stringify({ verified: true, version: source.version, files: source.files.length,
  limitation: "Content matches the supplied manifest. Verify the published archive digest separately to authenticate the release." }));
