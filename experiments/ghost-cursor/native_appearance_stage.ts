import { stageNativeAppearance } from "../../src/native-appearance";

const source = process.argv[2], parent = process.argv[3];
if (!source || !parent || process.argv.length !== 4) {
  console.error("Usage: bun native_appearance_stage.ts SOURCE_CONFIG PRIVATE_PARENT");
  process.exitCode = 2;
} else {
  try { console.log(JSON.stringify(await stageNativeAppearance(source, parent), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
