# Sbar Orbit on macOS 13+: autostart, private storage, unix sockets, filesystem paths

Scope: a Bun/TypeScript CLI plus a long lived broker daemon, installed by a normal
user, no root, no signed installer or notarized app bundle, no TCC prompt allowed.
Target macOS 13 Ventura and later, Apple silicon and Intel.

Every claim is labelled:

* **[DOC]** stated in an Apple man page, Apple developer document, or XNU header.
* **[SRC]** read directly out of open source Apple code (XNU headers, shell_cmds).
* **[REP]** widely reported behaviour from non Apple sources, needs a one line check
  on real hardware before shipping.
* **[INFER]** a conclusion this report draws from the above, not itself a citation.

Nothing here was executed on a Mac. The research host is Fedora Linux. Every
"verify on hardware" item is called out in section 10.

---

## 0. The short answer, for the impatient implementer

| Linux thing | macOS equivalent Orbit should use |
|---|---|
| `systemd --user` unit | LaunchAgent plist at `~/Library/LaunchAgents/com.sbarah.orbit.broker.plist`, loaded with `launchctl bootstrap gui/$(id -u)` |
| `loginctl enable-linger` | **Does not exist.** No supported unprivileged way to keep a per user agent running with nobody logged in. See section 1.6 |
| `$XDG_RUNTIME_DIR/sbar-orbit/broker.sock` | `$(getconf DARWIN_USER_TEMP_DIR)sbar-orbit/broker.sock`, i.e. `/var/folders/xx/<28 chars>/T/sbar-orbit/broker.sock` |
| `SO_PEERCRED` | `getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, &xucred, &len)`. **Not reachable from Bun**, so fall back to a 0700 parent directory plus a 0600 socket |
| `$XDG_STATE_HOME`, `$XDG_DATA_HOME` | `~/Library/Application Support/com.sbarah.orbit/` |
| `$XDG_CACHE_HOME` | `~/Library/Caches/com.sbarah.orbit/` |
| journald | `~/Library/Logs/com.sbarah.orbit/` via `StandardOutPath` and `StandardErrorPath` |
| `~/.local/bin` on PATH | `~/.local/bin` works but is **not** on the default macOS PATH; the installer must add it and say so |
| `rename()` over a symlink | Same POSIX semantics, atomic, unprivileged. Unlike Windows, no pointer file hack needed |
| reflink copy | `clonefile(2)` or `cp -c`, APFS only, same volume only |

---

## 1. launchd LaunchAgents

### 1.1 Where the file goes and who owns it

**[DOC]** `launchd.plist(5)`, FILES section:

```
~/Library/LaunchAgents          Per-user agents provided by the user.
/Library/LaunchAgents           Per-user agents provided by the administrator.
/Library/LaunchDaemons          System-wide daemons provided by the administrator.
/System/Library/LaunchAgents    Per-user agents provided by OS X.
/System/Library/LaunchDaemons   System-wide daemons provided by OS X.
```

Only the first of these is writable without root, so it is the only option for Orbit.

**[DOC]** `launchd.plist(5)`: "it is the expected convention for launchd property list
files to be named `<Label>.plist`. Thus, if your job label is `com.apple.sshd`, your
plist file should be named `com.apple.sshd.plist`."

**[DOC]** `launchctl(1)`, legacy `load` subcommand text, which still describes the
on disk requirement: "per-user configuration files (LaunchAgents) must be owned by
the user loading them ... Configuration files must not be group- or world-writable."

So: owner is the installing user, mode `0644`. **[INFER]** Write the file with
`Bun.write` then `chmod 0o644` explicitly, because the process umask is not
guaranteed and a `0664` file is rejected.

### 1.2 The exact plist

Label `com.sbarah.orbit.broker`, file
`~/Library/LaunchAgents/com.sbarah.orbit.broker.plist`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.sbarah.orbit.broker</string>

    <key>ProgramArguments</key>
    <array>
        <string>/Users/example/.local/share/sbar-orbit/current/bin/sbar-orbit</string>
        <string>serve</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>ExitTimeOut</key>
    <integer>20</integer>

    <key>WorkingDirectory</key>
    <string>/Users/example/Library/Application Support/com.sbarah.orbit</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/example/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>SBAR_ORBIT_SOCKET</key>
        <string>/var/folders/XX/YYYYYYYY/T/sbar-orbit/broker.sock</string>
        <key>SBAR_ORBIT_STATE_DIR</key>
        <string>/Users/example/Library/Application Support/com.sbarah.orbit</string>
    </dict>

    <key>StandardOutPath</key>
    <string>/Users/example/Library/Logs/com.sbarah.orbit/broker.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/example/Library/Logs/com.sbarah.orbit/broker.err.log</string>

    <key>ProcessType</key>
    <string>Background</string>

    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
</dict>
</plist>
```

Notes on each non obvious key.

* `ProgramArguments` **[DOC]** `launchd.plist(5)`: "The Program key must be an
  absolute path ... In the absence of the Program key, the first element of the
  ProgramArguments array may be either an absolute path, or a relative path which is
  resolved using `_PATH_STDPATH`." Always write an absolute path. Do not write
  `sbar-orbit` and hope PATH saves you. **[INFER]** `~` is not expanded by launchd,
  so the installer must template the literal home directory into the file.
* `RunAtLoad` **[DOC]** `launchd.plist(5)`: "controls whether your job is launched
  once at the time the job is loaded. The default is false. This key should be
  avoided, as speculative job launches have an adverse effect on system-boot and
  user-login scenarios." Apple dislikes it, but Orbit's broker must be listening
  before any agent CLI call, and Bun cannot consume launchd socket activation
  (section 2), so `RunAtLoad` is the honest choice.
* `KeepAlive` **[DOC]** `launchd.plist(5)`: "The default is false and therefore only
  demand will start the job. The value may be set to true to unconditionally keep the
  job alive. Alternatively, a dictionary of conditions may be specified ... If
  multiple keys are provided, launchd ORs them ... The use of this key implicitly
  implies RunAtLoad, causing launchd to speculatively launch the job."
  The dictionary form above means: restart if the broker exits non zero, restart if
  it crashed on a signal, do not restart after a clean `exit(0)`. That gives
  `sbar-orbit stop` a way to actually stop the broker. If you use `<true/>` instead,
  a clean exit is also restarted and there is no user visible stop.
* `ThrottleInterval` **[DOC]** `launchd.plist(5)`: "The value is in seconds, and by
  default, jobs will not be spawned more than once every 10 seconds." A crash loop is
  therefore rate limited to one respawn per 10 seconds by default; you cannot make it
  faster below 10 without setting this key, and setting it lower is discouraged.
* `ExitTimeOut` **[DOC]** `launchd.plist(5)`: "The amount of time launchd waits
  between sending the SIGTERM signal and before sending a SIGKILL signal when the job
  is to be stopped ... The value zero is interpreted as infinity and should not be
  used." The broker must install a SIGTERM handler and unlink the socket there.
* `LimitLoadToSessionType` **[DOC]** TN2083 Table 1 plus `launchd.plist(5)`: "This
  key only applies to jobs which are agents." Session types are `Aqua` (GUI login),
  `StandardIO` (non GUI, notably SSH logins), `Background` (per user context, parent
  of the others), `LoginWindow` (pre login). **[DOC]** TN2083: "If you don't specify
  the LimitLoadToSessionType property, launchd assumes a value of `Aqua`." **[DOC]**
  TN2083 also warns: "If you set LimitLoadToSessionType to an array, be aware that
  each instance of your agent runs independently", so do not list both `Aqua` and
  `Background` unless you want two brokers fighting over one socket.
* **[INFER]** Consider `<string>Background</string>` instead of `Aqua` if you want the
  broker to also exist in SSH-only sessions. But see 1.6: this does not give you
  lingering, and it changes the bootstrap domain you must target.

**[DOC]** `launchd.plist(5)` EXPECTATIONS: a launchd job "MUST NOT ... Call
`daemon(3)` ... Do the moral equivalent of `daemon(3)` by calling `fork(2)` and have
the parent process `exit(3)`". The Bun broker must run in the foreground under
launchd. Whatever daemonisation the Linux path does, the macOS path must not.

### 1.3 Modern launchctl subcommands

`launchctl(1)` since macOS 10.10 uses domain and service targets. Forms **[DOC]**:

```
system/[service-name]        privileged system domain, root required to modify
user/<uid>/[service-name]    per user domain; "A user domain may exist
                             independently of a logged-in user"
login/<asid>/[service-name]  user-login domain, created when the user logs in at
                             the GUI, keyed by audit session id
gui/<uid>/[service-name]     the same login domain, addressed by uid instead of asid
session/<asid>/...
pid/<pid>/...
```

The commands Orbit needs, all runnable without sudo for your own uid:

```sh
UID_NUM=$(id -u)
PLIST="$HOME/Library/LaunchAgents/com.sbarah.orbit.broker.plist"

# install / load
launchctl bootstrap gui/$UID_NUM "$PLIST"

# uninstall / unload  (either form)
launchctl bootout gui/$UID_NUM/com.sbarah.orbit.broker
launchctl bootout gui/$UID_NUM "$PLIST"

# start or force restart
launchctl kickstart -k gui/$UID_NUM/com.sbarah.orbit.broker
launchctl kickstart -p gui/$UID_NUM/com.sbarah.orbit.broker   # prints the pid

# status, the rough analogue of `systemctl --user status`
launchctl print gui/$UID_NUM/com.sbarah.orbit.broker
launchctl print gui/$UID_NUM                # everything in the domain

# persistent enable/disable, survives reboot
launchctl enable  gui/$UID_NUM/com.sbarah.orbit.broker
launchctl disable gui/$UID_NUM/com.sbarah.orbit.broker
launchctl print-disabled gui/$UID_NUM

# signal it
launchctl kill SIGTERM gui/$UID_NUM/com.sbarah.orbit.broker

# why did it start
launchctl blame gui/$UID_NUM/com.sbarah.orbit.broker
```

**[DOC]** `launchctl(1)` on `disable`: "Once a service is disabled, it cannot be
loaded in the specified domain until it is once again enabled. **This state persists
across boots of the device.**" This is the classic install failure: a user once ran
`disable`, and every later `bootstrap` fails until `enable` is run. **[REP]** The
documented dance is bootstrap, observe the "service is disabled" error, `enable`,
bootstrap again. **[INFER]** The Orbit installer should unconditionally run `enable`
before `bootstrap` and ignore its exit status.

**[DOC]** `launchctl(1)` on `print`: "IMPORTANT: This output is NOT API in any sense
at all. Do NOT rely on the structure or information emitted for ANY reason. It may
change from release to release without warning." **[INFER]** So `sbar-orbit status`
must determine broker liveness by connecting to the socket, not by parsing
`launchctl print`. Use `launchctl print` only to render a human hint when the connect
fails, and treat any parse failure as "unknown".

**[DOC]** `launchctl(1)` DEPRECATED AND REMOVED FUNCTIONALITY: `launchctl` has no
interactive mode, does not read stdin, and `/etc/launchd.conf` is gone. Also:
"launchd no longer uses Unix domain sockets for communication, so the
`LAUNCHD_SOCKET` environment variable is no longer relevant and is not set."

`load`/`unload` still work but are deprecated. **[REP]** They also have a service
cache bug where unloaded jobs reappear after reboot. Use bootstrap/bootout.

### 1.4 RunAtLoad versus KeepAlive, in one table

**[DOC]** TN2083 Table 5, updated for the modern keys:

| Desired behaviour | Keys |
|---|---|
| run when loaded and never quit | `KeepAlive = true` (implies RunAtLoad) |
| run purely on demand | `KeepAlive` absent/false, `RunAtLoad` absent/false |
| run once when loaded, then on demand | `RunAtLoad = true` |
| restart only on failure | `KeepAlive = { SuccessfulExit = false }` (implies RunAtLoad) |
| restart only on crash | `KeepAlive = { Crashed = true }` |

**[DOC]** `launchd.plist(5)`: `SuccessfulExit` "implies that RunAtLoad is set to true,
since the job needs to run at least once before an exit status can be determined."
That is why the plist above can keep `RunAtLoad` explicit and harmless.

**[DOC]** `launchd.plist(5)` on `EnablePressuredExit`: "launchd(8) does not respect
KeepAlive criteria for jobs which have opted into Pressured Exit" and such jobs
"ignore SIGTERM rather than exiting by default". Orbit must **not** set
`EnablePressuredExit` or `EnableTransactions`; they are for XPC services.

### 1.5 Logout, reboot, and whether an agent runs with nobody logged in

It does not. Three citations that jointly settle it:

1. **[DOC]** `launchctl(1)`, `gui/<uid>` and `login/<asid>` targets: "Targets a
   user-login domain or service within that domain. **A user-login domain is created
   when the user logs in at the GUI** and is identified by the audit session
   identifier associated with that login."
2. **[DOC]** TN2083, Agents: "A launchd agent is like a launchd daemon, except that it
   runs on behalf of a particular user. **It is launched by launchd, typically as part
   of the process of logging in the user.**" And Table 1 maps the default
   `LimitLoadToSessionType` value `Aqua` to "Has access to all GUI services; much like
   a login item."
3. **[DOC]** `launchd.plist(5)` FILES separates "Per-user agents" from "System-wide
   daemons", and the only system-wide directories are root owned.

Consequences, spelled out:

* **At logout**: the GUI login domain is torn down. The agent receives SIGTERM, then
  SIGKILL after `ExitTimeOut`. **[INFER]** The broker must clean up its socket in a
  SIGTERM handler and must also unlink a stale socket at startup, because SIGKILL
  leaves the socket file behind.
* **At reboot**: nothing from `~/Library/LaunchAgents` runs until somebody logs in at
  the GUI. There is no boot time execution for a per user agent.
* **At the next login**: launchd rescans `~/Library/LaunchAgents` and bootstraps the
  plist again automatically. **[INFER]** You do not need to re run `launchctl
  bootstrap` after every reboot; the directory scan is what makes the install
  persistent. The `enable`/`disable` override is stored outside the plist (**[DOC]**
  `launchd.plist(5)` on `Disabled`: "Previous Darwin operating systems would modify
  the configuration file's value for this key, but now this state is kept
  externally").
* **Over SSH, with nobody at the console**: `launchctl bootstrap gui/$UID ...` fails.
  **[REP]** The observed error is `Bootstrap failed: 125: Domain does not support
  specified action`, and legacy `launchctl load` fails with `Unload failed: 5:
  Input/output error`. **[INFER]** The installer must detect this and print a clear
  message: "log in at the Mac's desktop as this user and re run `sbar-orbit install`",
  rather than half installing.
* **Fast user switching**: each GUI login gets its own domain, so two switched in
  users each get their own broker. **[INFER]** The socket lives under the per user
  `$TMPDIR`, which is per uid, so they do not collide. Good.

### 1.6 The analogue of `loginctl enable-linger`

**There is none.** No per user, unprivileged, supported mechanism on macOS keeps a
LaunchAgent running while no user is logged in. Nothing in `launchctl(1)`,
`launchd.plist(5)` or TN2083 offers it. The options, all worse:

* **LaunchDaemon in `/Library/LaunchDaemons`.** Runs at boot, before and without any
  login. **[DOC]** `launchd.plist(5)` FILES calls it "System-wide daemons provided by
  the administrator"; the directory is root owned, so this needs `sudo`, which the
  brief excludes. `UserName` in the plist would drop it back to the user. **[DOC]**
  `launchd.plist(5)`: "This key is only applicable for services that are loaded into
  the privileged system domain ... Note that for agents, the UserName key is ignored."
* **`launchctl bootstrap user/$UID <plist>`.** The `user/<uid>` domain is the one the
  man page describes as one that "may exist independently of a logged-in user"
  **[DOC]**. **[REP]** Bootstrapping into it from a non root process is reported to
  fail; the per user domain is instantiated by login (GUI or PAM at SSH login), not by
  a bootstrap from an unprivileged shell. **Verify on hardware** before relying on it;
  if it does work for a non root caller it is still torn down when the last session
  for that uid ends, so it is not lingering.
* **Enable automatic login for the user** (System Settings, Users and Groups). Then a
  reboot lands in a GUI session and the agent starts. Requires a human once, weakens
  disk security, and is a policy decision for the user, not something an installer may
  do silently.
* **Keep the Mac logged in and awake.** Operationally what most people actually do.

**[INFER]** Ship the truth in the docs: on macOS the Orbit broker is alive exactly
while the user is logged in at the desktop. If a headless always on broker is a
product requirement, it needs a separate, explicitly root, LaunchDaemon install path,
and that is a different ticket.

### 1.7 PATH and environment variables

A LaunchAgent does **not** inherit your shell's environment. It does not read
`.zshrc`, `.zprofile`, `.zshenv`, `/etc/paths` or `path_helper`: none of those are
shell independent, they are shell startup files and launchd does not run a shell.

* **[DOC]** `launchd.plist(5)` on `ProgramArguments` says a relative first element is
  "resolved using `_PATH_STDPATH`". **[SRC]** `_PATH_STDPATH` in Darwin's
  `<paths.h>` is the classic BSD value, `/usr/bin:/bin:/usr/sbin:/sbin` (plus
  `/usr/local/bin` on some releases). **[INFER]** Treat the agent's PATH as
  "essentially `/usr/bin:/bin:/usr/sbin:/sbin`, and definitely without Homebrew,
  without `~/.local/bin`, and without any Bun install dir". Anything the broker spawns
  (a browser binary, `ffmpeg`, `bun` itself) must be resolved by absolute path or via
  an explicitly set PATH.
* **[DOC]** `launchd.plist(5)` `EnvironmentVariables`: "This optional key is used to
  specify additional environmental variables to be set before running the job. Each
  key in the dictionary is the name of an environment variable, with the corresponding
  value being a string ... NOTE: Values other than strings will be ignored." This is
  the right mechanism. Set `PATH`, and set Orbit's own variables here so the broker
  never has to guess.
* **[DOC]** `launchctl(1)` `setenv key value`: "Set an environmental variable inside
  of launchd", plus `unsetenv`, `getenv`, `export`. It mutates the running launchd
  user domain and is **not persistent** (`/etc/launchd.conf` and `~/.launchd.conf` are
  both gone, **[DOC]** `launchctl(1)` deprecations). **[INFER]** Never use
  `launchctl setenv PATH ...` from an installer: it is global to the user's whole
  launchd session and will surprise every other GUI app. Use `EnvironmentVariables`.
* **`TMPDIR`**: **[REP]** launchd sets `TMPDIR` for jobs to the per user Darwin temp
  directory, so `os.tmpdir()` inside the agent usually resolves correctly. Do not
  trust it: section 3.5 gives a call that works with or without the variable.

---

## 2. Socket activation with the `Sockets` key

**[DOC]** `launchd.plist(5)`, `Sockets` sub keys relevant to a unix socket:

```
SockPathName <string>
    This optional key implies SockFamily is set to "Unix". It specifies the
    path to connect(2) or bind(2) to.

SecureSocketWithKey <string>
    This optional key is a variant of SockPathName. Instead of binding to a
    known path, a securely generated socket is created and the path is
    assigned to the environment variable that is inherited by all jobs
    spawned in the job's context.

SockPathOwner <integer>   the uid that should own the socket
SockPathGroup <integer>   the gid
SockPathMode  <integer>   the mode. "Known bug: Property lists don't support
                          octal, so please convert the value to decimal."
```

So `0600` is written as `<integer>384</integer>` and `0700` as `<integer>448</integer>`.

A plist fragment, for the record:

```xml
<key>Sockets</key>
<dict>
    <key>Broker</key>
    <dict>
        <key>SockPathName</key>
        <string>/var/folders/XX/YYYYYYYY/T/sbar-orbit/broker.sock</string>
        <key>SockPathMode</key>
        <integer>384</integer>
    </dict>
</dict>
```

### Is it worth using? No.

**[DOC]** `launchd.plist(5)` EXPECTATIONS: a launchd job "MUST: check in for any
MachServices advertised in its plist ... check in for any LaunchEvents advertised in
its plist". The socket check in is done with `launch_activate_socket(3)`, a C
function that hands back an array of inherited file descriptors keyed by the
dictionary name ("Broker" above). There is no environment variable carrying the fd
number and no `LISTEN_FDS` convention as on systemd.

**[INFER]** Bun exposes no way to call `launch_activate_socket(3)` and no way to
construct a listening server from a pre existing inherited fd. `Bun.serve({unix})`
and `Bun.listen({unix})` both take a path and bind it themselves. Without an FFI shim
(`bun:ffi` calling into `libSystem`, plus a way to wrap the returned fd, which Bun
does not offer) socket activation is unreachable. Even with FFI the returned fd
cannot be handed to `Bun.serve`.

**Decision: bind the socket in the broker, exactly as on Linux.** Set `RunAtLoad`
plus `KeepAlive` so the broker is always up while the user is logged in, and do the
unlink-stale-then-bind-then-chmod dance in Orbit's own code. The only thing lost is
lazy start, which the Linux path also does not use since the systemd unit is not
socket activated.

One thing worth stealing from the `Sockets` design: `SockPathMode` proves Apple
considers the socket file mode to be a real access control. Section 4 relies on that.

---

## 3. AF_UNIX on macOS: the 104 byte limit and where to put the socket

### 3.1 The limit

**[DOC]** `unix(4)`, ADDRESSING: "UNIX-domain addresses are variable-length filesystem
pathnames of **at most 104 characters**."

**[SRC]** XNU `bsd/sys/un.h`:

```c
struct sockaddr_un {
        unsigned char   sun_len;        /* sockaddr len including null */
        sa_family_t     sun_family;     /* [XSI] AF_UNIX */
        char            sun_path[104];  /* [XSI] path name (gag) */
};
```

Linux's `sun_path` is 108. Darwin's is 104, and 104 **includes the terminating NUL**,
so the longest usable path is **103 bytes**. Bytes, not characters: a UTF-8 username
with non ASCII characters costs more than one byte per character.

**[INFER]** Practical budget. A per user temp directory looks like

```
/var/folders/3y/d44gn_2x7vv8d9d67969f54c0000gn/T/
```

which is 48 bytes (13 for `/var/folders/`, 3 for the two character bucket plus slash,
30 for the hashed token, 2 for `T/`). Adding `sbar-orbit/broker.sock` (22 bytes)
gives 70 bytes. Comfortable, with about 33 bytes of headroom.

By contrast a "natural" home directory path is dangerous:

```
/Users/example/Library/Application Support/com.sbarah.orbit/broker.sock
```

is 83 bytes for a 20 character username and blows the limit for a long username plus
one more directory level. **Never put the socket under `~/Library/Application
Support`.**

**[INFER]** Defensive coding rules for Orbit:

1. Compute the socket path, then check `Buffer.byteLength(path, "utf8") + 1 <= 104`
   before binding, and fail with a clear error naming the limit. Bun will otherwise
   surface an opaque `EINVAL` or a silently truncated path.
2. Keep per session socket names short. If sessions each get a socket, use a short
   hash, not the human session name: `s-<8 hex>.sock`, not
   `orbit-session-claude-code-refactor-the-auth-module.sock`.
3. Never resolve symlinks into the socket path if that makes it longer. `/tmp` is a
   symlink to `/private/tmp`, and `/var` is a symlink to `/private/var`, so a
   `realpath()` of `/var/folders/...` grows by 8 bytes to `/private/var/folders/...`.
   Bind the short form.

### 3.2 There is no `XDG_RUNTIME_DIR`

macOS has no per user tmpfs runtime directory and does not set `XDG_RUNTIME_DIR`. The
Darwin equivalent is the confstr pair.

### 3.3 `_CS_DARWIN_USER_TEMP_DIR`

**[DOC]** `confstr(3)`:

> `_CS_DARWIN_USER_TEMP_DIR`
> Provides the path to a user's temporary items directory. The directory will be
> created it if does not already exist. This directory is created with access
> permissions of **0700** and restricted by the `umask(2)` of the calling process and
> is a good location for temporary files. **By default, files in this location may be
> cleaned (removed) by the system if they are not accessed in 3 days.**

> `_CS_DARWIN_USER_CACHE_DIR`
> ... is a good location for user cache data as it will not be automatically cleaned
> by the system. Files in this location will be removed during safe boot.

From the shell:

```sh
$ getconf DARWIN_USER_TEMP_DIR
/var/folders/3y/d44gn_2x7vv8d9d67969f54c0000gn/T/
$ getconf DARWIN_USER_CACHE_DIR
/var/folders/3y/d44gn_2x7vv8d9d67969f54c0000gn/C/
```

Note the **trailing slash**; `getconf` and `confstr` both return it. Do not naively
`path.join(dir, "sbar-orbit")` without normalising, or you get a double slash, which
costs a byte against the 104 budget for nothing.

Important subtleties:

* **[DOC]** The directory is mode **0700** and owned by the user. That is already the
  isolation Orbit wants; it is the closest macOS gets to `XDG_RUNTIME_DIR`.
* **[REP]** These are not environment variables. `getconf _CS_DARWIN_USER_TEMP_DIR`
  with the leading underscore fails; the `getconf` name is `DARWIN_USER_TEMP_DIR`.
* **[REP]** The directory is created on demand by `dirhelper`, a root launch daemon
  that the C library talks to from inside `confstr()`. It exists by the time any user
  process runs.
* **Lifetime**: **[REP]** the `T/` directory is cleared on reboot, and
  `com.apple.bsd.dirhelper` runs at 03:35 daily and removes files under `T/` not
  accessed in 3 days. The `C/` directory is not periodically cleaned and survives
  reboot, but is cleared on safe boot.
* **[REP]** `$TMPDIR` normally holds the same value as `DARWIN_USER_TEMP_DIR`, and
  `mktemp -t` uses the confstr value while **ignoring `$TMPDIR`**. If Orbit ever shells
  out to `mktemp`, pass an explicit template rooted at the directory you chose.

### 3.4 Where the socket should live, and why not `/tmp`

**Recommendation: `$(getconf DARWIN_USER_TEMP_DIR)sbar-orbit/broker.sock`.**

Create `sbar-orbit/` with mode `0700`, bind the socket, then `chmod 0600` it.

Why not `/tmp`:

* `/tmp` on macOS is a symlink to `/private/tmp` and is world writable with the sticky
  bit (`drwxrwxrwt`). Any other local user, and every unsandboxed process on the
  machine, can enumerate it. The Darwin user temp dir is 0700 per uid; `/tmp` is not.
* A shared `/tmp` invites socket squatting: another user creates
  `/tmp/sbar-orbit/broker.sock` first and the Orbit client connects to an attacker.
  The 0700 per user directory removes that class of bug entirely.
* `/tmp` is swept by the periodic `daily_clean_tmps` job on its own schedule and per
  its own `periodic.conf` settings, which admins override.
* Multi user machines would collide on one fixed path under `/tmp`.

Why not `~/Library/Application Support`: the 104 byte limit, see 3.1. Also **[INFER]**
a socket is runtime state, not user data, and `Application Support` is backed up by
Time Machine and synced by some management tools; a dead socket inode in a backup is
noise at best.

Why the temp dir and not the cache dir, given the 3 day sweep: the socket only needs
to live as long as the broker, and the broker recreates it at every start. Clearing at
reboot is exactly the semantics you want, matching `XDG_RUNTIME_DIR`. **[INFER]** If
you are worried about the 3 day sweep hitting a long lived idle broker's socket, the
mitigation is not to move to `C/`: it is that the broker should `utimes()` its own
socket, or simply re bind on `ECONNREFUSED`/`ENOENT` from the client side, which you
need anyway for the SIGKILL-at-logout case.

Put **only** the socket and other genuinely ephemeral runtime artefacts there. PID
files, lock files, and per session control sockets belong there too. Everything
durable goes to `~/Library/Application Support` (section 5).

### 3.5 Obtaining the per user temp dir from Bun or Node

There is no `confstr` binding in Node or Bun. Three tiers, in order of preference:

```ts
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * Per user runtime directory on macOS, the analogue of $XDG_RUNTIME_DIR.
 * Returns an absolute path with no trailing slash.
 */
export function darwinUserTempDir(): string {
  // 1. launchd and login set TMPDIR to the confstr value for us.
  const env = process.env.TMPDIR;
  if (env && env.startsWith("/var/folders/")) {
    return path.resolve(env);            // strips the trailing slash
  }

  // 2. Ask the C library through getconf. /usr/bin/getconf is on every macOS
  //    and is not TCC protected.
  const r = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const out = r.stdout?.trim();
  if (r.status === 0 && out && out.startsWith("/")) {
    return path.resolve(out);
  }

  // 3. Last resort. os.tmpdir() reads TMPDIR then falls back to /tmp.
  //    Log loudly if we land here: it means we lost the per user isolation.
  return path.resolve(os.tmpdir());
}

export function brokerSocketPath(): string {
  const dir = path.join(darwinUserTempDir(), "sbar-orbit");
  const sock = path.join(dir, "broker.sock");
  const bytes = Buffer.byteLength(sock, "utf8");
  if (bytes + 1 > 104) {
    throw new Error(
      `socket path is ${bytes} bytes, Darwin sun_path holds 103 plus NUL: ${sock}`,
    );
  }
  return sock;
}
```

Then, before binding:

```ts
import fs from "node:fs";

const sock = brokerSocketPath();
fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
fs.chmodSync(path.dirname(sock), 0o700);   // mkdir respects umask, chmod does not
try { fs.unlinkSync(sock); } catch { /* ENOENT is fine */ }

const server = Bun.serve({ unix: sock, fetch: handler });
fs.chmodSync(sock, 0o600);
```

**[REP]** Bun historically chmod'd unix sockets to `0700` itself, inherited from
uSockets, and that was removed so that Bun matches Node and does not chmod at all
(Bun issue 15686, PR 16200). **[INFER]** Since the behaviour changed across Bun
versions, do not depend on either: always `chmod` explicitly after `Bun.serve`
returns, and always `chmod` the parent directory too. The directory is the control
that actually matters, because it is the one Darwin checks on every path resolution.

**[DOC]** `unix(4)`: "Binding a name to a UNIX-domain socket with `bind(2)` causes a
socket file to be created in the filesystem. **This file is not removed when the
socket is closed**, `unlink(2)` must be used to remove the file." Handle SIGTERM,
unlink, exit. And unlink at startup, because SIGKILL gives you no chance.

---

## 4. Peer credentials on Darwin

### 4.1 The constants

**[SRC]** XNU `bsd/sys/un.h`:

```c
/* Level number of get/setsockopt for local domain sockets */
#define SOL_LOCAL               0

/* Socket options. */
#define LOCAL_PEERCRED          0x001   /* retrieve peer credentials */
#define LOCAL_PEERPID           0x002   /* retrieve peer pid */
#define LOCAL_PEEREPID          0x003   /* retrieve eff. peer pid */
#define LOCAL_PEERUUID          0x004   /* retrieve peer UUID */
#define LOCAL_PEEREUUID         0x005   /* retrieve eff. peer UUID */
#define LOCAL_PEERTOKEN         0x006   /* retrieve peer audit token */
```

Header path on a real Mac:
`/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/usr/include/sys/un.h`,
or `$(xcrun --show-sdk-path)/usr/include/sys/un.h`.

**[SRC]** XNU `bsd/sys/ucred.h`:

```c
/*
 * This is the external representation of struct ucred.
 */
struct xucred {
        u_int   cr_version;             /* structure layout version */
        uid_t   cr_uid;                 /* effective user id */
        short   cr_ngroups;             /* number of advisory groups */
        gid_t   cr_groups[NGROUPS];     /* advisory group list */
};
#define XUCRED_VERSION  0
```

`NGROUPS` is 16 on Darwin, so `sizeof(struct xucred)` is 4 + 4 + 2 + 2 padding + 64 =
**76 bytes**. Note what is missing compared with Linux's `struct ucred`: **there is no
`cr_pid`**. FreeBSD added a `cr_pid` member; Darwin did not. That is why portable code
such as xrdp writes `*pid = 0; /* can't get pid in FreeBSD, OS X */` when going through
`LOCAL_PEERCRED`.

**[DOC]** `unix(4)` on the credential mechanism: the credentials "arrive in the form of
a filled in `struct xucred` (defined in `sys/ucred.h`). The credentials presented to
the server (the `listen(2)` caller) are those of the client when it called
`connect(2)` ... **This mechanism is reliable; there is no way for either party to
influence the credentials presented to its peer** except by calling the appropriate
system call ... under different effective credentials."

Note the subtlety in that sentence: the credentials are snapshotted at `connect(2)`
time, not at each message. That is the same caveat as Linux's `SO_PEERCRED`.

### 4.2 The C you would write

```c
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/ucred.h>

struct xucred cred;
socklen_t len = sizeof(cred);
if (getsockopt(connfd, SOL_LOCAL, LOCAL_PEERCRED, &cred, &len) == 0
    && len == sizeof(cred)
    && cred.cr_version == XUCRED_VERSION) {
        /* cred.cr_uid is the peer's effective uid */
}

pid_t peer_pid = -1;
socklen_t plen = sizeof(peer_pid);
getsockopt(connfd, SOL_LOCAL, LOCAL_PEERPID, &peer_pid, &plen);
```

For uid and gid only, `getpeereid(3)` is the portable wrapper and exists on macOS.
For a stronger identity, `LOCAL_PEERTOKEN` yields an `audit_token_t` that can be fed
to `SecTaskCreateWithAuditToken` and code signing checks, which is how Apple's own XPC
services validate callers. That is out of scope for an unsigned tool.

### 4.3 Does Bun or Node give you the connection fd?

**No, not supportably.**

* `Bun.serve({ unix })` hands your `fetch` handler a `Request`. **[DOC]** Bun's API
  reference notes `server.requestIP(req)` "returns null" for a unix socket, and
  `server.port` and `server.hostname` are `undefined`. There is no fd, and no socket
  object at all.
* `Bun.listen({ unix })` gives a `Socket` object in the handlers. Its public surface
  (`data`, `remoteAddress`, `write`, `end`, `ref`, `unref`) contains no file
  descriptor. **[INFER]** Bun's sockets are uSockets objects; the fd is an internal
  detail that is not exposed and would not be stable across versions.
* `node:net` under Bun: a `net.Socket` on POSIX Node exposes `socket._handle.fd`.
  **[INFER]** That is a private, undocumented field, it has been `undefined` in several
  Node configurations, and Bun's `node:net` is a reimplementation whose `_handle` is
  not the libuv handle. **Treat `_handle.fd` as absent.**
* `bun:ffi` could call `getsockopt` if you had the fd. You do not have the fd. FFI does
  not rescue this.

**Conclusion: Orbit cannot check peer credentials on macOS.** This is the same
conclusion the Windows research reached, arrived at for a different reason: Windows
has no peer credential facility at all, macOS has an excellent one that the runtime
will not let us reach.

### 4.4 The honest fallback

Filesystem permissions, and only filesystem permissions. Unlike the Windows case,
this is genuinely load bearing on Darwin:

**[DOC]** `unix(4)`: "**Normal filesystem access-control mechanisms are also applied
when referencing pathnames**; e.g., the destination of a `connect(2)` or `sendto(2)`
must be writable."

So Darwin enforces both the mode of the socket file and the traverse permission on
every parent directory. Two independent gates:

1. The per user Darwin temp dir is **0700, owned by the user** **[DOC]** `confstr(3)`.
   No other non root user can even traverse into it.
2. Orbit's own `sbar-orbit/` subdirectory, created 0700 and chmod'd 0700 explicitly.
3. The socket itself, chmod'd 0600 after bind.

Root bypasses all of this, as it does on Linux. That is accepted: on a single user Mac
with no root attacker the boundary is "other local user accounts and their processes",
and the 0700 directory closes it.

What it does **not** give you, and must be documented as such:

* No distinction between two processes of the *same* user. Any process running as the
  user can connect. On Linux with `SO_PEERCRED` Orbit could at least log the peer pid
  and uid; on macOS it cannot. **[INFER]** If Orbit's Linux code logs the peer uid, the
  macOS implementation should log `uid: os.userInfo().uid (assumed, peer creds
  unavailable on this platform)` rather than silently omitting the field, so the audit
  trail does not look identical while meaning less.
* No protection from a malicious process the user themselves ran. Same as Linux in
  practice, since Linux's `SO_PEERCRED` uid check also passes for any process of the
  same user.

**[INFER]** Optional hardening, cheap and worth it: add a shared secret. Write a 32
byte random token to `~/Library/Application Support/com.sbarah.orbit/broker.token`
with mode 0600 at broker start, and require every client request to present it in a
header. It adds nothing against a same uid attacker who can read the file, but it does
turn "any process that finds the socket" into "any process that can read a 0600 file
in the user's Library", which defeats confused deputy cases where something has a
socket fd but not filesystem access. Make it a single implementation shared with the
Windows path, which needs the same thing for the same reason.

---

## 5. File locations for a user installed tool, and TCC

Use a reverse DNS bundle style identifier as the directory name everywhere. Pick
`com.sbarah.orbit` and never vary it.

### 5.1 The four directories

**[DOC]** File System Programming Guide, "macOS Library Directory Details", Table A-1:

| Path | Apple's words | Orbit uses it for |
|---|---|---|
| `~/Library/Application Support/com.sbarah.orbit/` | "Contains all app-specific data and support files ... By convention, all of these items should be put in a subdirectory whose name matches the bundle identifier of the app ... Your app is responsible for creating this directory as needed." | Session registry, profiles, config, the token file, anything that must survive a reboot |
| `~/Library/Caches/com.sbarah.orbit/` | "Contains cached data that can be regenerated as needed. **Apps should never rely on the existence of cache files.** Cache files should be placed in a directory whose name matches the bundle identifier of the app." | Downloaded browser builds, screenshots pending upload, anything re creatable |
| `~/Library/Logs/com.sbarah.orbit/` | "Contains log files for the console and specific system services. Users can also view these logs using the Console app." | `StandardOutPath` and `StandardErrorPath` from the plist, plus Orbit's own rotated logs |
| `~/Library/Preferences/` | The `defaults`/`CFPreferences` domain store. | **Do not write here directly.** |

**[DOC]** "Where to Put Application Files" (the older Apple document, superseded by the
File System Programming Guide but unambiguous): "The preferred location for nearly all
support files is in the Application Support directory of the appropriate domain ...
If the resources are user-specific, such as workspace configuration files, place them
in the current user's `~/Library/Application Support` directory. Within the
Application Support directory, you should always place support files in a custom
subdirectory named for your application or company."

**[DOC]** Apple's current Foundation documentation, "Using the file system
effectively": "in a non-sandboxed macOS app, `applicationSupportDirectory` is
`~/Library/Application Support`, and `cachesDirectory` is `~/Library/Caches`." Orbit
is not sandboxed and has no container, so the literal paths apply.

On `~/Library/Preferences`: it holds `.plist` files managed by `CFPreferences` and
readable/writable via `defaults(1)`. **[INFER]** Writing a plist there by hand is a
known way to lose data, because `cfprefsd` caches preference domains in memory and can
overwrite your file. A CLI tool with no bundle identifier registered with Launch
Services has no business there. Keep config in `Application Support` as JSON or TOML.
If you want `defaults read com.sbarah.orbit` to work for support purposes, shell out to
`/usr/bin/defaults` rather than editing the plist.

Also note **[DOC]** File System Programming Guide: "files in `Documents/` and
`Application Support/` are backed up by default". So `Application Support` is in Time
Machine, iCloud device backups and most MDM backup policies. Do not put a browser
profile cache with gigabytes of junk there; that is what `Caches` is for. Do not put
secrets there in plaintext if you can avoid it.

### 5.2 What TCC gates, and what it does not

**[DOC]** Apple Platform Security, "Controlling app access to files in macOS": "In
macOS 10.13 or later, apps that require access to the full storage device need to be
explicitly added in System Settings (macOS 13 or later) ... System Settings > Privacy
& Security > Privacy". The table there distinguishes items where the "User is prompted
by app" from items where the "User needs to edit system privacy settings".

**Writable with no prompt, by a plain unsigned binary run by the user:**

* `~/Library/Application Support/<your own subdirectory>/`
* `~/Library/Caches/<your own subdirectory>/`
* `~/Library/Logs/<your own subdirectory>/`
* `~/Library/LaunchAgents/`
* `$(getconf DARWIN_USER_TEMP_DIR)` and `$(getconf DARWIN_USER_CACHE_DIR)`
* `~/.local/`, `~/.config/`, and any dotdirectory or plain directory you create at the
  top of `$HOME` (`~/orbit/`, `~/src/`, and so on)
* `/tmp` and `/private/tmp`
* `/usr/local/*` and `/opt/homebrew/*` where the user owns them

**[REP]** Confirmed by multiple independent operational write ups: the safe set for a
launchd spawned unsigned binary is the home root, `~/Library/Caches`, `~/Library/Logs`,
`~/Library/Application Support/<service>`, `/usr/local/var`, and `/tmp`.

**Prompts or hard denies. Orbit must never touch these:**

| Path | TCC service |
|---|---|
| `~/Desktop` | `kTCCServiceSystemPolicyDesktopFolder` |
| `~/Documents` | `kTCCServiceSystemPolicyDocumentsFolder` |
| `~/Downloads` | `kTCCServiceSystemPolicyDownloadsFolder` |
| `~/Library/Mobile Documents/` (iCloud Drive) | iCloud / `kTCCServiceFileProviderDomain` |
| `/Volumes/*` (external and removable) | `kTCCServiceSystemPolicyRemovableVolumes` |
| network mounts | `kTCCServiceSystemPolicyNetworkVolumes` |
| `~/Pictures`, `~/Movies`, `~/Music` | Photos / Media Library, tightened in Sonoma and Sequoia |
| `~/Library/Mail`, `~/Library/Messages`, `~/Library/Safari` | special, full disk access only |
| `~/Library/Application Support/com.apple.TCC/` | the TCC database itself, SIP protected |
| another app's `~/Library/Containers/<id>/Data` | "App Management" / "Data from other apps", Sonoma and later |

Two things that make this worse for a daemon specifically:

1. **[REP]** A launchd spawned process does **not** inherit Full Disk Access from the
   user or from Terminal. A binary that works when you run it from a Terminal that has
   FDA will fail under launchd with `EPERM` / `Operation not permitted`.
2. **[REP]** Under launchd there is often **no prompt at all**. The access fails
   silently with `EPERM` and the user sees nothing. This is the single nastiest macOS
   failure mode for background tools and it is the reason to design the path layout so
   that no protected path is ever touched.

**[DOC]** Third party documentation of Apple's position, and Apple's own MDM
documentation: "FDA and PPPC permissions cannot be granted via scripts, installers,
CLI commands, or root access. There is no supported method to bypass TCC
programmatically." `tccutil add` was removed years ago. So there is no installer
workaround; the only design that works is avoidance.

**[INFER]** Concrete rules for Orbit:

* The browser profile directory lives under `~/Library/Application Support/com.sbarah.orbit/profiles/<id>/`
  or under `~/Library/Caches/com.sbarah.orbit/profiles/<id>/`. Never under `~/Documents`.
* Any user supplied path (a download target for a session, an upload source) must be
  validated: if it resolves under one of the protected prefixes, refuse with a clear
  message explaining TCC, rather than attempting the operation and failing silently
  under launchd. Resolve symlinks before the check.
* Downloads that the browser session produces go to a session directory under
  `Caches`, and Orbit copies them out only when the user explicitly asks, from an
  interactive CLI invocation (which can prompt) rather than from the broker.
* Never write the Orbit binary or the launcher anywhere under `~/Desktop`,
  `~/Documents` or `~/Downloads`. **[REP]** A plist whose `Program` lives in a TCC
  protected directory fails to execute under launchd with no useful diagnostic.

---

## 6. Installing a launcher on the PATH

### 6.1 How macOS builds PATH

**[DOC]** `path_helper(8)`: "The `path_helper` utility reads the contents of the files
in the directories `/etc/paths.d` and `/etc/manpaths.d` and appends their contents to
the `PATH` and `MANPATH` environment variables respectively ... Prior to reading these
directories, default `PATH` and `MANPATH` values are obtained from the files
`/etc/paths` and `/etc/manpaths` respectively. Files in these directories should
contain one path element per line." And: "The `path_helper` utility **should not be
invoked directly**. It is intended only for use by the shell profile."

**[SRC]** Apple's `shell_cmds` source for `path_helper.c` confirms the algorithm:
`construct_path("PATH", "/etc/paths", "/etc/paths.d")`, emitting either
`PATH="..."; export PATH;` for Bourne shells or `setenv PATH "...";` for csh.

**[DOC]** `/etc/paths` on a clean install contains, in order:

```
/usr/local/bin
/usr/bin
/bin
/usr/sbin
/sbin
```

`/etc/zprofile` (system wide) contains:

```sh
if [ -x /usr/libexec/path_helper ]; then
    eval `/usr/libexec/path_helper -s`
fi
```

The zsh startup order is `/etc/zshenv`, `~/.zshenv`, `/etc/zprofile`, `~/.zprofile`,
`/etc/zshrc`, `~/.zshrc`. Two consequences:

* **PATH set in `~/.zshenv` gets reordered.** `path_helper` runs afterwards in
  `/etc/zprofile`; it keeps your entries but moves them to the **end**, after the
  `/etc/paths` defaults. **[REP]** This is the classic "why is my PATH scrambled"
  complaint and is well documented in the zsh mailing list and Homebrew's issue
  tracker.
* **PATH set in `~/.zprofile` or `~/.zshrc` survives**, because those are sourced after
  `/etc/zprofile`.

**[DOC]** zsh has been the default login shell on macOS since 10.15 Catalina. Bash 3.2
is still present at `/bin/bash` for compatibility. Orbit's installer must therefore
target zsh first and bash second.

**[REP]** On macOS 14 and later `path_helper` honours a `PATH_HELPER_ROOT` environment
variable, checking `$PATH_HELPER_ROOT/etc/paths` and `$PATH_HELPER_ROOT/etc/paths.d`.
Homebrew uses this in `brew shellenv`. Not useful for an unprivileged per user install
because it still needs a variable set before `path_helper` runs.

### 6.2 Is `~/.local/bin` on the default PATH?

**No.** It is not in `/etc/paths`, macOS ships nothing in `/etc/paths.d` that adds it,
and no default shell startup file adds it. It is a Linux and Python convention
(`pip install --user`) that macOS does not know about. A fresh macOS account has PATH
exactly `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`.

It is still a perfectly good place to put a binary: the directory is user owned,
writable without sudo, and free of TCC. It just needs a PATH edit.

### 6.3 `/usr/local/bin` and Homebrew prefixes

* `/usr/local` is in `/etc/paths` **[DOC]**, so `/usr/local/bin` is on PATH out of the
  box, for shells and for launchd's `_PATH_STDPATH` on releases that include it.
* **[REP]** On a clean macOS, `/usr/local` frequently does not exist at all, and when
  it does it is `root:wheel` mode `0755`. Creating or writing `/usr/local/bin` needs
  `sudo`. This is the whole reason Homebrew's installer runs `sudo chown` on
  `/usr/local` on Intel Macs.
* **[DOC]** Homebrew's installation documentation: "The script installs Homebrew to
  its default, supported, best prefix (`/opt/homebrew` for Apple Silicon, `/usr/local`
  for macOS Intel and `/home/linuxbrew/.linuxbrew` for Linux) so that you don't need
  sudo after Homebrew's initial installation."
* So on **Apple silicon**, `/usr/local/bin` is typically absent and root owned, and
  Homebrew lives at `/opt/homebrew/bin`, which is **not** in `/etc/paths`. Homebrew
  users have `eval "$(/opt/homebrew/bin/brew shellenv)"` in their `~/.zprofile`, which
  is how `/opt/homebrew/bin` reaches their PATH. An installer cannot assume it.
* On **Intel**, if Homebrew is installed the user owns `/usr/local/bin` and writing
  there needs no sudo, and it is already on PATH.

### 6.4 What a non root installer should choose

**[INFER]** The decision:

1. If `$HOME/.local/bin` exists **and** is already on `$PATH`, install there. Nothing
   further to do.
2. Otherwise, if the Homebrew prefix bin (`brew --prefix`/bin, i.e. `/opt/homebrew/bin`
   on Apple silicon or `/usr/local/bin` on Intel) exists, is a directory, and is
   **writable by the current uid** (`fs.accessSync(dir, fs.constants.W_OK)`), install
   there. It is already on the user's PATH by construction.
3. Otherwise install into `$HOME/.local/bin`, creating it mode 0755, and fix PATH.

Never `sudo`. Never write to `/etc/paths.d`, which needs root and is system wide.

PATH fix, when step 3 applies. Append to `~/.zprofile` (**not** `~/.zshenv`, which
`path_helper` would reorder), guarded by a marker so repeated installs do not
duplicate it:

```sh
# >>> sbar-orbit >>>
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
# <<< sbar-orbit <<<
```

Also append the same block to `~/.bash_profile` if it exists, for bash users. Then
**print** what you did and tell the user to run `exec $SHELL -l` or open a new
terminal, because you cannot change the PATH of the already running shell.

Critically: **[INFER]** the PATH edit is for the human typing `sbar-orbit`. It has
nothing to do with the broker. The LaunchAgent plist always references the binary by
absolute path (section 1.7), so a broken user PATH can never break the daemon.

The installed launcher itself should be a small shim, not a copy of the binary, so
that version switching (section 7) works:

```
~/.local/bin/sbar-orbit          -> symlink to
~/.local/share/sbar-orbit/current/bin/sbar-orbit   -> symlink to
~/.local/share/sbar-orbit/versions/1.4.2/bin/sbar-orbit
```

**[INFER]** Note that `~/.local/share` is a Linux XDG convention, not a macOS one.
Two defensible layouts: keep `~/.local/share/sbar-orbit` on macOS too for cross
platform code simplicity (it is TCC free and needs no prompt), or move the payload to
`~/Library/Application Support/com.sbarah.orbit/versions/`. Prefer the latter for
native feel, but watch the 104 byte socket budget if anything under there ever holds a
socket, and remember that `Application Support` is backed up while `~/.local/share` is
not. Since the versions tree is many megabytes of redownloadable binary, `Caches` is
wrong (it can be purged mid run) and `~/.local/share` is honestly the better fit.
Pick one and hardcode it.

---

## 7. Atomic version switching: rename over a symlink on APFS

### 7.1 rename(2) is atomic and does replace a symlink

**[DOC]** POSIX and `rename(2)`: rename is atomic with respect to other threads and
processes; an observer either sees the old link or the new one, never neither.
`rename()` does **not** follow symbolic links in the final path component, so renaming
onto an existing symlink replaces the symlink itself, not its target. APFS implements
rename through the standard VFS path and provides no exception to this.

**[INFER]** There is no "atomic rename is special on APFS" caveat to worry about. The
Linux idiom works verbatim:

```ts
import fs from "node:fs";
import path from "node:path";

/** Atomically repoint `link` at `target`. */
export function atomicSymlinkSwap(target: string, link: string): void {
  const tmp = path.join(path.dirname(link), `.${path.basename(link)}.${process.pid}.tmp`);
  try { fs.unlinkSync(tmp); } catch { /* ENOENT */ }
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link);          // atomic replace, POSIX
}
```

Three rules that matter:

* The temp link must be in the **same directory** as the final link, so the rename
  stays within one filesystem. A cross device rename fails with `EXDEV`, and on macOS
  `/Users` can be a different APFS volume from `/System` and from external drives.
* `link` must always be a **symlink or nonexistent, never a real directory**.
  `rename()` refuses to replace a non empty directory (`ENOTEMPTY`), and refuses to
  rename a non directory over a directory (`EISDIR`). If `current` is ever a real
  directory the swap breaks permanently.
* Do not `unlink(link)` then `symlink()`. That has a window where `current` does not
  exist, which is exactly what rename exists to avoid.

Apple also offers `renamex_np(2)` with `RENAME_SWAP` (atomically exchange two paths)
and `RENAME_EXCL` (fail if the destination exists). Neither is needed here, and neither
is exposed by Bun or Node.

### 7.2 Is symlink creation allowed unelevated?

**Yes.** `symlink(2)` on macOS requires no privilege. Any user can create a symlink
anywhere they have write permission on the containing directory. This is the plain
POSIX behaviour and macOS has no equivalent of Windows' `SeCreateSymbolicLinkPrivilege`
or Developer Mode requirement.

**[INFER]** The pointer file design that Windows forced is **not needed on macOS**.
Keep the macOS and Linux code path identical (real symlinks plus atomic rename) and
let Windows be the special case. Do not "unify" by adopting the pointer file
everywhere; that would give macOS an extra indirection, an extra read on every launch,
and a non atomic update, for no gain.

### 7.3 APFS case insensitivity, and what breaks

**[DOC]/[REP]** APFS ships in two variants. The macOS **system volume default is case
insensitive and case preserving**; iOS and optional macOS data volumes can be case
sensitive. Both variants are normalisation preserving; the case insensitive variant is
additionally normalisation **insensitive**, so `café` in NFC and `café` in NFD collide
in the same directory just as `Cafe` and `cafe` do. Internally APFS hashes the name
(normalise to Form D, case fold on the insensitive variant, UTF-32, CRC-32C, keep the
low 22 bits) and compares hashes.

What this breaks for Orbit:

1. **Two profiles or sessions whose ids differ only in case collide.** A session named
   `Work` and one named `work` are the same directory on a default Mac and different
   directories on Linux. **Fix:** derive every on disk directory name from a normalised
   id: lowercase plus a short hash of the original, or simply a ULID/UUID with the
   human label stored inside a JSON file. Never let a user supplied string be a
   directory name verbatim.
2. **Unicode normalisation collisions.** Same fix; also apply `String.prototype.normalize("NFC")`
   before hashing, so the same logical name maps to the same id on every platform.
3. **A case only rename is a no op or an error.** **[REP]** `mv testfile TestFile`
   on case insensitive APFS either does nothing or fails with `Invalid argument`,
   because the two names are the same name. If Orbit ever renames a version or profile
   directory purely to change case, it must go through a two step rename via a unique
   temporary name.
4. **Case only distinctions in code lookups.** A file written as `Config.json` is found
   by `readFile("config.json")` on macOS and not on Linux. That means a bug can hide on
   a developer's Mac and appear in Linux CI. **Fix:** lowercase every internal filename
   by convention and lint for it.
5. **Version directory names.** Semver strings are ASCII and lowercase, so
   `versions/1.4.2/` is safe. Prerelease tags like `1.5.0-RC1` versus `1.5.0-rc1` are
   not. Lowercase version directory names when creating them.
6. **The `current` symlink name.** Make sure no sibling differs from it only by case.

**[INFER]** None of this affects the atomicity of the swap. It affects which paths
collide, which is a naming discipline problem, and the discipline is: on disk names are
lowercase ASCII derived from a hash, human names live inside files.

---

## 8. APFS clonefile(2) and `cp -c` for copy on write profile clones

### 8.1 The call

**[DOC]** `clonefile(2)`:

```c
#include <sys/attr.h>
#include <sys/clonefile.h>

int clonefile(const char *src, const char *dst, int flags);
int clonefileat(int src_dirfd, const char *src, int dst_dirfd, const char *dst, int flags);
int fclonefileat(int srcfd, int dst_dirfd, const char *dst, int flags);
```

**[DOC]** "The `clonefile()` function causes the named file `src` to be cloned to the
named file `dst`. The cloned file `dst` **shares its data blocks** with the `src` file
but has its own copy of attributes and extended attributes ... Subsequent writes to
either the original or cloned file are **private to the file being modified
(copy-on-write)**."

Flags **[DOC]**: `CLONE_NOFOLLOW`, `CLONE_NOOWNERCOPY`, `CLONE_ACL`,
`CLONE_NOFOLLOW_ANY`, `CLONE_RESOLVE_BENEATH`.

**[DOC]** History: "The `clonefile()`, `clonefileat()` and `fclonefileat()` function
calls appeared in OS X version 10.12." Available on every macOS 13+ target.

### 8.2 Constraints you must code around

* **`dst` must not exist.** **[DOC]** "The named file `dst` must not exist for the call
  to be successful." So clone to a fresh temp name, then atomically rename it into
  place. This composes nicely with section 7.
* **Directories are discouraged.** **[DOC]** LIMITATIONS: "Cloning directories with
  these functions is strongly discouraged. Use `copyfile(3)` to clone directories
  instead." And in DESCRIPTION: "If `src` names a directory, the directory hierarchy is
  cloned as if each item was cloned individually. However, the use of `clonefile(2)` to
  clone directory hierarchies is strongly discouraged."
  **[INFER]** A browser profile is a directory tree. So the supported route for a whole
  profile is **`copyfile(3)` with `COPYFILE_CLONE`** (or `COPYFILE_CLONE_FORCE`), or
  `cp -c` from the shell, not a raw `clonefile()` on the directory. The end result is
  the same copy on write sharing, done per file by the system.
* **Same volume only.** **[INFER from DOC]** Clone across directories is fine, any
  number of directories deep, as long as both paths are on the **same APFS volume**.
  This is the normal case: `~/Library/Application Support/...` and
  `~/Library/Caches/...` are both on the Data volume. Across volumes the call fails
  with `EXDEV`. Notably the macOS system volume and data volume are different volumes
  in the same APFS container, so `/usr/...` to `/Users/...` is cross volume even though
  it feels like one disk.
* **Non APFS volumes.** **[DOC]** COMPATIBILITY: "Not all volumes support
  `clonefile()`. A volume can be tested for `clonefile()` support by using
  `getattrlist(2)` to get the volume capabilities attribute `ATTR_VOL_CAPABILITIES`,
  and then testing the `VOL_CAP_INT_CLONE` flag." On HFS+, exFAT, FAT32, SMB and NFS
  mounts the call fails with `ENOTSUP`. A user with a home directory on an external
  exFAT drive or a network home will hit this.
* **`ENOSPC` later.** **[DOC]** "Since the `clonefile()` system call might not allocate
  new storage for data blocks, it is possible for a subsequent overwrite of an existing
  data block to return `ENOSPC`." A clone is cheap now and can cost disk later. Orbit's
  disk space checks must not assume a clone is free forever.
* **Ownership and ACLs.** **[DOC]** ownership is set as if `dst` were created by the
  current user, setuid/setgid are cleared on regular files, and the clone inherits the
  target directory's ACLs unless `CLONE_ACL` is passed. For a same user profile clone
  this is exactly what you want.
* **Atomicity.** **[DOC]** "The `clonefile()`, `clonefileat()` and `fclonefileat()`
  functions are expected to be atomic i.e. the system call will result all new objects
  being created successfully or no new objects will be created."
* **[DOC]** "POSIX conforming applications cannot use `clonefile()`." It is a Darwin
  extension. Guard it behind `process.platform === "darwin"`.

### 8.3 How Orbit should actually call it

Bun and Node expose none of this directly. `fs.copyFileSync` has
`fs.constants.COPYFILE_FICLONE` on Linux (btrfs/XFS reflink) but on macOS Node does
not map it to `copyfile(3)`'s clone flags. **[INFER]** Do not rely on
`COPYFILE_FICLONE` doing anything on macOS.

Shell out to `/bin/cp`, which macOS ships with clone support:

```ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";

/**
 * Clone a browser profile directory copy-on-write when the volume supports it,
 * falling back to a real recursive copy. dst must not exist.
 */
export function cloneProfile(src: string, dst: string): "clone" | "copy" {
  // -c uses clonefile(2) per file. -R recurses. -p preserves attributes.
  const cloned = spawnSync("/bin/cp", ["-cR", src, dst], { encoding: "utf8" });
  if (cloned.status === 0) return "clone";

  // Not APFS, cross volume, or otherwise unsupported. Clean up a partial tree.
  fs.rmSync(dst, { recursive: true, force: true });
  const copied = spawnSync("/bin/cp", ["-R", src, dst], { encoding: "utf8" });
  if (copied.status !== 0) {
    throw new Error(`profile copy failed: ${copied.stderr || copied.status}`);
  }
  return "copy";
}
```

**[DOC]** `cp(1)` on macOS documents `-c`: copy files using `clonefile(2)`.
**[REP]** `cp -c` fails rather than silently falling back when the clone is not
possible, which is why the fallback above is explicit. **Verify the exact failure mode
on hardware** (section 10), because a silent fallback would make the first branch
always return `"clone"` and the telemetry would lie.

**[INFER]** Report which path was taken in `sbar-orbit status`. "profile clone: CoW
(APFS)" versus "profile clone: full copy (volume does not support cloning)" is exactly
the sort of thing that explains a 40 second session start to a confused user.

---

## 9. Consolidated path table for the macOS implementation

```
Launch agent plist   ~/Library/LaunchAgents/com.sbarah.orbit.broker.plist      0644
Launcher symlink     ~/.local/bin/sbar-orbit                                   symlink
                     (or $(brew --prefix)/bin/sbar-orbit when writable)
Version payloads     ~/.local/share/sbar-orbit/versions/<version>/             0755
Current version      ~/.local/share/sbar-orbit/current -> versions/<version>   symlink
Durable state        ~/Library/Application Support/com.sbarah.orbit/           0700
  sessions.json, config.json, broker.token (0600)
Caches               ~/Library/Caches/com.sbarah.orbit/                        0700
  profiles/<id>/, downloads/<session>/
Logs                 ~/Library/Logs/com.sbarah.orbit/                          0700
  broker.out.log, broker.err.log
Runtime dir          $(getconf DARWIN_USER_TEMP_DIR)sbar-orbit/                0700
Broker socket        $(getconf DARWIN_USER_TEMP_DIR)sbar-orbit/broker.sock     0600
Session sockets      $(getconf DARWIN_USER_TEMP_DIR)sbar-orbit/s-<8hex>.sock   0600
```

Create every directory with `recursive: true` then `chmod` explicitly, because
`mkdir`'s mode argument is masked by the umask and a `022` umask turns a requested
`0700` into `0700` but a requested `0777` into `0755`; being explicit removes the
question.

---

## 10. Things to verify on real macOS 13+ hardware before shipping

Each of these is a one line check. None could be run from the Linux research host.

1. `getconf DARWIN_USER_TEMP_DIR` output and its exact byte length on a real account,
   plus `stat -f '%Sp %Su' "$(getconf DARWIN_USER_TEMP_DIR)"` to confirm `drwx------`.
2. That `Bun.serve({unix})` leaves the socket at the process umask default and that an
   explicit `chmod 0o600` after it sticks. Bun's chmod-to-0700 behaviour changed
   between versions.
3. That connecting to a `0600` socket in a `0700` directory as a **second local user**
   fails with `EACCES`, confirming Darwin enforces the mode on `connect(2)`.
4. Whether any Bun or `node:net` path exposes a usable connection fd. Test
   `socket._handle?.fd` under `node:net` on Bun. If it ever returns a real fd, the
   `LOCAL_PEERCRED` path in section 4.2 becomes reachable through `bun:ffi` and is
   worth building.
5. `launchctl bootstrap gui/$(id -u) <plist>` from a GUI Terminal (should work) and
   over SSH with nobody at the console (expected to fail with error 125). Capture the
   exact error string for the installer's error message.
6. `launchctl bootstrap user/$(id -u) <plist>` as a non root user. If it succeeds,
   re examine section 1.6.
7. Full cycle: bootstrap, log out, log in, confirm the broker restarted automatically
   without re running bootstrap. Then reboot and confirm it starts on login.
8. `launchctl disable`, then `bootstrap`, and capture the failure, to confirm the
   enable-before-bootstrap workaround.
9. The PATH an agent actually sees: temporarily set `ProgramArguments` to
   `["/bin/sh", "-c", "env > ~/Library/Logs/com.sbarah.orbit/env.txt"]` and read the
   file. Record whether `TMPDIR` is set, and what `PATH` is.
10. `cp -cR` onto an exFAT volume: confirm it fails with a non zero status rather than
    silently copying, so the fallback in section 8.3 is reachable.
11. `clonefile` across `~/Library/Application Support` and `~/Library/Caches` (same
    Data volume, expected to work) and from `/usr/share` to `~` (system volume to data
    volume, expected `EXDEV`).
12. A case only directory rename under the versions tree, to confirm the `EINVAL`
    behaviour and that the two step rename workaround is needed.
13. `/usr/local/bin` existence, owner and mode on a clean Apple silicon Mac with and
    without Homebrew.

---

## 11. Sources

Apple man pages, by section:

* `launchd.plist(5)`, Darwin, 30 July 2019 revision. Keys, FILES, EXPECTATIONS,
  KeepAlive, RunAtLoad, EnvironmentVariables, Umask, ExitTimeOut, ThrottleInterval,
  Sockets/SockPathName/SockPathMode/SockPathOwner, LimitLoadToSessionType.
* `launchctl(1)`. Domain and service target grammar, bootstrap, bootout, enable,
  disable, kickstart, print, print-disabled, blame, kill, deprecations.
* `unix(4)`, Device Drivers Manual. 104 character address limit, socket file not
  removed on close, filesystem access control applied to pathnames, `struct xucred`
  credential passing semantics.
* `clonefile(2)`, Darwin, 3 June 2021 revision. Semantics, flags, LIMITATIONS,
  COMPATIBILITY / `VOL_CAP_INT_CLONE`, ERRORS, HISTORY.
* `confstr(3)`, `_CS_DARWIN_USER_TEMP_DIR` and `_CS_DARWIN_USER_CACHE_DIR` text.
* `path_helper(8)`. `/etc/paths`, `/etc/paths.d`, `-s` and `-c` output styles.
* `cp(1)`, the `-c` flag.
* `rename(2)`, `symlink(2)`, `renamex_np(2)`.

Apple developer documents:

* Technical Note TN2083, "Daemons and Agents". Agent versus daemon definitions,
  Table 1 session types, Table 5 launch behaviour, the recommendation to use unix
  domain sockets for daemon IPC, the rule that clients connect to servers.
* "Creating Launch Daemons and Agents", System Startup Programming Guide.
* File System Programming Guide, "File System Basics" and "macOS Library Directory
  Details" (Table A-1). Application Support, Caches, Logs, Preferences.
* "Where to Put Application Files" (archived predecessor), bundle identifier
  subdirectory convention.
* Foundation, "Using the file system effectively". Non sandboxed literal paths.
* Apple Platform Security, "Controlling app access to files in macOS". TCC, System
  Settings > Privacy & Security > Privacy in macOS 13 and later.

XNU source:

* `bsd/sys/un.h`: `struct sockaddr_un` with `sun_path[104]`, `SOL_LOCAL`,
  `LOCAL_PEERCRED`, `LOCAL_PEERPID`, `LOCAL_PEEREPID`, `LOCAL_PEERUUID`,
  `LOCAL_PEEREUUID`, `LOCAL_PEERTOKEN`.
* `bsd/sys/ucred.h`: `struct xucred`, `XUCRED_VERSION`.
* `shell_cmds`, `path_helper/path_helper.c`.

Non Apple, used only for items marked [REP]:

* Homebrew installation documentation, prefix per architecture.
* Bun documentation for `Bun.serve({unix})` and `Bun.listen`, and Bun issue 15686 /
  PR 16200 on unix socket permissions.
* Operational reports on launchd plus TCC interaction and on `gui/$UID` bootstrap
  failing over SSH with error 125.
* Eclectic Light Company and Michael Tsai on APFS case and normalisation behaviour.
