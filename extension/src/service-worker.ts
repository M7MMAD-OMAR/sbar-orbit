/**
 * The only part of this extension that touches a browser, and it decides nothing.
 *
 * WRITTEN, NOT LOADED, NOT VERIFIED. Nothing in this file has been run. Gates G12, G13 and G14 in
 * `docs/porting.md` each need this extension loaded in a real browser, and this project's rules
 * keep agents out of the person's own browser entirely, so all three stay open.
 *
 * The shape is the one decided in `docs/separate-workspace-review.md`: the extension never drives
 * anything. It runs in the person's browser, and on request it mints narrow, short lived, origin
 * scoped state and hands it to a separate Orbit browser through a native messaging host. There is
 * no content script, no tab automation and no navigation here, and there should never be.
 *
 * Person initiated, because gate G13 is open and untested: nobody has attempted the wake paths into
 * a stopped MV3 service worker, so the design takes the fallback that gate names in advance. The
 * sequence starts with a click on the toolbar action, which is both the gesture
 * `chrome.permissions.request` needs and the wake the worker needs, and a request arriving with
 * nobody present is refused.
 *
 * How long the worker survives an open native port is gate G14 and is NOT MEASURED. If it is
 * shorter than a mint takes, this file is where that will show, and the port is opened as late as
 * possible for that reason.
 *
 * `activeTab` is in the manifest for one reason: Chrome documents `tabs.Tab.url` as omitted unless
 * the extension holds `tabs`, `activeTab` or a host permission for that tab, and `activeTab` is the
 * narrowest of the three, granted on the action click and for that tab only. It is NOT assumed to
 * satisfy `chrome.cookies.getAll`; the per origin optional host permission below is what that read
 * asks for.
 */

import { parseMintResponse, type MintResponse } from "./envelope";
import { completeMint, planMint } from "./mint";
import { DEFAULT_TTL_MS } from "./grant";
import { canonicalOrigin, originAllowed, type MintedCookie } from "./origins";

/**
 * Declared here rather than in a global ambient file on purpose: a loose `chrome` global would leak
 * into the typecheck of the whole project. Only the members this file calls are described, and the
 * shapes are narrower than the real API.
 */
declare const chrome: {
  action: { onClicked: { addListener: (fn: (tab: { id?: number; url?: string }) => void) => void } };
  permissions: {
    contains: (what: { origins: string[] }) => Promise<boolean>;
    request: (what: { origins: string[] }) => Promise<boolean>;
  };
  cookies: { getAll: (query: { url: string }) => Promise<MintedCookie[]> };
  storage: { local: { get: (keys: string[]) => Promise<Record<string, unknown>> } };
  runtime: {
    lastError?: { message?: string };
    connectNative: (name: string) => {
      postMessage: (value: unknown) => void;
      disconnect: () => void;
      onMessage: { addListener: (fn: (value: unknown) => void) => void };
      onDisconnect: { addListener: (fn: () => void) => void };
    };
  };
};

/** Must match the host manifest filename and its `name` field exactly, or the connect finds nothing. */
const HOST_NAME = "com.sbarorbit.mint";

/** The origins the person configured. Absent configuration means an empty allowlist, not a wildcard. */
async function configuredAllowlist(): Promise<string[]> {
  const stored = await chrome.storage.local.get(["mintAllowlist"]);
  const entries = stored.mintAllowlist;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap(entry => {
    if (typeof entry !== "string") return [];
    const origin = canonicalOrigin(entry);
    return origin ? [origin] : [];
  });
}

/**
 * What the browser has actually granted, which is not the same as what the person allowed.
 *
 * `chrome.permissions.request` needs a live user gesture, and whether the gesture survives the
 * storage read that happens before this call is NOT MEASURED: it is one of the things loading the
 * extension would settle. The allowlist is still read first, because an origin the person never
 * allowed must be refused before anything is asked of the browser on its behalf, and a request that
 * does not go through surfaces as `ORIGIN_NOT_GRANTED` rather than as an assumption that it did.
 */
async function grantedOrigins(origin: string): Promise<string[]> {
  const pattern = `${origin}/*`;
  if (await chrome.permissions.contains({ origins: [pattern] })) return [origin];
  if (await chrome.permissions.request({ origins: [pattern] })) return [origin];
  return [];
}

/**
 * One mint, one port. The port is opened after the decision is made and the cookies are read, so a
 * refusal never opens a pipe to the host at all.
 */
async function deliver(response: MintResponse): Promise<void> {
  const port = chrome.runtime.connectNative(HOST_NAME);
  if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message ?? "No native messaging host");
  await new Promise<void>((resolve, reject) => {
    port.onDisconnect.addListener(() => reject(new Error(chrome.runtime.lastError?.message ?? "Host disconnected")));
    port.onMessage.addListener(value => {
      // The host acknowledges, and the acknowledgement is parsed with the same suspicion as
      // anything else that arrives from another process.
      const parsed = parseMintResponse(value, Date.now());
      port.disconnect();
      if (parsed.ok) resolve(); else reject(new Error(parsed.detail));
    });
    port.postMessage(response);
  });
}

chrome.action.onClicked.addListener(tab => {
  void (async () => {
    const id = `mint-${Date.now()}`;
    const origin = tab.url ? canonicalOrigin(tab.url) : undefined;
    if (!origin) {
      // Nothing is shown to the person here, because G13 is open and an unbidden surface is the
      // exact thing that gate is about. A refusal that nobody sees is the honest state of this file.
      return;
    }
    const request = { v: 1, id, kind: "mint" as const, origin, ttlMs: DEFAULT_TTL_MS };
    // Allowlist first, permission second, in that order and not as two arguments evaluated in some
    // order the reader has to work out. See the note on `grantedOrigins`.
    const allowlist = await configuredAllowlist();
    const granted = originAllowed(allowlist, origin) ? await grantedOrigins(origin) : [];
    const decision = planMint(request, { allowlist, granted, personPresent: true, now: Date.now() });
    const response = decision.ok
      ? completeMint(decision.plan, await chrome.cookies.getAll({ url: origin }), Date.now())
      : decision.response;
    // If the host is absent the delivery throws, and there is nowhere to report it to: the caller
    // is the host. `HOST_ABSENT` is the code the broker side reads when its own request times out
    // with no answer, not something this end can post into a pipe that does not exist.
    try { await deliver(response); } catch { /* nothing to deliver a refusal to */ }
  })();
});
