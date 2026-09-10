import { createWorkspaceDirectory } from "../src/workspace-storage";
import { requireResourceBudget } from "../src/resource-budget";
await requireResourceBudget();
import { launchChrome } from "../src/chrome";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

const output = join(import.meta.dir, "../output/playwright");
await mkdir(output, { recursive: true });
const owned = await launchChrome(await createWorkspaceDirectory("overview"));
const browser = owned.browser;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  await page.goto(new URL("../docs/overview.html", import.meta.url).href);
  if (await page.getByRole("heading", { level: 1 }).count() !== 1) throw new Error("Missing overview title");
  const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (await overflow()) throw new Error("Desktop page overflow");
  await page.screenshot({ path: join(output, "overview.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await overflow()) throw new Error("Mobile page overflow");
  const ids = await page.locator("svg [id]").evaluateAll(nodes => nodes.map(node => node.id));
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate diagram IDs");
  console.log("Overview rendered; desktop/mobile page bounds and diagram IDs passed.");
} finally {
  await owned.close();
}
