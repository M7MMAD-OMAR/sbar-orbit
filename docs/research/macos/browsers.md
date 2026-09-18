# Chromium family browsers on macOS 13+: install, identify, launch safely

Written for engineers implementing detection code in Sbar Orbit. Every claim is
labelled either **[documented]** (primary source: Apple docs, Chromium source or
docs, vendor source) or **[observed/third party]** (widely used automation code,
vendor forum, or convention that should be verified at runtime on a real Mac).

Research was done from Linux, so nothing here is verified against a live macOS
machine. Items marked **[verify on Mac]** are the ones where running one command
on a real Mac would settle it. No Mac was available to this task.

Primary sources used:

- Chromium `docs/user_data_dir.md`
  https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md
- Chromium `chrome/common/chrome_paths_mac.mm`
  https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/common/chrome_paths_mac.mm
- Chromium `components/os_crypt/common/keychain_password_mac.mm`
  https://chromium.googlesource.com/chromium/src/+/HEAD/components/os_crypt/common/keychain_password_mac.mm
- Chromium `components/os_crypt/sync/os_crypt_mac.mm` (tag 120.0.6099.109)
- Chromium `components/os_crypt/async/browser/keychain_key_provider.mm`
- Chromium `crypto/apple/keychain_v2.mm`
- Chromium `components/os_crypt/async/browser/posix_key_provider.cc` (Linux, for contrast)
- Chromium `headless/README.md`
- Chrome for Developers, "Chrome Headless mode" and "Removing --headless=old from Chrome"
- Apple Platform Security, "Gatekeeper and runtime protection in macOS"
- Apple Developer, "Access Control Lists" (keychain ACL semantics)
- Apple Developer, "Resolving common notarization issues" (codesign verification flags)
- `codesign(1)` man page
- Brave `app/theme/brave/BRANDING` and `build/config.gni`
- Chromium `chrome/app/theme/chromium/BRANDING`
- Playwright `packages/playwright-core/src/server/registry/index.ts`
- Puppeteer `packages/browsers/src/browser-data/chrome.ts` and `chromium.ts`
- chrome-launcher `src/chrome-finder.ts`

---

## 1. Install locations and executable paths inside the bundle

macOS apps install as a bundle `X.app`. The runnable Mach-O is
`X.app/Contents/MacOS/<CFBundleExecutable>`, and that inner name is NOT the same
as the bundle name for every vendor. Almost all of these contain spaces.

Two roots must be probed, in this order:

1. `/Applications` (system wide, the normal case)
2. `$HOME/Applications` (per user install, e.g. dragged there by a non admin user)

A third root exists and must be **rejected**: `/Volumes/...`, an app still
running from a mounted DMG. chrome-launcher explicitly de-prioritises
`/Volumes/` paths (weight -1 and -2 in `chrome-finder.ts`)
**[documented, chrome-launcher source]**. Orbit should refuse a `/Volumes/` path
outright, because Gatekeeper path randomisation also applies there (see section 6).

### Table: bundle, executable path, bundle id

`{ROOT}` is `/Applications` or `$HOME/Applications`.

| Browser | Executable path (literal, relative to `{ROOT}`) | CFBundleIdentifier | Source |
|---|---|---|---|
| Google Chrome | `/Google Chrome.app/Contents/MacOS/Google Chrome` | `com.google.Chrome` | Playwright registry, chrome-launcher, Chromium user_data_dir.md **[documented]** |
| Google Chrome Beta | `/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta` | `com.google.Chrome.beta` | Playwright registry **[documented]**; bundle id **[observed]** |
| Google Chrome Dev | `/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev` | `com.google.Chrome.dev` | Playwright registry **[documented]**; bundle id **[observed]** |
| Google Chrome Canary | `/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary` | `com.google.Chrome.canary` | Playwright registry, chrome-launcher **[documented]**; bundle id **[observed]** |
| Google Chrome for Testing | `/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` | `com.google.chrome.for.testing` | Puppeteer `chrome.ts`, Playwright registry **[documented]**; bundle id **[observed]** |
| Chromium | `/Chromium.app/Contents/MacOS/Chromium` | `org.chromium.Chromium` | Puppeteer `chromium.ts`, Chromium `mac_build_instructions.md`, Chromium BRANDING **[documented]** |
| Microsoft Edge | `/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` | `com.microsoft.Edge` | Playwright registry **[documented]** |
| Microsoft Edge Beta | `/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta` | `com.microsoft.Edge.Beta` | Playwright registry **[documented]**; bundle id **[observed]** |
| Microsoft Edge Dev | `/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev` | `com.microsoft.Edge.Dev` | Playwright registry **[documented]**; bundle id **[observed]** |
| Microsoft Edge Canary | `/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary` | `com.microsoft.Edge.Canary` | Playwright registry **[documented]**; bundle id **[observed]** |
| Brave Browser | `/Brave Browser.app/Contents/MacOS/Brave Browser` | `com.brave.Browser` | Brave `BRANDING` gives the bundle id **[documented]**; path **[observed, widely used]** |
| Brave Browser Beta | `/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta` | `com.brave.Browser.beta` | **[observed]** |
| Brave Browser Nightly | `/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly` | `com.brave.Browser.nightly` | **[observed]** |
| Vivaldi | `/Vivaldi.app/Contents/MacOS/Vivaldi` | `com.vivaldi.Vivaldi` | vivaldi-location2 `scan-osx-path.ts` **[documented, third party]**; bundle id **[observed]** |
| Vivaldi Snapshot | `/Vivaldi Snapshot.app/Contents/MacOS/Vivaldi` (inner name is `Vivaldi`, not `Vivaldi Snapshot`) | `com.vivaldi.Vivaldi.snapshot` | vivaldi-location2 **[documented, third party]** |
| Opera | `/Opera.app/Contents/MacOS/Opera` | `com.operasoftware.Opera` | opera-location2 `scan-osx-path.ts` **[documented, third party]** |
| Opera Beta | `/Opera Beta.app/Contents/MacOS/Opera Beta` | `com.operasoftware.OperaNext` | opera-location2 **[documented, third party]** |
| Opera Developer | `/Opera Developer.app/Contents/MacOS/Opera Developer` | `com.operasoftware.OperaDeveloper` | opera-location2 **[documented, third party]** |
| Opera GX | `/Opera GX.app/Contents/MacOS/Opera` | `com.operasoftware.OperaGX` | **[observed, verify on Mac]** |
| Arc | `/Arc.app/Contents/MacOS/Arc` | `company.thebrowser.Browser` | Multiple Arc CDP tools default `ARC_MCP_BIN` to this path **[observed, consistent across sources]** |

Notes that matter for code:

- Vivaldi Snapshot is the one case where the inner executable name does not track
  the bundle name. Never derive the inner name by stripping `.app`. Always read
  `CFBundleExecutable` from `Contents/Info.plist` (section 3).
- Chrome for Testing is the bundle Puppeteer and Playwright download; it is not
  usually in `/Applications`, it sits inside the cache dir of the automation
  tool. It is the best possible Orbit target when present, because it is
  explicitly built for automation.
- Playwright also ships `chrome-headless-shell` on macOS as a bare binary, not a
  bundle: `chrome-headless-shell-mac-arm64/chrome-headless-shell` and
  `chrome-headless-shell-mac-x64/chrome-headless-shell`
  **[documented, Playwright registry]**.

---

## 2. User data directories and cookie file locations

Chromium computes this as `~/Library/Application Support/<CrProductDirName>`.
The mechanism is in `chrome_paths_mac.mm`: `ProductDirNameForBundle()` reads the
`CrProductDirName` key from the **outer** `.app` bundle's `Info.plist`, and falls
back to `"Google/Chrome"` for Google branded builds, `"Google/Chrome for Testing"`
for CfT branding, and `"Chromium"` otherwise **[documented, Chromium source]**.

That means the single most reliable way to get any Chromium fork's user data
directory is to read `CrProductDirName` out of its own `Info.plist`, not to
hardcode the fork's name. Brave, for example, sets it from GN:
`brave_product_dir_name = "BraveSoftware/Brave-$_product_brand$suffix"` with
suffixes `""`, `-Beta`, `-Dev`, `-Nightly`, `-Development`
**[documented, brave-core `build/config.gni`]**.

Command to read it without launching:

```
plutil -extract CrProductDirName raw -o - "/Applications/Brave Browser.app/Contents/Info.plist"
```

Inside a user data directory, Chromium lays out:

- `Local State` (global JSON, holds the profile list and, on Windows, the
  encrypted key; on macOS the key is in the Keychain instead)
- `Default/` (the first profile)
- `Profile 1/`, `Profile 2/`, ... (subsequent profiles)
- `Default/Cookies` (SQLite; also `Cookies-journal` / `Cookies-wal`)

**[documented, Chromium user_data_dir.md for the dir layout and `Default`
naming; the `Cookies` filename is [observed] but universal]**

### Table: user data dirs

`~` is the POSIX home. All literal.

| Browser | User data directory | Default profile | Cookies DB |
|---|---|---|---|
| Google Chrome | `~/Library/Application Support/Google/Chrome` | `.../Google/Chrome/Default` | `.../Google/Chrome/Default/Cookies` |
| Chrome Beta | `~/Library/Application Support/Google/Chrome Beta` | `.../Default` | `.../Default/Cookies` |
| Chrome Dev | `~/Library/Application Support/Google/Chrome Dev` | `.../Default` | `.../Default/Cookies` |
| Chrome Canary | `~/Library/Application Support/Google/Chrome Canary` | `.../Default` | `.../Default/Cookies` |
| Chrome for Testing | `~/Library/Application Support/Google/Chrome for Testing` | `.../Default` | `.../Default/Cookies` |
| Chromium | `~/Library/Application Support/Chromium` | `.../Chromium/Default` | `.../Chromium/Default/Cookies` |
| Microsoft Edge | `~/Library/Application Support/Microsoft Edge` | `.../Default` | `.../Default/Cookies` |
| Edge Beta / Dev / Canary | `~/Library/Application Support/Microsoft Edge Beta` / ` Dev` / ` Canary` | `.../Default` | `.../Default/Cookies` |
| Brave | `~/Library/Application Support/BraveSoftware/Brave-Browser` | `.../Default` | `.../Default/Cookies` |
| Brave Beta / Dev / Nightly | `~/Library/Application Support/BraveSoftware/Brave-Browser-Beta` / `-Dev` / `-Nightly` | `.../Default` | `.../Default/Cookies` |
| Vivaldi | `~/Library/Application Support/Vivaldi` | `.../Vivaldi/Default` | `.../Vivaldi/Default/Cookies` |
| Vivaldi Snapshot | `~/Library/Application Support/Vivaldi Snapshot` | `.../Default` | `.../Default/Cookies` |
| Opera | `~/Library/Application Support/com.operasoftware.Opera` | **no `Default` subdir; the profile is the root** | `~/Library/Application Support/com.operasoftware.Opera/Cookies` |
| Opera Beta | `~/Library/Application Support/com.operasoftware.OperaNext` | root | `.../Cookies` |
| Opera Developer | `~/Library/Application Support/com.operasoftware.OperaDeveloper` | root | `.../Cookies` |
| Opera GX | `~/Library/Application Support/com.operasoftware.OperaGX` | root | `.../Cookies` |
| Arc | `~/Library/Application Support/Arc/User Data` | `.../User Data/Default` | `.../User Data/Default/Cookies` |

Sources: Chrome / Chrome Beta / Dev / Canary / CfT / Chromium rows are
**[documented, Chromium `docs/user_data_dir.md`]**. Brave is **[documented,
brave-core `build/config.gni`]**. Edge, Vivaldi, Opera, Arc rows are
**[observed]**, cross checked against `browser_cookie3`
(`borisbabic/browser_cookie3`, `__init__.py`, the `osx_cookies` lists) and Microsoft
Q&A for Edge. Opera's flattened layout (no `Default`) and Arc's extra
`User Data` level are the two shapes that break a naive
`<userDataDir>/Default/Cookies` assumption; both come from `browser_cookie3`
**[observed, verify on Mac]**.

Related, for completeness: the cache dir is derived, not adjacent. Chromium maps
`~/Library/Application Support/<X>` to `~/Library/Caches/<X>`, e.g.
`~/Library/Caches/Google/Chrome/Default` **[documented, user_data_dir.md]**.

---

## 3. Identifying a bundle without launching it

All of these are pure reads. None of them execute the target binary and none of
them ask LaunchServices to open anything.

### 3.1 Info.plist

Path: `<bundle>.app/Contents/Info.plist`. It can be binary plist or XML, so never
grep it; always go through `plutil` (present on every macOS since 10.2).

Fields to parse:

| Key | Meaning | Use in Orbit |
|---|---|---|
| `CFBundleIdentifier` | reverse DNS id, e.g. `com.google.Chrome` | the identity check; a renamed `.app` still carries the true id |
| `CFBundleExecutable` | inner Mach-O filename inside `Contents/MacOS` | build the launch path; required because of Vivaldi Snapshot |
| `CFBundleShortVersionString` | marketing version, e.g. `131.0.6778.86` | the browser version, without running it |
| `CFBundleVersion` | build version | tiebreaker, Chromium sets it to the 3rd and 4th version components |
| `CrProductDirName` | Chromium specific; product dir under Application Support | the user data dir, authoritative per Chromium source |
| `KSProductID` / `KSChannelID` | Keystone (Google updater) product and channel | channel detection for Google and Brave builds |

Exact commands:

```
BUNDLE="/Applications/Google Chrome.app"
plutil -extract CFBundleIdentifier         raw -o - "$BUNDLE/Contents/Info.plist"
plutil -extract CFBundleExecutable         raw -o - "$BUNDLE/Contents/Info.plist"
plutil -extract CFBundleShortVersionString raw -o - "$BUNDLE/Contents/Info.plist"
plutil -extract CFBundleVersion            raw -o - "$BUNDLE/Contents/Info.plist"
plutil -extract CrProductDirName           raw -o - "$BUNDLE/Contents/Info.plist"
```

`-extract KEY raw -o -` prints the bare scalar to stdout with no quotes. Exit
code is non zero when the key is absent, which is the correct signal for
"this is not a Chromium fork" on `CrProductDirName`.

Whole plist as JSON, which is the better shape for a TypeScript implementation
because it is one process spawn instead of five:

```
plutil -convert json -o - "$BUNDLE/Contents/Info.plist"
```

Then `JSON.parse` the stdout. This is the recommended Orbit approach.

Alternative, older, still present:

```
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$BUNDLE/Contents/Info.plist"
```

PlistBuddy is fine but its error output is less script friendly and it is not a
documented public tool. Prefer `plutil`.

Do **not** use `mdls -name kMDItemVersion` for the version: it reads the
Spotlight index, which can be stale or absent on volumes without indexing.

Do **not** run `"<exec> --version"` to get the version. It executes the browser,
it can touch the default user data directory, and on a quarantined bundle it can
trip Gatekeeper. `CFBundleShortVersionString` is the same number.

### 3.2 Code signature: who made this binary

```
codesign -dv --verbose=4 "$BUNDLE" 2>&1
```

`codesign -d` displays, `-v` at that level raises verbosity (note the documented
dual meaning of `-v`: the first `-v` with no other operation means `--verify`,
but combined with `-d` it means verbose; use the long forms if this is confusing:
`codesign --display --verbose=4`) **[documented, codesign(1)]**.

Output goes to **stderr**, not stdout. Capture both.

Fields to parse from that output:

| Line prefix | Example value | Use |
|---|---|---|
| `Identifier=` | `com.google.Chrome` | must match `CFBundleIdentifier` from the plist; a mismatch means a repackaged or tampered bundle |
| `TeamIdentifier=` | `EQHXZ8M8AV` (Google), `KL8N8XSYF4` (Brave, from brave-core `BRANDING` **[documented]**) | pin the vendor |
| `Authority=` (repeated, leaf first) | `Developer ID Application: Google, Inc. (EQHXZ8M8AV)`, then `Developer ID Certification Authority`, then `Apple Root CA` | the leaf Authority is the human readable vendor |
| `Format=` | `app bundle with Mach-O universal (x86_64 arm64)` | architecture, useful to know if Rosetta is involved |
| `Sealed Resources` / `CodeDirectory v=` | | sanity only |
| `Runtime Version=` | | hardened runtime presence |

A signature that is ad hoc prints `Signature=adhoc` and has no `TeamIdentifier`.
Orbit should treat an ad hoc or unsigned Chromium build as usable only if the
user opted in explicitly, because it is also the shape a locally built Chromium
takes.

Integrity check:

```
codesign --verify --strict --verbose=2 "$BUNDLE"
```

Exit 0 means valid; exit 1 means the signature failed to verify; exit 2 means bad
arguments; exit 3 means the `-R` requirement was not satisfied **[documented,
codesign(1) DIAGNOSTICS]**. Apple's own notarization troubleshooting doc uses
`codesign -vvv --deep --strict /path/to/binary/or/bundle` for this purpose and
describes `--strict` as raising validation strictness to the level notarization
requires **[documented, Apple "Resolving common notarization issues"]**.

Caution on `--deep`: it is deprecated for *signing* as of macOS 13.0, but it is
still the documented way to make *verification* recurse into nested code
(helpers, frameworks) rather than doing the shallow check **[documented,
codesign(1)]**. For a Chrome bundle `--deep --strict` verification reads the
whole framework and all helper apps, which takes a noticeable fraction of a
second to several seconds. For Orbit's detection path, prefer the cheap
`codesign --verify --strict` and reserve `--deep` for an explicit "audit this
browser" command.

Requirement pinning, the strongest check, refuses anything not signed by the
expected team:

```
codesign --verify --strict \
  -R '=identifier "com.google.Chrome" and anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"' \
  "$BUNDLE"
```

Exit 3 specifically means "properly signed, but not the vendor you asked for"
**[documented, codesign(1)]**.

---

## 4. LaunchServices lookup: where is the app with bundle id X

Three options, in decreasing order of "safe to run in an agent".

### 4.1 mdfind (Spotlight), recommended

```
mdfind "kMDItemCFBundleIdentifier == 'com.google.Chrome'"
```

or the shorthand widely used in Apple's own ecosystem:

```
mdfind kMDItemCFBundleIdentifier="com.google.Chrome"
```

Prints one bundle path per line. Restrict the search domain to cut noise and
cost:

```
mdfind -onlyin /Applications      "kMDItemCFBundleIdentifier == 'com.google.Chrome'"
mdfind -onlyin "$HOME/Applications" "kMDItemCFBundleIdentifier == 'com.google.Chrome'"
```

`kMDItemCFBundleIdentifier` is documented Apple metadata: "If this item is a
bundle, then this is the CFBundleIdentifier" **[documented, Apple Developer]**.

Safety: `mdfind` is a metadata query, it never opens or launches anything
**[documented behaviour of mdfind(1)]**.

TCC: `mdfind` itself needs no special entitlement, but Spotlight results for
paths under TCC protected folders (`~/Desktop`, `~/Documents`, `~/Downloads`,
external volumes) are filtered for a process without Full Disk Access
**[observed, consistent across TCC writeups]**. `/Applications` and
`~/Applications` are **not** TCC protected, so Orbit's lookups are unaffected.
This is also why Orbit should not try to find browsers in `~/Downloads`: it will
half work depending on whether the calling terminal has FDA.

Failure mode: if Spotlight indexing is off for the volume (`mdutil -s /`),
`mdfind` returns nothing even though the app exists. Always treat mdfind as an
*additional* discovery source, never the only one. Path probing from section 1
must remain the primary method.

### 4.2 lsregister -dump

```
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -dump
```

This dumps the entire Launch Services database to stdout. chrome-launcher uses
exactly this path and this flag to enumerate Chrome installs, then greps for
`google chrome( canary)?\.app` **[documented, chrome-launcher `chrome-finder.ts`]**.

Safety: `-dump` is read only and does not launch anything. The dangerous flags on
the same tool are `-kill -r -domain local -domain system -domain user` (rebuild
the database) and `-u` (unregister). Orbit must never pass anything but `-dump`.

Costs and caveats:

- It is **undocumented**. There is no man page. Its path has moved between macOS
  releases and it is not guaranteed stable.
- The dump is large (megabytes) and slow. chrome-launcher explicitly added a
  `darwinFast()` fast path that checks the two canonical `/Applications` paths
  first precisely "to avoid waiting for the slow lsregister command"
  **[documented, chrome-launcher source comment]**.
- It lists stale entries: apps that were deleted, apps inside DMGs, apps in the
  Trash. Every hit must be re-validated with `fs.existsSync` on the inner
  executable before use.

Recommendation for Orbit: do not shell out to `lsregister` at all. Path probing
plus `mdfind` covers everything, and `lsregister` is an undocumented private
binary whose output format is not contractual.

### 4.3 Things to not do

- `open -b com.google.Chrome` and `open -a "Google Chrome"` **launch the app**.
  Never use them for detection.
- `osascript -e 'id of app "Google Chrome"'` asks LaunchServices via Apple
  events and can trigger the Automation TCC prompt ("Terminal wants to control
  Google Chrome"), which is a visible dialog on the person's screen. Forbidden
  in Orbit.
- `defaults read` on a browser's domain reads preferences, not install location,
  and can create a `cfprefsd` cache entry. Not useful here.

---

## 5. Cookie encryption on macOS

### 5.1 What the Keychain item is

From `components/os_crypt/common/keychain_password_mac.mm` **[documented,
Chromium source, current HEAD]**:

```
#if BUILDFLAG(GOOGLE_CHROME_BRANDING)
const char kDefaultServiceName[] = "Chrome Safe Storage";
const char kDefaultAccountName[] = "Chrome";
#else
const char kDefaultServiceName[] = "Chromium Safe Storage";
const char kDefaultAccountName[] = "Chromium";
#endif
```

So the item is a **generic password** with:

- service (`kSecAttrService`) = `"<Product> Safe Storage"`
- account (`kSecAttrAccount`) = `"<Product>"`

This is the macOS analogue of the Linux libsecret item Orbit already models
(`Chrome Safe Storage`, application attribute `chrome`). Same name, different
store, and on macOS the account attribute plays the role the Linux application
attribute plays.

Per fork (all **[observed]**, from `browser_cookie3`, but they follow the same
`"<Product> Safe Storage"` / `"<Product>"` template from the Chromium source):

| Browser | Keychain service | Keychain account |
|---|---|---|
| Google Chrome (all channels) | `Chrome Safe Storage` | `Chrome` |
| Chromium | `Chromium Safe Storage` | `Chromium` |
| Microsoft Edge | `Microsoft Edge Safe Storage` | `Microsoft Edge` |
| Brave | `Brave Safe Storage` | `Brave` |
| Vivaldi | `Vivaldi Safe Storage` | `Vivaldi` |
| Opera and Opera GX | `Opera Safe Storage` | `Opera` |
| Arc | `Arc Safe Storage` | `Arc` |

Note that Chrome Beta/Dev/Canary all share the single `Chrome Safe Storage` item
**[observed]**: the service name is a compile time constant selected by branding,
not by channel. This is a meaningful difference from the user data dir, which
*is* per channel.

Read it from the shell (this **will** prompt, see below):

```
security find-generic-password -ws "Chrome Safe Storage" -a "Chrome"
```

### 5.2 Who owns the ACL and does another binary get a dialog

Yes, and this is the central macOS fact for Orbit.

Apple documents the mechanism **[documented, Apple Developer "Access Control
Lists"]**:

> When an app attempts to access a keychain item for a particular purpose ... the
> system checks whether the calling app is among the entry's trusted apps. If so,
> the system grants access. Otherwise, **the system prompts the user for
> confirmation**. The user may choose to Deny, Allow, or Always Allow the access.

The item is created by Chrome itself. `KeychainPassword::GetPassword()` calls
`FindGenericPassword`, and when that returns `errSecItemNotFound` it calls
`AddRandomPasswordToKeychain`, which generates 128 bits of randomness, base64
encodes it, and calls `keychain.AddGenericPassword(service, account, password)`
**[documented, keychain_password_mac.mm]**. `KeychainV2::AddGenericPassword`
ends in `SecItemAdd` **[documented, crypto/apple/keychain_v2.mm]**. An item
created by `SecItemAdd` has an ACL whose sole trusted application is the
creating process, i.e. the Chrome binary's code signature. Therefore:

- **Chrome reading its own item: no prompt.**
- **Any other binary (including `/usr/bin/security`, a Node process, a Bun
  process, an Orbit helper) reading it: a modal Keychain dialog appears on the
  person's screen** asking to allow access, and if the login keychain password is
  required the dialog blocks until answered.

The Chromium project's own workaround confirms the ACL model from the other
direction: the Telemetry test bot setup doc tells you to delete and recreate the
item with `security add-generic-password ... -A`, where `-A` means "allow access
by any application", specifically so that automated runs stop being prompted
**[documented, chromium.org "Telemetry Mac Keychain Setup"]**:

```
security delete-generic-password -s "Chromium Safe Storage" login.keychain
security add-generic-password -a Chromium -w "+NTclOvR4wLMgRlLIL9bHQ==" -s "Chromium Safe Storage" -A login.keychain
```

The existence of that documented workaround is the primary source proof that
without it, another binary requesting the item raises a user dialog.

**Implication for Orbit: never read the Safe Storage item.** A modal Keychain
dialog on the person's screen is exactly the class of interruption Orbit exists
to prevent. Orbit must not decrypt the person's cookies on macOS, full stop.

### 5.3 What happens with a fresh `--user-data-dir`

This is where macOS differs sharply from Windows.

- The Safe Storage item is keyed on the **product**, not on the user data
  directory. `GetServiceName()` returns a process wide static initialised from a
  compile time constant, with no reference to the profile path
  **[documented, keychain_password_mac.mm]**.
- So launching Chrome with a brand new `--user-data-dir` does **not** create a
  second Keychain item. It reuses the same `Chrome Safe Storage` item.
- Because the caller is still the same Chrome binary with the same signature, the
  ACL is satisfied, so **no prompt**.
- If the item does not exist at all (fresh macOS account, Chrome never run),
  Chrome creates it via `SecItemAdd`. Creating a new generic password does not
  prompt: the creating process is implicitly the owner. **[documented by the ACL
  model; verify on Mac]**

Consequence: unlike Windows, where App Bound Encryption rejects a non default
user data directory and Orbit must refuse profile clones, **macOS has no
equivalent barrier**. A clean `--user-data-dir` under Orbit's control works, and
a launched Chrome will happily use the shared Keychain key to encrypt cookies in
that new directory. Orbit still should not clone the person's profile on macOS,
but for a different reason: the copied `Cookies` file would be decryptable by the
same key, which means an Orbit session would carry the person's live logins. That
is a policy decision, not a technical block.

### 5.4 Is there a v10 obfuscation fallback on macOS

**No.** This differs from Linux and needs to be encoded correctly.

On **Linux**, `components/os_crypt/async/browser/posix_key_provider.cc` contains
**[documented]**:

```
constexpr char kEncryptionTag[] = "v10";
// PBKDF2-HMAC-SHA1(1 iteration, key = "peanuts", salt = "saltysalt")
```

That is the hardcoded obfuscation key used when no keyring is available. It is
why Linux cookie decryption works without a keyring.

On **macOS**, `os_crypt_mac.mm` has no such fallback **[documented, Chromium
source, tag 120.0.6099.109]**:

```
crypto::SymmetricKey* OSCryptImpl::GetEncryptionKey() {
  ...
  crypto::AppleKeychain keychain;
  KeychainPassword encryptor_password(keychain);
  password = encryptor_password.GetPassword();
  key_is_cached_ = true;
  if (password.empty())
    return cached_encryption_key_.get();   // still null
  ...
}
```

and `EncryptString` / `DecryptString` simply bail:

```
crypto::SymmetricKey* encryption_key = GetEncryptionKey();
if (!encryption_key)
  return false;
```

The `"v10"` string does exist on macOS, but it is only the **ciphertext version
prefix** (`constexpr char kEncryptionVersionPrefix[] = "v10";`, inserted at the
front of the ciphertext), not a fallback key. The async path repeats the same
constants (`kKeyTag = "v10"`, salt `"saltysalt"`, 1003 iterations, 16 byte
derived key, AES-128-CBC) and on keychain failure returns
`KeyProvider::KeyError::kTemporarilyUnavailable` rather than a fallback key
**[documented, `keychain_key_provider.mm`]**.

So on macOS: no keychain access means **no encryption and no decryption**, not
weak encryption. Do not port the Linux "peanuts" fallback into macOS code paths.

macOS key derivation, for reference: `PBKDF2-HMAC-SHA1(password =
<keychain item>, salt = "saltysalt", iterations = 1003, dkLen = 16)`, then
AES-128-CBC with a 16 byte IV of spaces, ciphertext prefixed with `v10`
**[documented, os_crypt_mac.mm and keychain_key_provider.mm]**.

---

## 6. Headless Chrome on macOS versus Linux

### 6.1 `--headless=new`

Same as Linux. `--headless` and `--headless=new` both select new Headless from
Chrome 132 onward; `--headless=old` prints an error and does nothing, and old
headless now only exists as the separate `chrome-headless-shell` binary
**[documented, Chrome for Developers "Removing --headless=old from Chrome",
and Chromium `headless/README.md`: "As of M132, headless shell functionality is
no longer part of the Chrome binary, so --headless=old has no effect"]**.

Orbit should pass plain `--headless=new` on macOS, identically to Linux, and
should not attempt `--headless=old`.

Note that Chrome's own macOS documentation example is
`open -a "Google Chrome" --args --headless` **[documented, Chrome for
Developers]**. Orbit must **not** use that form: `open` routes through
LaunchServices and will activate or reuse the person's running Chrome. Launch the
inner Mach-O directly instead (see 6.4).

### 6.2 Must the bundle be codesign valid to run

No, not strictly, but the practical answer is yes.

- macOS on Apple Silicon requires every executable to carry *some* signature, at
  minimum ad hoc. An entirely unsigned arm64 Mach-O is killed at exec time.
  On Intel this does not apply **[observed, well established]**.
- If the signature is *broken* (bundle contents modified after signing), the
  bundle can still exec on Intel, but code signing enforcement, the hardened
  runtime, and any library validation in the bundle will misbehave, and Chrome's
  helper processes will fail to launch. In practice a Chrome bundle with a broken
  seal does not run usefully.
- Gatekeeper is a separate layer that applies to *first launch of quarantined
  code*, not to every exec (section 6.3).

Orbit should run `codesign --verify --strict` before first use of a discovered
bundle and refuse a failing bundle, both as an integrity check and to avoid
producing a confusing crash later.

### 6.3 Quarantine and Gatekeeper on first launch

Apple **[documented, Apple Platform Security, "Gatekeeper and runtime protection
in macOS"]**:

> When a user downloads and opens an app ... from outside the App Store,
> Gatekeeper verifies that the software is from an identified developer, is
> notarized by Apple to be free of known malicious content, and hasn't been
> altered. **Gatekeeper also requests user approval before opening downloaded
> software for the first time** ... When necessary, Gatekeeper opens apps from
> randomized, read-only locations.

Two practical consequences for Orbit:

1. **The approval dialog.** A browser that the person downloaded but has never
   opened carries the `com.apple.quarantine` extended attribute and its first
   launch produces a modal dialog. Orbit must never be the thing that triggers
   that dialog. Detect the attribute first and skip such a bundle:

   ```
   xattr -p com.apple.quarantine "/Applications/Some Browser.app"
   ```

   Exit 0 with a value like `0081;65f0a1b2;Safari;<uuid>` means quarantined.
   A non zero exit (`No such xattr`) means the quarantine bit is gone, which in
   turn means the app has already been approved and opened by the person at least
   once. That is exactly the precondition Orbit wants before it launches anything.

   Orbit should **not** call `xattr -d -r com.apple.quarantine <bundle>` to clear
   it. Stripping quarantine from the person's applications is a security relevant
   modification of their system that the person did not ask for. Report "this
   browser has never been opened, open it once yourself" instead.

2. **App translocation / Gatekeeper path randomisation.** The "randomized,
   read-only locations" clause: a quarantined app run from `~/Downloads` or a
   mounted DMG is executed from a randomised read only mount point, so its real
   path is not the path you found, the bundle is read only, and sibling files are
   not visible to it. This is another reason to accept only `/Applications` and
   `~/Applications` and to reject `/Volumes/` outright.

Neither of these has any Linux analogue. On Linux Orbit can exec
`/opt/google/chrome/chrome` the moment it exists; on macOS the existence of a
bundle does not imply it is launchable without a dialog.

### 6.4 Launching the inner Mach-O directly vs `open`

Launch this:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new \
  --remote-debugging-port=0 \
  --user-data-dir=/private/tmp/orbit-<id> \
  --no-first-run --no-default-browser-check
```

Not this:

```
open -na "Google Chrome" --args ...
```

Why direct exec is correct for Orbit:

- `open` hands the request to LaunchServices, which applies the app's singleton
  and activation semantics: it will focus, and by default reuse, the person's
  already running Chrome. `open -n` forces a new instance but still goes through
  LaunchServices and still activates a GUI app on the person's desktop. Both
  violate Orbit's rule that nothing may touch the person's screen.
- `posix_spawn`/`exec` of the inner binary does not involve LaunchServices at
  all. The process is an ordinary child of the Orbit broker, with its own stdio,
  its own process group, and no Dock/activation behaviour beyond what the app
  itself requests. Chromium's own build docs run the binary this way:
  `out/Default/Chromium.app/Contents/MacOS/Chromium` **[documented, Chromium
  `mac_build_instructions.md`]**, and every automation stack (Puppeteer,
  Playwright, chrome-launcher) spawns the inner binary path rather than `open`
  **[documented, their source]**.

The Chrome *process singleton* is a separate mechanism from LaunchServices and is
**not** bypassed by direct exec: it is keyed on the user data directory. On POSIX
Chromium implements it with a socket plus a `SingletonLock` symlink inside the
user data dir **[documented, `chrome/browser/process_singleton_posix.cc` header
comment]**, and on macOS `process_singleton_mac.mm` is built in addition to
`process_singleton_posix.cc` (`chrome/browser/BUILD.gn` adds
`process_singleton_mac.mm` for `is_mac` and `:process_singleton_posix` for
`!is_win`) **[documented]**; the mac specific file only handles forwarding
`GetURL` Apple events. Practical rule, identical on Linux and macOS: **a unique
`--user-data-dir` per Orbit session gives a genuinely separate browser process**,
and a stale `SingletonLock` in a reused directory is a known failure source
(Chromium issue 40275248 on new headless + existing user data dir).

macOS specific extras worth encoding:

- Use a user data dir under `/private/tmp` or the session's own directory, not
  `$TMPDIR` blindly: `$TMPDIR` on macOS is a per user path under
  `/var/folders/...` which is fine, but it is also subject to periodic cleanup.
- Pass `--no-first-run --no-default-browser-check --disable-features=Translate`
  to avoid any UI or prompt.
- Do not pass `--user-data-dir` pointing anywhere under
  `~/Library/Application Support/Google` or any real browser's dir.
- macOS has no `--no-sandbox` requirement; do not disable the sandbox.
- A headless Chrome still registers as a GUI capable process; keep
  `LSUIElement` concerns out of scope by relying on `--headless=new`, which does
  not create windows or a Dock icon.

---

## 7. Which of these are bad Orbit defaults

Ranked, with reasons.

**Preferred, in order:**

1. **Chrome for Testing** (`Google Chrome for Testing.app`) when present. Built
   for automation, version pinned, no auto update mid session, no Keystone, and
   its own user data dir namespace. If Orbit ships or fetches a browser on macOS,
   this is the one.
2. **Google Chrome** stable. Best CDP fidelity, the reference implementation, and
   the one Chromium docs describe.
3. **Chromium**. Same engine, no branding, no Keystone. The `CrProductDirName`
   default is `Chromium`, so profile isolation is clean.
4. **Microsoft Edge**. A close Chromium fork, CDP works, and Playwright supports
   it as a first class channel **[documented, Playwright registry]**. Acceptable
   fallback.

**Usable but not a default:**

5. **Brave**. Chromium fork, CDP works (many tools drive it). Downsides: Shields
   and its ad blocker change page behaviour and network requests in ways that
   make automation results non representative; Brave also has its own Tor and
   Rewards subsystems that can start background work. Fine if the person asks for
   Brave, wrong as an automatic choice.
6. **Vivaldi**. Chromium fork, CDP works. Heavy custom UI layer built in JS on
   top of the browser, and the inner executable name does not match the bundle
   name for the Snapshot channel, which is an easy source of detection bugs.
   Small user base, low value as a default.

**Avoid as defaults:**

7. **Opera and Opera GX**. Chromium under the hood and CDP has been reported to
   work, but: the profile layout is flattened (no `Default` directory), the
   product uses a non standard Application Support naming scheme keyed on the
   bundle id, Opera GX ships an aggressive custom UI and resource limiter, and
   Opera bundles a built in VPN proxy that changes egress behaviour. Too many
   ways to produce misleading results. Only use if explicitly requested.
8. **Arc**. This is the strongest "do not default to it" case:
   - Arc is in maintenance mode at The Browser Company / Atlassian; the
     automation surfaces are frozen **[observed, Arc tooling README]**.
   - Arc **crashes when a tab is created programmatically** via
     `Target.createTarget`, which is what `browser.newPage()` triggers in
     Puppeteer. The community CDP tools fork `chrome-devtools-mcp` specifically
     to work around this by reusing an existing blank tab **[observed,
     multiple independent Arc MCP forks state this]**. That makes it unfit for a
     generic agent driver.
   - Arc's core concepts (Spaces, Little Arc) are invisible to CDP.
   - Arc has no documented headless mode.
   - Its user data dir has an extra `User Data` level, unlike every other entry
     in the table.

**Not Chromium at all, must be excluded by the detector rather than "tried":**

- Safari (`com.apple.Safari`): WebKit. No CDP. Its remote automation is
  `safaridriver` plus the WebKit inspector protocol, and enabling it requires
  `safaridriver --enable` with an admin authorisation prompt. Never in scope.
- Firefox (`org.mozilla.firefox`): Gecko. CDP support was removed; it speaks
  WebDriver BiDi. Playwright lists it under a separate BiDi channel
  **[documented, Playwright registry]**. Not a Chromium fallback.
- Orion, Zen, and other WebKit or Gecko reskins: not Chromium, exclude.

**Detector rule:** decide Chromium family membership by the presence of
`CrProductDirName` in `Info.plist` **or** a known bundle id from the table, then
confirm by `codesign` team id, and only then by path. Do not infer "Chromium" from
the app's name.

---

## 8. Suggested detection order for the macOS implementation

1. Honour an explicit override (`ORBIT_BROWSER_PATH` or config). Validate it is a
   file, executable, and inside a `.app` bundle.
2. Probe the literal paths from section 1, `/Applications` before
   `$HOME/Applications`, in the preference order from section 7.
3. For each hit, read `Contents/Info.plist` once via `plutil -convert json -o -`
   and extract `CFBundleIdentifier`, `CFBundleExecutable`,
   `CFBundleShortVersionString`, `CrProductDirName`.
4. Rebuild the executable path from `CFBundleExecutable` rather than trusting the
   probe path's trailing component.
5. Reject if `com.apple.quarantine` is present (`xattr -p`), with a message
   telling the person to open the app once themselves.
6. Reject if `codesign --verify --strict` fails.
7. Optionally run `mdfind -onlyin /Applications "kMDItemCFBundleIdentifier == '<id>'"`
   to discover installs at non canonical paths. Never `lsregister`, never `open`,
   never `osascript`.
8. Record the owned user data dir as
   `~/Library/Application Support/<CrProductDirName>` for the "do not touch this"
   list, and note that Opera has no `Default` subdirectory and Arc has an extra
   `User Data` level.
9. Launch the inner Mach-O directly with a per session `--user-data-dir`,
   `--headless=new`, `--remote-debugging-port=0`.
10. Never read the `<Product> Safe Storage` Keychain item. Never clone the
    person's profile. On macOS there is no App Bound Encryption to stop you, so
    the refusal has to be Orbit's own policy.

---

## 9. Open items a real Mac would settle

- Exact `CFBundleIdentifier` strings for the Chrome Beta / Dev / Canary, Edge
  Beta / Dev / Canary, Brave Beta / Nightly, Vivaldi, and Opera GX bundles.
  Command: `plutil -extract CFBundleIdentifier raw -o - "<bundle>/Contents/Info.plist"`.
- Whether Opera and Opera GX really lack a `Default` subdirectory on current
  versions. Command: `ls "$HOME/Library/Application Support/com.operasoftware.Opera"`.
- Arc's `CrProductDirName` value, to confirm the `Arc/User Data` shape comes from
  the plist rather than from a hardcoded path in Arc's own code.
- Google's current Team ID as seen in `codesign -dv --verbose=4` on a shipping
  Chrome (`EQHXZ8M8AV` is the long standing value but was not verified here).
  Brave's `KL8N8XSYF4` is confirmed from brave-core `BRANDING`.
- Whether creating a brand new `Chrome Safe Storage` item on a fresh account is
  genuinely silent. Predicted silent from the ACL model, not observed.
