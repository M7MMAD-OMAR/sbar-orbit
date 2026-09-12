# Sbar Orbit mint extension

**Written, not loaded, not verified.** No part of this directory has been loaded into a browser, started, or observed running, on this machine or any other. Everything below describes what the code is written to do, not what it was measured doing.

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

## What is open, and stays open

Three gates in [porting](../docs/porting.md) need this extension loaded in a real browser. This project's rules keep agents out of the person's own browser entirely, so no agent closes them.

- **G12.** Whether `chrome.cookies.getAll` returns `HttpOnly` cookies, and whether partition keys survive the round trip. **Not measured.** Session cookies are `HttpOnly`, so if the answer is no, this whole path mints nothing worth having. The `httpOnly` and `partitionKey` fields are carried through in the shape CDP wants, on that unverified assumption.
- **G13.** How a queued mint reaches a stopped MV3 service worker without putting something on the person's screen. **Not measured.** The design takes the answer the review already wrote down for this case: person initiated mint, and the code says so.
- **G14.** Whether an open native messaging port keeps the service worker alive, and for how long. **Not measured.** The port is opened as late as possible for that reason.

Also not measured: whether `activeTab`'s temporary host access would satisfy `chrome.cookies.getAll`. Rather than assume it does, the extension asks for a per origin optional host permission for the cookie read. `activeTab` is in the manifest for a different and narrower job, which is that Chrome documents `tabs.Tab.url` as omitted unless the extension holds `tabs`, `activeTab` or a host permission for that tab.

And not measured: whether the user gesture from the action click survives the storage read that precedes the permission request. The allowlist is still read first, because an origin the person never allowed has to be refused before anything is asked of the browser on its behalf.

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

`tests/extension.test.ts` covers the pure modules only: envelope parsing both ways, origin and cookie scoping, lifetimes and expiry, refusal codes, and framing. No browser API is faked anywhere in it, and `service-worker.ts` is deliberately not imported. Passing those tests says nothing about whether the extension loads.

```sh
bun test tests/extension.test.ts
bun run typecheck
```

## Loading it

A person loads this themselves. The steps, also untested, are in [packaging](../docs/packaging.md) under "Load the mint extension by hand".
