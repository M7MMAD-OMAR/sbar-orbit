import { OrbitError, record } from "./errors";

export type DesktopAction = { type: "desktops" } | { type: "list-windows" }
  | { type: "desktop"; desktopId: string }
  | { type: "move-window"; windowId: string; desktopId: string };
export interface DesktopInfo { desktopId: string; name: string; active: boolean }
export interface DesktopWindow { windowId: string; desktopId: string; title: string; pid: number; active: boolean }
/** IDs are opaque to callers. An OS adapter owns their format and validates their scope. */
export interface DesktopWorkspaceAdapter {
  listDesktops(): Promise<DesktopInfo[]>;
  listWindows(): Promise<DesktopWindow[]>;
  selectDesktop(desktopId: string): Promise<DesktopInfo[]>;
  moveWindow(windowId: string, desktopId: string): Promise<DesktopWindow>;
}

export function parseDesktopAction(input: Record<string, unknown>): DesktopAction | undefined {
  if (!["desktops", "list-windows", "desktop", "move-window"].includes(String(input.type))) return;
  const allowed = input.type === "move-window" ? ["type", "windowId", "desktopId"]
    : input.type === "desktop" ? ["type", "desktopId"] : ["type"];
  if (Object.keys(input).some(key => !allowed.includes(key)))
    throw new OrbitError("INVALID_REQUEST", "Desktop actions accept only explicit desktop and window identities");
  const identity = (value: unknown): string => {
    if (typeof value !== "string" || !value.length || value.length > 128 || /[\x00-\x1f\x7f]/.test(value))
      throw new OrbitError("INVALID_REQUEST", "A bounded desktop or window identity is required");
    return value;
  };
  if (input.type === "desktop") return { type: "desktop", desktopId: identity(input.desktopId) };
  if (input.type === "move-window") return { type: "move-window", windowId: identity(input.windowId), desktopId: identity(input.desktopId) };
  return { type: input.type as "desktops" | "list-windows" };
}

export interface PrivateWorkspaceTransport {
  tree(): Promise<unknown>;
  desktops(): Promise<unknown>;
  command(value: string): Promise<unknown>;
}

/** This adapter is constructed only from an owned private compositor's transport. */
export class SwayWorkspaceAdapter implements DesktopWorkspaceAdapter {
  private readonly scope = crypto.randomUUID();
  constructor(private transport: PrivateWorkspaceTransport) {}
  private number(value: string): number {
    if (!/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 2147483647)
      throw new OrbitError("INVALID_REQUEST", "This private desktop adapter requires a positive workspace number up to 2147483647");
    return Number(value);
  }
  async listDesktops(): Promise<DesktopInfo[]> {
    const reply = await this.transport.desktops();
    if (!Array.isArray(reply)) throw new OrbitError("BACKEND_FAILED", "Invalid private workspace list");
    return reply.map(item => {
      const desktop = record(item);
      if (!Number.isInteger(desktop.num) || Number(desktop.num) < 1)
        throw new OrbitError("UNSUPPORTED", "This private adapter supports numbered workspaces only");
      return { desktopId: String(desktop.num), name: String(desktop.name).slice(0, 160), active: desktop.focused === true };
    });
  }
  async listWindows(): Promise<DesktopWindow[]> {
    const found: DesktopWindow[] = [];
    const walk = (value: unknown, desktopId: string, depth: number) => {
      if (depth > 128) throw new OrbitError("BACKEND_FAILED", "Private window tree is too deep");
      const node = record(value);
      if (node.type === "workspace") desktopId = String(node.num);
      if (Number.isSafeInteger(node.pid) && Number(node.pid) > 0) {
        if (!Number.isSafeInteger(node.id) || Number(node.id) < 1)
          throw new OrbitError("BACKEND_FAILED", "Invalid private window identity");
        this.number(desktopId);
        found.push({ windowId: `${this.scope}:${node.id}`, desktopId, title: String(node.name ?? "Window").slice(0, 160), pid: Number(node.pid), active: node.focused === true });
      }
      for (const key of ["nodes", "floating_nodes"]) {
        const children = node[key] ?? [];
        if (!Array.isArray(children)) throw new OrbitError("BACKEND_FAILED", "Invalid private window tree");
        for (const child of children) walk(child, desktopId, depth + 1);
      }
    };
    walk(await this.transport.tree(), "", 0);
    return found;
  }
  async selectDesktop(desktopId: string): Promise<DesktopInfo[]> {
    const target = this.number(desktopId);
    await this.transport.command(`workspace number ${target}`);
    const desktops = await this.listDesktops();
    if (!desktops.some(desktop => desktop.desktopId === desktopId && desktop.active))
      throw new OrbitError("BACKEND_FAILED", "Private desktop selection was not observed");
    return desktops;
  }
  async moveWindow(windowId: string, desktopId: string): Promise<DesktopWindow> {
    const target = this.number(desktopId);
    const window = (await this.listWindows()).find(window => window.windowId === windowId);
    if (!window) throw new OrbitError("INVALID_REQUEST", "Window identity is stale or belongs to another private session");
    const container = windowId.slice(this.scope.length + 1);
    const active = (await this.listDesktops()).find(desktop => desktop.active)?.desktopId;
    if (!active) throw new OrbitError("BACKEND_FAILED", "The active private desktop was not observed");
    await this.transport.command(`[con_id=${container}] move container to workspace number ${target}`);
    const moved = (await this.listWindows()).find(window => window.windowId === windowId);
    if (!moved || moved.desktopId !== desktopId)
      throw new OrbitError("BACKEND_FAILED", "Private window movement was not observed");
    if ((await this.listDesktops()).find(desktop => desktop.active)?.desktopId !== active)
      throw new OrbitError("BACKEND_FAILED", "Private window movement changed the active desktop");
    return moved;
  }
}
