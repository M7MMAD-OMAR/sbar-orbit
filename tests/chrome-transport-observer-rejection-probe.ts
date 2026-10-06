import { ChromeTransportObserver, forwardChromeProtocol } from "../src/chrome-transport-observer";
import { requireResourceBudget } from "../src/resource-budget";

await requireResourceBudget();
const mode = process.argv[2] ?? "protocol";
if (mode === "fixture-baseline" || mode === "fixture-observed") {
  const originalStop = () => Promise.reject(new Error("owned-fixture-stop-original-rejection"));
  if (mode === "fixture-baseline") originalStop();
  else {
    const observer = new ChromeTransportObserver({ chrome: "not measured", observer: "not measured", fixture: "not measured", lock: "not measured", coreBundle: "not measured", dependencyVersion: "not measured" }, () => {});
    observer.observe("fixture-stop", originalStop);
    observer.finish();
  }
} else {
  forwardChromeProtocol(undefined, "receive", {}, function () {
    return Promise.reject(new Error("owned-protocol-original-rejection"));
  }, [], {});
}
await Bun.sleep(10);
