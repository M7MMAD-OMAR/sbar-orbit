# Sbar Orbit mint extension

**Loaded and measured on 14 September 2026**, in an Orbit owned headless Chromium 151 with a private profile, never in the person's browser: `experiments/extension-gates.ts` builds the shipped manifest unchanged, loads it, and the worker registers its click listener with `cookies`, `storage` and `runtime` bound. Two of the three gates below closed on that run and one stays open. What the person's own browser does with it is still unobserved, by rule.

## What it is

Roadmap item 6, and the mechanism decided in [the separate workspace review](../docs/separate-workspace-review.md): the one way to give an Orbit session the person's real logged in state that is the same shape on Linux, Windows and macOS, and that needs no profile copy, no keyring grant and none of the platform specific decryption problems recorded there.

The extension runs in the person's own browser. On request it mints narrow, short lived, origin scoped state for one origin, and hands it to a **separate** Orbit browser through a native messaging host. The agent then works in an Orbit owned headless browser exactly as it does today.

An MV3 extension cannot answer requests on a unix socket. That is why `host/mint_host.py` exists, and it is the only reason it exists.

## What it refuses to do

- **It never drives anything.** No content script, no tab automation, no navigation, no clicking. It reads cookies for one origin and writes a message to a pipe. The extension's presence in the person's browser is not a foothold in it.
- **It never mints for an origin the person did not configure.** The allowlist is exact origin membership with no wildcards and no subdomain widening, and absent configuration is an empty allowlist rather than a wildcard.
- **It never mints with nobody present.** The sequence starts with a click on the toolbar action. A request arriving at a stopped service worker is refused with `NO_PENDING_REQUEST` rather than announced, because gate G13 is open and an unbidden toast or popup is exactly what that gate is about.
- **It never mints for longer than five minutes**, asks for one minute by default, and a grant that expired in transit is refused by the reader rather than used.
- **It never asks the browser for anything the person has not granted.** There is no static `host_permissions` block, and no `tabs` permission. Host access is requested one origin at a time, under the user gesture the click provides, and only after the allowlist has already said yes.
- **The host never writes a grant to disk**, never reads a profile, cookie store or keyring, and never sends anything back into the browser beyond an acknowledgement with no cookies in it.

## What was measured, and what stays open

Three gates in [porting](../docs/porting.md) need this extension loaded in a browser. An Orbit owned headless browser is a browser, and it is not the person's, so two of them were closed there; the third is about the person's screen and cannot be.

- **G12. Closed.** `chrome.cookies.getAll` returned the `HttpOnly` session cookie beside the plain one, with `httpOnly: true`, the same two names the browser's own `Network.getCookies` listed. A cookie set with `{topLevelSite, hasCrossSiteAncestor}` came back with that exact `partitionKey`, was invisible to a `getAll` without one, and the returned key was accepted by `Network.setCookie` in a second browser and read back there. The `httpOnly` and `partitionKey` fields carried in `MintedCookie` are therefore the fields Chrome fills and accepts, no longer an assumption.
- **G13. Open.** How a queued mint reaches a stopped MV3 service worker without putting something on the person's screen. A headless browser has no screen, so the run says nothing about it; the one wake it used, `ServiceWorker.startWorker` from a debugger, is not a path a person has. The design keeps the answer the review wrote down: person initiated mint, and the code says so.
- **G14. Closed.** With nothing attached to it the worker stopped 30.07 seconds after its last work. With a `connectNative` port open to the real `host/mint_host.py`, which blocks on its stdin, it was still running at the 150 second cap, five times the idle interval, and the host process was alive throughout. The port is still opened as late as possible, because a pipe that is open is a process that is running.

Still not measured: whether `activeTab`'s temporary host access would satisfy `chrome.cookies.getAll`. The probe that closed G12 held a static host permission for its two test origins, because a headless run has no click to request one under. The extension keeps asking for a per origin optional host permission for the cookie read. `activeTab` is in the manifest for a different and narrower job, which is that Chrome documents `tabs.Tab.url` as omitted unless the extension holds `tabs`, `activeTab` or a host permission for that tab.

And not measured: whether the user gesture from the action click survives the storage read that precedes the permission request. The allowlist is still read first, because an origin the person never allowed has to be refused before anything is asked of the browser on its behalf.

Two facts from the run that a person loading this needs: branded Google Chrome ignores `--load-extension`, so the unpacked load goes through `chrome://extensions`; and on Linux the native messaging host manifest is read from `NativeMessagingHosts` under the browser's user data directory, which is what `~/.config/chromium` is.

## Layout

| Path | What it is |
|---|---|
| `manifest.json` | MV3 manifest. `activeTab`, `cookies`, `nativeMessaging`, `storage`, an action, and optional host permissions requested one origin at a time |
| `src/framing.ts` | Native messaging framing: four byte length prefix in native byte order, one megabyte cap, partial frames returned rather than failed |
| `src/origins.ts` | Origin canonicalization, exact allowlist matching, RFC 6265 cookie domain matching, and the minted cookie shape |
| `src/grant.ts` | Grant lifetimes, the five minute ceiling, and inclusive expiry |
| `src/envelope.ts` | The request and response envelope, parsed in both directions, and the refusal codes |
| `src/mint.ts` | The whole mint decision, with no browser in it |
| `src/service-worker.ts` | The only file that touches a browser. It decides nothing |
| `host/mint_host.py` | The native messaging host. Stdio on one side, the broker's unix socket on the other |
| `host/com.sbarorbit.mint.json` | The host manifest, with placeholders where the extension ID and absolute path go |

`src/origins.ts` duplicates the origin normalization in `src/egress.ts` rather than importing it, because that module is Bun code that opens sockets and an extension bundle must not carry a server runtime. The duplication carries the obligation that the two layers agree on what an origin is.

## Testing

`tests/extension.test.ts` covers the pure modules only: envelope parsing both ways, origin and cookie scoping, lifetimes and expiry, refusal codes, and framing. No browser API is faked anywhere in it, and `service-worker.ts` is deliberately not imported. Passing those tests says nothing about whether the extension loads; `experiments/extension-gates.ts` is what says that, by loading it.

```sh
bun test tests/extension.test.ts
bun run typecheck
```

## Loading it

A person loads this themselves. The steps are in [packaging](../docs/packaging.md) under "Load the mint extension by hand". To load it into an owned browser the way the gate run does: `bun run scripts/limited.ts bun run experiments/extension-gates.ts`.
