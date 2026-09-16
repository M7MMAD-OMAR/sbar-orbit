# Driving a Windows guest, headlessly

The Windows measurements in [docs/windows-measured.md](../../docs/windows-measured.md) were taken on
a Windows 11 guest running under libvirt on the owner's own workstation. There is no cloud runner
here and no second machine. What there is, and what these three files use, is
`qemu-guest-agent` over a virtio-serial channel: no network into the guest, no SSH, no RDP, and
nothing on the person's screen at any point.

That last part is the project's own rule applied to the project's own work. The guest has a SPICE
device with `listen type='none'`, so there is no display to take over even by accident.

## The three files

| File | What it does |
|---|---|
| `vmexec.py` | Run a PowerShell command or script in the guest. Returns stdout, stderr and the exit code. |
| `vmexec_user.py` | The same, but in the **interactive** session rather than session 0. |
| `vmpush.py` | Push a local file in over the agent channel, chunked base64, sha256 verified at both ends. |

```sh
export LIBVIRT_DEFAULT_URI=qemu:///session
virsh start win11

python3 vmexec.py '$PSVersionTable.PSVersion.ToString()'
python3 vmpush.py ./bun.exe 'C:\orbit\bun.exe'
python3 vmexec_user.py ./probe.ps1 --wait 400
```

## Why `vmexec_user.py` exists, and why every browser probe has to use it

`guest-exec` runs as `NT AUTHORITY\SYSTEM` in **session 0**. Measured on this guest: a Chromium
family browser launched from session 0 exits immediately, writes nothing into its profile but a
`Crashpad` directory, and never publishes `DevToolsActivePort`. `--headless` does not change it.
`--no-sandbox` does not change it. The same launch handed to the interactive session answered CDP
on the first attempt.

So `vmexec_user.py` writes the script into the guest, registers a one-off scheduled task with
`/RU <interactive user> /IT`, runs it, and polls a log file the task appends to. That is the only
route from session 0 into session 1 that does not put a window on anyone's screen.

Two details that are easy to get wrong:

- The task's stdout goes nowhere the agent can read, so the payload is wrapped in a `Say` helper
  that appends to a file, and the wrapper writes a sentinel when it finishes. Waiting on the exit
  code alone tells you nothing about what happened.
- Read that log with an explicit `FileShare.ReadWrite` handle. Plain `Get-Content` fails with
  "used by another process" while the task still holds it.

## The argument size trap

The agent payload travels as a **single argv entry**. Linux caps one argument at `MAX_ARG_STRLEN`,
128 KiB, and that limit is independent of the 2 MiB `ARG_MAX` that `getconf` reports. A shell does
not get around it and neither does a temporary file, because the JSON still has to arrive as one
argument.

`vmpush.py` therefore uses a 90000 byte chunk, which is 120000 base64 characters and fits. At that
size, 82 MiB of `bun.exe` transferred in about fifteen seconds, 5.35 MiB/s, and the sha256 matched.

## Screenshots, when a probe wedges

`virsh screenshot` works with `listen type='none'` and produces a PNG on QEMU 7.1 and later, because
it reads the framebuffer over the QMP monitor rather than through a display client.

```sh
virsh screenshot win11 --file /tmp/shot.png
```

Two things it will not tell you: the mouse cursor is a hardware plane and is not composited into the
image, and a guest that is idle produces byte identical files, so "unchanged" does not distinguish
idle from stuck.

## What this setup cannot answer

- **Chrome.** Only Edge is installed on this guest, so every browser result is Chromium family via
  Edge.
- **Real hardware.** Eight uniform vCPUs, so nothing about hybrid P and E core scheduling.
- **A person.** No real profile, no Keychain equivalent, no logged in services, no second user.

There is no Windows CI on Linux without a VM. Wine reimplements Win32 on POSIX rather than running
the NT kernel, and Windows containers need a Windows host. The VM is the answer; these three files
are what make it scriptable.
