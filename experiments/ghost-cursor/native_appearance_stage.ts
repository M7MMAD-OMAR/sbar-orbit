import { stageNativeAppearance } from "../../src/native-appearance";

const source = process.argv[2], parent = process.argv[3], colorScheme = process.argv[4];
if (!source || !parent || process.argv.length < 4 || process.argv.length > 5) {
  console.error("Usage: bun native_appearance_stage.ts SOURCE_CONFIG PRIVATE_PARENT [default|prefer-dark|prefer-light]");
  process.exitCode = 2;
} else {
  try { console.log(JSON.stringify(await stageNativeAppearance(source, parent, colorScheme), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
