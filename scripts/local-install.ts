import { activateLocal, deactivateLocal } from "../src/local-install";
import { requireResourceBudget } from "../src/resource-budget";

const [command, first, second, ...extra] = process.argv.slice(2);
if (extra.length || !(command === "install" && first && second || command === "uninstall" && first && !second))
  throw new Error("Usage: local-install.ts install SOURCE PREFIX | uninstall PREFIX");
await requireResourceBudget();
if (command === "install" && first && second)
  console.log(JSON.stringify({ launcher: await activateLocal(first, second), sourceRetained: true }));
else if (command === "uninstall" && first) {
  await deactivateLocal(first);
  console.log(JSON.stringify({ removed: "launcher-link-only", sourceAndDataRetained: true }));
}
