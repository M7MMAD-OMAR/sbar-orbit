import { parseScrollInput, type ScrollInput } from "./scroll-input";
import { type BrowserContext, type Page } from "playwright";
import { launchChrome } from "./chrome";
import { OrbitError, record, text } from "./errors";

export type Action = { type: "navigate"; url: string } | { type: "fill"; selector: string; text: string }
  | { type: "click" | "read"; selector: string } | ScrollInput;
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
    default: throw new OrbitError("UNSUPPORTED", "No backend supports this action");
  }
}
export class BrowserBackend {
  readonly capabilities = ["navigate", "fill", "click", "scroll", "read", "observe", "pause", "resume", "stop"];
  parseAction = parseAction;
  onClose(listener: () => void) { this.owned.onClose(listener); }
  private constructor(private owned: Awaited<ReturnType<typeof launchChrome>>, readonly context: BrowserContext, readonly page: Page) {}
  static async create(profile: string): Promise<BrowserBackend> {
    const owned = await launchChrome(profile);
    owned.context.setDefaultTimeout(3000);
    owned.context.setDefaultNavigationTimeout(10000);
    return new BrowserBackend(owned, owned.context, owned.page);
  }
  async act(value: unknown): Promise<unknown> {
    const action = parseAction(value);
    switch (action.type) {
      case "scroll": return this.control(action);
      case "navigate": await this.page.goto(action.url); return { url: this.page.url() };
      case "fill": await this.page.locator(action.selector).fill(action.text); return { applied: true };
      case "click": await this.page.locator(action.selector).click(); return { applied: true };
      case "read": return { text: await this.page.locator(action.selector).innerText() };
    }
  }
  async observe() {
    const capturedAt = Date.now();
    const image = (await this.page.screenshot({ timeout: 3000 })).toString("base64");
    return { mimeType: "image/png", image, capturedAt, width: 1280, height: 800 };
  }
  async control(value: unknown) {
    const input = record(value);
    switch (input.type) {
      case "scroll": {
        const scroll = parseScrollInput(input);
        await this.page.mouse.move(scroll.x, scroll.y);
        await this.page.mouse.wheel(0, scroll.deltaY * 100);
        break;
      }
      case "click":
        if (typeof input.x !== "number" || typeof input.y !== "number" || !Number.isFinite(input.x) || !Number.isFinite(input.y)
          || input.x < 0 || input.y < 0 || input.x >= 1280 || input.y >= 800) throw new OrbitError("INVALID_REQUEST", "Coordinates outside session viewport");
        await this.page.mouse.click(input.x, input.y); break;
      case "text":
        if (typeof input.text !== "string" || input.text.length > 16384) throw new OrbitError("INVALID_REQUEST", "Invalid text");
        await this.page.keyboard.insertText(input.text); break;
      case "key":
        if (!["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(String(input.key))) throw new OrbitError("UNSUPPORTED", "Unsupported key");
        await this.page.keyboard.press(String(input.key)); break;
      default: throw new OrbitError("UNSUPPORTED", "Unsupported manual input");
    }
    return { applied: true };
  }
  close() { return this.owned.close(); }
}
