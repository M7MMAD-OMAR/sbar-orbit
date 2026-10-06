import { forwardChromeProtocol } from "../src/chrome-transport-observer";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const receiver = {};
forwardChromeProtocol(undefined, "receive", receiver, function () {
  return Promise.reject(new Error("owned-protocol-original-rejection"));
}, [], {});
await Bun.sleep(10);
