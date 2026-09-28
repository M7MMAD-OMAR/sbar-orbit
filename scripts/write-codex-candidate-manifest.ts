import { OrbitError } from "../src/errors";
import { writeStagedCodexCandidateManifest } from "../src/native-codex-candidate";

const executable = process.argv[2];
if (!executable || process.argv.length !== 3)
  throw new OrbitError("INVALID_REQUEST", "Use bun run scripts/write-codex-candidate-manifest.ts /var/tmp/private-stage/app/ChatGPT");
console.log(JSON.stringify(await writeStagedCodexCandidateManifest(executable)));
