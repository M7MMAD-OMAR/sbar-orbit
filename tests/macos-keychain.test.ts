import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { darwinChromeArguments } from "../src/chrome";

/**
 * The Keychain switches, asserted on the list the process is actually handed.
 *
 * Two kinds of test, split for the reason `tests/macos.test.ts` states. The argv assertions are pure
 * and run on every host including this Fedora workstation, because they are the ones that catch the
 * defect that matters: a launch path on darwin that forgets `--use-mock-keychain` raises a modal
 * dialog on a person's screen, and a test that only runs on a Mac would not have caught it here.
 * Everything that asks the real Keychain is darwin only and SKIPPED elsewhere, because a skip is not
 * a pass and `docs/support-tiers.md` counts them separately.
 *
 * `docs/windows-measured.md` records the trap this file is written against: `windowsChromeArguments`
 * existed, was tested, and was called by nothing, so the suite asserted the containment flags of a
 * list the browser never saw. So the last test here reads `src/chrome.ts` and proves the darwin
 * branch calls the builder these assertions are about.
 */

const darwinOnly = (reason: string) => {
  if (!reason.trim()) throw new Error("A darwin only test has to say why");
  return process.platform === "darwin" ? test : test.skip;
};

const sourceOf = (file: string) => readFile(join(import.meta.dir, "..", "src", file), "utf8");

/** The prefix `launchChrome` builds for every platform, rebuilt here only as an input to the builder. */
const common = (profile: string) => [`--user-data-dir=${profile}`, "--headless", "--remote-debugging-port=0",
  "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-background-networking"];

test("the macOS browser command line carries both Keychain switches", () => {
  const argv = darwinChromeArguments("/tmp/session", common("/tmp/session"));
  // The one that matters most. `os_crypt_switches.h` documents it as existing to prevent blocking
  // dialogs, and `keychain_password_mac.mm` looks the key up by compile time constants, so a fresh
  // --user-data-dir does NOT give a fresh item: without this switch an Orbit launch reaches for the
  // person's own `Chrome Safe Storage` item and a binary off its ACL raises a modal on their screen.
  expect(argv).toContain("--use-mock-keychain");
  // The second line of defence behind it.
  expect(argv).toContain("--password-store=basic");
});

test("every option shape a macOS launch can take still carries both switches", () => {
  // Extensions on and off, extra arguments present and absent: four shapes, because a flag that
  // survives the default path and is dropped by a branch is still a dialog on a person's screen.
  const shapes = [
    darwinChromeArguments("/tmp/a", common("/tmp/a")),
    darwinChromeArguments("/tmp/b", common("/tmp/b"), [], { extensions: true }),
    darwinChromeArguments("/tmp/c", common("/tmp/c"), ["--proxy-server=http://127.0.0.1:1"]),
    darwinChromeArguments("/tmp/d", common("/tmp/d"), ["--proxy-server=http://127.0.0.1:1"], { extensions: true }),
  ];
  for (const argv of shapes) {
    expect(argv).toContain("--use-mock-keychain");
    expect(argv).toContain("--password-store=basic");
  }
});

test("a caller cannot turn the Keychain switches off through the arguments it is allowed to add", () => {
  // `extraArgs` is caller controlled: the egress lease uses it. Chromium takes the LAST occurrence of
  // a switch, so an extra `--password-store=gnome-libsecret` appearing after ours would win.
  //
  // The first version of this test passed `--disable-gpu` and asserted the result, which attacks
  // nothing: it proved a harmless argument is harmless. Measured against the builder as it then
  // stood, the real attack got through, producing
  // `[--password-store=basic, --password-store=gnome-libsecret]` with the hostile one LAST and
  // therefore the one obeyed. The defence lived only in this comment. It is now in the builder, so
  // these are the arguments an attacker would actually send.
  const hostile = darwinChromeArguments("/tmp/e", common("/tmp/e"),
    ["--disable-gpu", "--password-store=gnome-libsecret", "--use-mock-keychain"]);
  const stores = hostile.filter(argument => argument.startsWith("--password-store="));
  // Exactly one store, and it is Orbit's. Not "contains ours", which the vulnerable shape satisfied.
  expect(stores).toEqual(["--password-store=basic"]);
  // And the last occurrence is what Chromium obeys, so state that directly rather than by counting.
  expect(stores.at(-1)).toBe("--password-store=basic");
  expect(hostile.filter(argument => argument === "--use-mock-keychain")).toHaveLength(1);
  // The caller's legitimate argument survives: this filters two switches, it does not censor extras.
  expect(hostile).toContain("--disable-gpu");
});

test("the Keychain switches come after anything a caller adds, because the last one wins", () => {
  // The property the filter exists to guarantee, asserted on ORDER rather than on membership. A
  // future edit that re-adds the switches before `extra` would keep every membership assertion above
  // green while restoring the defect.
  const argv = darwinChromeArguments("/tmp/g", common("/tmp/g"), ["--proxy-server=http://127.0.0.1:1"]);
  const mock = argv.indexOf("--use-mock-keychain");
  const store = argv.indexOf("--password-store=basic");
  const caller = argv.indexOf("--proxy-server=http://127.0.0.1:1");
  expect(caller).toBeGreaterThan(-1);
  expect(mock).toBeGreaterThan(caller);
  expect(store).toBeGreaterThan(caller);
});

test("the macOS launch also keeps the two other switches that exist to leave the person alone", () => {
  const argv = darwinChromeArguments("/tmp/f", common("/tmp/f"));
  // Crashpad double forks and calls setsid(), so it outlives the group and the sweep misses it.
  expect(argv).toContain("--disable-crash-reporter");
  // Cast discovery raises a Local Network alert on macOS 15 and later, attributed to Google Chrome,
  // on the person's screen. Same class of interruption as the Keychain dialog.
  expect(argv).toContain("--disable-features=MediaRouter");
  // The cache goes inside the session profile, never ~/Library/Caches/Google/Chrome.
  expect(argv).toContain(`--disk-cache-dir=${join("/tmp/f", "cache")}`);
});

test("the darwin launch path calls this builder rather than building a second list beside it", async () => {
  // The `windowsChromeArguments` lesson, asserted rather than trusted: a builder nothing calls is a
  // test standing over nothing. If this ever fails because the launcher inlined its list again, the
  // assertions above have stopped describing the browser Orbit starts.
  const chrome = await sourceOf("chrome.ts");
  expect(chrome).toContain("darwinChromeArguments(profile, common, options.extraArgs ?? []");
  // And the switches appear in the builder, not as a second literal inside the darwin branch of
  // `launchChrome`. This counted occurrences of the string and read 1, which was right until the
  // builder gained a guard that filters a caller's own `--use-mock-keychain` before re-adding
  // Orbit's last. That is a second mention inside the same function and not a second list, so the
  // guard is EXTENDED to see it rather than relaxed: the occurrences must all be inside the
  // builder, and the darwin branch of `launchChrome` must carry none.
  const builder = chrome.slice(chrome.indexOf("export function darwinChromeArguments"),
    chrome.indexOf("/** Own Chrome separately"));
  const inBuilder = (builder.match(/"--use-mock-keychain"/g) ?? []).length;
  const inFile = (chrome.match(/"--use-mock-keychain"/g) ?? []).length;
  expect(inBuilder).toBeGreaterThan(0);
  expect(inFile).toBe(inBuilder);
});

test("the Linux and Windows launch paths are unaffected by the macOS switch", async () => {
  // --use-mock-keychain on Linux would break the profile clone path, which decrypts against the real
  // keyring. It belongs on darwin and nowhere else.
  const { windowsChromeArguments } = await import("../src/windows-job");
  expect(windowsChromeArguments("C:\\orbit\\session")).not.toContain("--use-mock-keychain");
  const chrome = await sourceOf("chrome.ts");
  // The Linux branch still selects a store by option rather than being pinned to the macOS answer.
  expect(chrome).toContain("`--password-store=${options.passwordStore ?? \"basic\"}`");
});

/**
 * The measurement itself lives in `experiments/macos-keychain.ts` and needs a real Mac. These pin the
 * contract between the two, so a report that no longer measures what it claims fails here rather than
 * in a document six weeks later.
 */
test("the macOS Keychain experiment measures the argv the kernel reports, not the builder's return value", async () => {
  const experiment = await readFile(join(import.meta.dir, "..", "experiments", "macos-keychain.ts"), "utf8");
  // The kernel's view. A builder asserting about itself proves nothing about the process.
  expect(experiment).toContain("/bin/ps");
  // Both arms come from the same builder, so the only difference between them is the two switches.
  expect(experiment).toContain("darwinChromeArguments");
  expect(experiment).toContain("argument !== \"--use-mock-keychain\"");
  // The item is read WITHOUT its secret: no -g, and the only -w is against an item this experiment
  // created itself. A measurement that printed a person's key would be a worse defect than the one
  // it is measuring.
  expect(experiment).not.toContain("find-generic-password\", \"-g\"");
  // And the limit is stated in the report rather than left to a reader.
  expect(experiment).toContain("no runner shows");
});

darwinOnly("the Chrome Safe Storage item only exists on a Mac")(
  "the Safe Storage item is readable as attributes without consulting its ACL", async () => {
    // The observation the experiment's before and after readings depend on. Attributes are not behind
    // the ACL, so this call cannot itself be the thing that raises a dialog. Exit 0 or 44 (item not
    // found) are both correct; anything else means the attribute read is not the cheap observation
    // the experiment assumes it is.
    const child = Bun.spawn(["/usr/bin/security", "find-generic-password", "-s", "Chrome Safe Storage"],
      { stdout: "pipe", stderr: "pipe" });
    const code = await child.exited;
    expect([0, 44]).toContain(code);
  });

darwinOnly("reading a real browser's command line needs a real browser")(
  "a launched macOS browser carries the switches in the kernel's own view of its argv", async () => {
    const { mkdtemp, rm, readFile: read } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { launchChrome } = await import("../src/chrome");
    const { processGroupMembers } = await import("../src/macos");
    const profile = await mkdtemp(join(tmpdir(), "orbit-keychain-test-"));
    try {
      const session = await launchChrome(profile);
      const owner = JSON.parse(await read(join(profile, "owner.json"), "utf8")) as { pgid: number };
      const lines: string[] = [];
      for (const pid of processGroupMembers(owner.pgid).pids) {
        const ps = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
        const text = (await new Response(ps.stdout).text()).trim();
        if (await ps.exited === 0 && text) lines.push(text);
      }
      await session.close().catch(() => {});
      const ours = lines.filter(line => line.includes(profile));
      expect(ours.length).toBeGreaterThan(0);
      // The BROWSER process, which is the one without a `--type=`. Measured on a macOS 26.6.2 arm64
      // runner: of 10 processes in the group, 2 carry the switch and 8 do not, and the 8 are
      // renderers, the GPU process and utilities. That is correct and this assertion was WRONG
      // before it ran on a Mac: it demanded the switch on every process naming the profile, and
      // renderers inherit `--user-data-dir` while never touching OSCrypt, so it failed against a
      // perfectly contained browser. The switch belongs on the process that reads the Keychain.
      const browserProcess = ours.find(line => !line.includes("--type="));
      expect(browserProcess).toBeDefined();
      expect(browserProcess!).toContain("--use-mock-keychain");
      expect(browserProcess!).toContain("--password-store=basic");
      // And no process in the tree carries a CONTRADICTING store, which is the way the guarantee
      // could be lost without the browser process itself losing its switch.
      for (const line of ours) expect(line).not.toContain("--password-store=gnome-libsecret");
    } finally {
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  }, 120000);
