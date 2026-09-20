import { observeBrowserPointer } from "./browser-presence";
import { parseScrollInput, type ScrollInput } from "./scroll-input";
import { type BrowserContext, type Page } from "playwright";
import { launchChrome, type ChromeLaunchOptions } from "./chrome";
import { type EgressLease } from "./egress";
import { defaultViewport, parseViewport, requireInside, type Viewport } from "./viewport";
import { OrbitError, record, text } from "./errors";

/**
 * How long a single frame capture may take, in milliseconds.
 *
 * The default is the 3000 this used to hardcode, kept because it is a sane cadence on a machine
 * with a desktop. It is a variable rather than a constant because the number is a property of the
 * HOST, not of the product: a 2 vCPU runner, a loaded workstation with three agents on one budget,
 * or a software rendered virtio-gpu guest all take longer to paint the same page. A floor of 500
 * and a ceiling of 120000 keep a typo from turning capture into either a permanent failure or a
 * permanent hang, and a value that is not a number is ignored rather than silently read as NaN,
 * which Playwright treats as no timeout at all.
 */
export function captureTimeoutMs(raw = process.env.ORBIT_CAPTURE_TIMEOUT_MS): number {
  const requested = Number(raw);
  if (!raw || !Number.isFinite(requested)) return 3000;
  return Math.min(120_000, Math.max(500, Math.round(requested)));
}

export type Action = { type: "navigate"; url: string } | { type: "fill"; selector: string; text: string }
  | { type: "click" | "read"; selector: string } | { type: "select-tab" | "close-tab"; tab: number }
  | { type: "open-tab"; url?: string } | { type: "resize"; width: number; height: number } | ScrollInput;
function address(value: unknown): string {
  const url = text(value, "url");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new OrbitError("INVALID_REQUEST", "Invalid URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new OrbitError("UNSUPPORTED", "Only HTTP and HTTPS navigation is supported");
  return url;
}
export function parseAction(value: unknown, size: Viewport = defaultViewport): Action {
  const action = record(value);
  switch (action.type) {
    case "scroll": return parseScrollInput(action, size);
    case "resize": return { type: "resize", ...parseViewport(action) };
    case "navigate": return { type: "navigate", url: address(action.url) };
    case "open-tab": return action.url === undefined ? { type: "open-tab" } : { type: "open-tab", url: address(action.url) };
    case "fill":
      if (typeof action.text !== "string" || action.text.length > 16384) throw new OrbitError("INVALID_REQUEST", "Invalid text");
      return { type: "fill", selector: text(action.selector, "selector"), text: action.text };
    case "click": case "read": return { type: action.type, selector: text(action.selector, "selector") };
    case "select-tab": case "close-tab": {
      if (!Number.isInteger(action.tab) || Number(action.tab) < 1 || Number(action.tab) > 64)
        throw new OrbitError("INVALID_REQUEST", "Tab requires the 1-based number reported by observe");
      return { type: action.type, tab: Number(action.tab) };
    }
    default: throw new OrbitError("UNSUPPORTED", "No backend supports this action");
  }
}
/** A short, stable tab label. Falls back to the host and path when a tab has no title yet. */
function label(page: Page, title: string): string {
  if (title) return title.slice(0, 60);
  try {
    const url = new URL(page.url());
    return (url.protocol === "about:" ? "New tab" : `${url.host}${url.pathname === "/" ? "" : url.pathname}`).slice(0, 60);
  } catch { return "New tab"; }
}
export class BrowserBackend {
  readonly capabilities = ["navigate", "fill", "click", "scroll", "read", "open-tab", "select-tab", "close-tab", "resize", "observe", "pause", "resume", "stop"];
  parseAction = (value: unknown) => parseAction(value, this.size);
  private pointers = new Map<Page, () => Promise<{ x: number; y: number } | null>>();
  private active: Page;
  onClose(listener: () => void) { this.owned.onClose(listener); }
  get surface(): Viewport { return this.size; }
  private constructor(private owned: Awaited<ReturnType<typeof launchChrome>>, readonly context: BrowserContext, page: Page, private size: Viewport) {
    this.active = page;
  }
  /**
   * Hold the session to a set of origins, below the agent rather than in front of it.
   *
   * The policy check in the broker decides what the AGENT may ask for. It stops the agent and it
   * stops nothing else: a page redirects itself, loads an iframe, fetches, or opens a popup, and none
   * of that is an action the agent requested. For a session carrying the person's real logins that
   * gap is the whole attack, so the lease is enforced on the requests the browser actually makes.
   *
   * "any" installs nothing, which is right for a session that starts from an empty profile.
   */
  private static async holdOriginLease(context: BrowserContext, lease: string[] | "any", onBlocked: (origin: string) => void) {
    if (lease === "any") return;
    const allowed = new Set(lease);
    await context.route("**/*", async route => {
      const url = route.request().url();
      // A page's own chrome, blank tabs and data URLs are not network reach and carry no origin.
      if (/^(about:|data:|blob:|chrome(-extension)?:)/.test(url)) return route.continue();
      let origin: string;
      try { origin = new URL(url).origin; } catch { onBlocked("(unparseable)"); return route.abort("blockedbyclient"); }
      if (!allowed.has(origin)) { onBlocked(origin); return route.abort("blockedbyclient"); }
      // A request TO an allowed origin can still be answered with a redirect to somewhere else, and
      // the browser follows that itself without asking again. Measured: every other page initiated
      // route was held and a server side 302 walked straight through. Documents are therefore
      // fetched a hop at a time so each destination is checked before the browser sees it.
      if (route.request().resourceType() !== "document") return route.continue();
      let hop: Awaited<ReturnType<typeof route.fetch>>;
      // Fail CLOSED. `route.continue()` here handed the request back to the browser to follow the
      // redirect chain itself, which is the exact thing this hop at a time fetch exists to prevent,
      // and a page that can make the fetch fail (a slow upstream against the 5 s default, a response
      // shape the driver rejects) got the hole back. A refused load is recoverable; a followed
      // redirect off the leased origin is not.
      try { hop = await route.fetch({ maxRedirects: 0 }); }
      catch { onBlocked(origin); return route.abort("blockedbyclient"); }
      const location = hop.headers()["location"];
      if (hop.status() < 300 || hop.status() > 399 || !location) return route.fulfill({ response: hop });
      let target: string;
      try { target = new URL(location, url).origin; } catch { onBlocked("(unparseable)"); return route.abort("blockedbyclient"); }
      if (!allowed.has(target)) { onBlocked(target); return route.abort("blockedbyclient"); }
      await route.fulfill({ response: hop });
    });
  }

  static async create(profile: string, size: Viewport = defaultViewport, launch: ChromeLaunchOptions = {}, lease: string[] | "any" = "any", onBlocked: (origin: string) => void = () => {}, egress?: EgressLease): Promise<BrowserBackend> {
    // A confined browser is started through a wrapper and reached at the relay, not where it says it
    // is: inside its own network namespace, the port it publishes is not a port on this machine. The
    // wrapper execs the executable the caller named, so a cloned profile is still opened by its owner.
    const owned = await launchChrome(profile, size, egress?.tier === "namespace"
      ? { ...launch, executable: egress.launch.executable, extraArgs: egress.launch.args, endpointPort: egress.endpointPort }
      : launch);
    // Several sessions share one core, and a locator that resolves in 200 ms alone took over three
    // seconds with four other sessions working; that is contention, not a missing element. Ten
    // seconds made a missing element cost every caller ten seconds, so this sits in between.
    owned.context.setDefaultTimeout(5000);
    owned.context.setDefaultNavigationTimeout(15000);
    await BrowserBackend.holdOriginLease(owned.context, lease, onBlocked);
    const backend = new BrowserBackend(owned, owned.context, owned.page, size);
    // A site that opens a login or consent tab must become reachable, so follow the newest page
    // the way a person would, and fall back to a survivor when the active page goes away.
    owned.context.on("page", page => { backend.adopt(page); });
    for (const page of owned.context.pages()) backend.watch(page);
    try { await backend.bindPointer(owned.page); }
    catch (error) { await owned.close(); throw error; }
    return backend;
  }
  /** Follow a newly opened tab, sizing it so reported and real dimensions agree. */
  private adopt(page: Page) {
    this.watch(page);
    this.active = page;
    void page.setViewportSize(this.size).catch(() => {});
  }
  private watch(page: Page) {
    page.once("close", () => {
      this.pointers.delete(page);
      if (this.active !== page) return;
      const survivor = this.context.pages().filter(open => open !== page).at(-1);
      if (survivor) this.active = survivor;
    });
  }
  private async bindPointer(page: Page) {
    if (this.pointers.has(page)) return;
    this.pointers.set(page, await observeBrowserPointer(this.context, page));
  }
  /** The tab actions and observation both act on whichever page is current. */
  private get page(): Page {
    if (this.active.isClosed()) {
      const survivor = this.context.pages().at(-1);
      if (!survivor) throw new OrbitError("BACKEND_FAILED", "The owned browser has no open tab");
      this.active = survivor;
    }
    return this.active;
  }
  /**
   * Clicking a control that closes its own tab is an ordinary thing to do: a popup's Close button, a
   * link with window.close() behind it. Playwright rejects the gesture that caused it, because the
   * target it was driving went away mid click, so an agent saw a backend error for an action that did
   * exactly what it was asked. Measured before this existed, on a popup whose button closes it: three
   * rejections in twenty clicks, which is a race rather than a rule, and which is why the failure was
   * read for a day as a flaky test.
   *
   * Two conditions, not one. The page must be gone, and the session must still have a tab to go back
   * to: closing the session closes every page as well, and forgiving that would report a cancelled
   * action as a successful one, which the concurrency test caught. Every other click failure is still
   * raised, because a selector that matches nothing must not read as success. applied has always meant
   * the gesture was delivered rather than that the page acted on it, and closed is the part Orbit can
   * actually see, since whether the tab survived the click is not something it can ask afterwards.
   */
  private async clickThrough(page: Page, selector: string) {
    try { await page.locator(selector).click(); }
    catch (error) {
      if (!page.isClosed() || !this.context.pages().length) throw error;
      return { applied: true, closed: true };
    }
    return { applied: true };
  }
  private select(tab: number): Page {
    const pages = this.context.pages();
    const page = pages[tab - 1];
    if (!page) throw new OrbitError("INVALID_REQUEST", `Tab ${tab} is not open; observe reports ${pages.length} open`);
    return page;
  }
  async act(value: unknown): Promise<unknown> {
    const action = this.parseAction(value);
    const page = this.page;
    switch (action.type) {
      case "scroll": return this.control(action);
      case "navigate": await page.goto(action.url); return { url: page.url() };
      case "fill": await page.locator(action.selector).fill(action.text); return { applied: true };
      case "click": return this.clickThrough(page, action.selector);
      case "read": return { text: await page.locator(action.selector).innerText() };
      case "open-tab": {
        // The same ceiling select-tab and close-tab address by number.
        if (this.context.pages().length >= 64) throw new OrbitError("LIMIT_REACHED", "This session already has 64 tabs open");
        const opened = await this.context.newPage();
        await opened.setViewportSize(this.size).catch(() => {});
        if (action.url) await opened.goto(action.url);
        // After the navigation, not before: a page adopted while goto was in flight would otherwise
        // leave the returned tab number pointing at a tab the session no longer follows.
        this.active = opened;
        return { tab: this.context.pages().indexOf(opened) + 1, url: opened.url(), tabCount: this.context.pages().length };
      }
      case "select-tab": {
        this.active = this.select(action.tab);
        await this.active.bringToFront();
        return { tab: action.tab, url: this.active.url() };
      }
      case "resize": {
        // Every open tab is resized, not only the followed one, so a tab switch does not change
        // the meaning of the coordinates an agent just read from observe.
        const size = { width: action.width, height: action.height };
        const results = await Promise.allSettled(this.context.pages().map(open => open.setViewportSize(size)));
        const failed = results.filter(result => result.status === "rejected").length;
        if (failed === results.length) throw new OrbitError("BACKEND_FAILED", "The owned browser refused the new surface size");
        this.size = size;
        return { ...size, tabsResized: results.length - failed, tabCount: results.length };
      }
      case "close-tab": {
        const page = this.select(action.tab);
        if (this.context.pages().length === 1) throw new OrbitError("INVALID_REQUEST", "The last tab cannot be closed; stop the session instead");
        await page.close();
        return { closed: action.tab, tabCount: this.context.pages().length };
      }
    }
  }
  /** What the session is showing, without a frame. Cheap enough to poll from a desktop indicator. */
  async presence() {
    const page = this.page;
    try { await this.bindPointer(page); } catch {}
    const url = new URL(page.url());
    const location = url.protocol === "about:" ? "New page" : `${url.origin}${url.pathname}`;
    const title = (await page.title()).slice(0, 160);
    const pages = this.context.pages();
    // Tab labels come from the URL, which is already in memory, rather than asking every tab for its
    // title, so the strip in the viewer costs nothing per frame.
    const tabs = pages.map((open, index) => ({ tab: index + 1, label: label(open, open === page ? title : ""), active: open === page }));
    return { title, location, pageCount: pages.length, pageIndex: pages.indexOf(page) + 1, tabs,
      pointer: await (this.pointers.get(page) ?? (async () => null))() };
  }
  async observe() {
    const capturedAt = Date.now();
    const page = this.page;
    // JPEG at quality 80 costs about a third less to encode than PNG and a third of the bytes,
    // which matters because every frame is captured, base64 encoded and decoded again per poll.
    //
    // The budget was a bare 3000, chosen against the viewer's 1000 ms cadence on the development
    // host. A 2 vCPU GitHub Windows runner beat it on the very first capture after a cold navigate,
    // while Playwright was still waiting for fonts, and what an agent read back was
    // `BACKEND_ERROR: Request failed` with the real cause only in the broker's own stderr. That is
    // the unattributable failure ipc.ts already names: a timeout is attributable, so it says so
    // here, with the budget it exceeded and the knob that raises it.
    const budget = captureTimeoutMs();
    let image: string;
    try { image = (await page.screenshot({ type: "jpeg", quality: 80, timeout: budget })).toString("base64"); }
    catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        const stage = error.message.includes("fonts loaded") ? "capturing pixels"
          : error.message.includes("waiting for fonts to load") ? "waiting for fonts" : "preparing capture";
        throw new OrbitError("TIMEOUT", `The page did not produce a frame within ${budget} ms (${stage}). A slow or loaded host needs a larger budget: set ORBIT_CAPTURE_TIMEOUT_MS on the broker.`);
      }
      throw error;
    }
    return { mimeType: "image/jpeg", image, capturedAt, width: this.size.width, height: this.size.height, presence: await this.presence() };
  }
  async control(value: unknown) {
    const input = record(value);
    // Tab and surface changes are session state rather than page input, so they reuse the parsed action.
    if (["open-tab", "select-tab", "close-tab", "resize"].includes(String(input.type))) return this.act(input);
    const page = this.page;
    switch (input.type) {
      case "scroll": {
        const scroll = parseScrollInput(input, this.size);
        await page.mouse.move(scroll.x, scroll.y);
        await page.mouse.wheel(0, scroll.deltaY * 100);
        break;
      }
      case "click": {
        const at = requireInside(this.size, input.x, input.y);
        await page.mouse.click(at.x, at.y); break;
      }
      case "text":
        if (typeof input.text !== "string" || input.text.length > 16384) throw new OrbitError("INVALID_REQUEST", "Invalid text");
        await page.keyboard.insertText(input.text); break;
      case "key":
        if (!["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(String(input.key))) throw new OrbitError("UNSUPPORTED", "Unsupported key");
        await page.keyboard.press(String(input.key)); break;
      default: throw new OrbitError("UNSUPPORTED", "Unsupported manual input");
    }
    return { applied: true };
  }
  close() { return this.owned.close(); }
}
