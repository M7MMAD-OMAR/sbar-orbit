import { observeBrowserPointer } from "./browser-presence";
import { parseScrollInput, type ScrollInput } from "./scroll-input";
import { type BrowserContext, type Page } from "playwright";
import { launchChrome, viewport } from "./chrome";
import { OrbitError, record, text } from "./errors";

export type Action = { type: "navigate"; url: string } | { type: "fill"; selector: string; text: string }
  | { type: "click" | "read"; selector: string } | { type: "select-tab" | "close-tab"; tab: number } | ScrollInput;
export function parseAction(value: unknown): Action {
  const action = record(value);
  switch (action.type) {
    case "scroll": return parseScrollInput(action);
    case "navigate": {
      const url = text(action.url, "url");
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new OrbitError("INVALID_REQUEST", "Invalid URL"); }
      if (!["http:", "https:"].includes(parsed.protocol)) throw new OrbitError("UNSUPPORTED", "Only HTTP and HTTPS navigation is supported");
      return { type: "navigate", url };
    }
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
export class BrowserBackend {
  readonly capabilities = ["navigate", "fill", "click", "scroll", "read", "select-tab", "close-tab", "observe", "pause", "resume", "stop"];
  parseAction = parseAction;
  private pointers = new Map<Page, () => Promise<{ x: number; y: number } | null>>();
  private active: Page;
  onClose(listener: () => void) { this.owned.onClose(listener); }
  private constructor(private owned: Awaited<ReturnType<typeof launchChrome>>, readonly context: BrowserContext, page: Page) {
    this.active = page;
  }
  static async create(profile: string): Promise<BrowserBackend> {
    const owned = await launchChrome(profile);
    owned.context.setDefaultTimeout(3000);
    owned.context.setDefaultNavigationTimeout(10000);
    const backend = new BrowserBackend(owned, owned.context, owned.page);
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
    void page.setViewportSize(viewport).catch(() => {});
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
  private select(tab: number): Page {
    const pages = this.context.pages();
    const page = pages[tab - 1];
    if (!page) throw new OrbitError("INVALID_REQUEST", `Tab ${tab} is not open; observe reports ${pages.length} open`);
    return page;
  }
  async act(value: unknown): Promise<unknown> {
    const action = parseAction(value);
    const page = this.page;
    switch (action.type) {
      case "scroll": return this.control(action);
      case "navigate": await page.goto(action.url); return { url: page.url() };
      case "fill": await page.locator(action.selector).fill(action.text); return { applied: true };
      case "click": await page.locator(action.selector).click(); return { applied: true };
      case "read": return { text: await page.locator(action.selector).innerText() };
      case "select-tab": {
        this.active = this.select(action.tab);
        await this.active.bringToFront();
        return { tab: action.tab, url: this.active.url() };
      }
      case "close-tab": {
        const page = this.select(action.tab);
        if (this.context.pages().length === 1) throw new OrbitError("INVALID_REQUEST", "The last tab cannot be closed; stop the session instead");
        await page.close();
        return { closed: action.tab, tabCount: this.context.pages().length };
      }
    }
  }
  async observe() {
    const capturedAt = Date.now();
    const page = this.page;
    try { await this.bindPointer(page); } catch {}
    // JPEG at quality 80 costs about a third less to encode than PNG and a third of the bytes,
    // which matters because every frame is captured, base64 encoded and decoded again per poll.
    const image = (await page.screenshot({ type: "jpeg", quality: 80, timeout: 3000 })).toString("base64");
    const url = new URL(page.url());
    const location = url.protocol === "about:" ? "New page" : `${url.origin}${url.pathname}`;
    const title = (await page.title()).slice(0, 160);
    return { mimeType: "image/jpeg", image, capturedAt, width: 1280, height: 800,
      presence: { title, location, pageCount: this.context.pages().length, pageIndex: this.context.pages().indexOf(page) + 1,
        pointer: await (this.pointers.get(page) ?? (async () => null))() } };
  }
  async control(value: unknown) {
    const input = record(value);
    const page = this.page;
    switch (input.type) {
      case "scroll": {
        const scroll = parseScrollInput(input);
        await page.mouse.move(scroll.x, scroll.y);
        await page.mouse.wheel(0, scroll.deltaY * 100);
        break;
      }
      case "click":
        if (typeof input.x !== "number" || typeof input.y !== "number" || !Number.isFinite(input.x) || !Number.isFinite(input.y)
          || input.x < 0 || input.y < 0 || input.x >= 1280 || input.y >= 800) throw new OrbitError("INVALID_REQUEST", "Coordinates outside session viewport");
        await page.mouse.click(input.x, input.y); break;
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
