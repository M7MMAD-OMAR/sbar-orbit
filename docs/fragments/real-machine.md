# The real machine run: the native half of gate 3

Measured on 19 September 2026, on a Fedora 44 guest built for this run under the session libvirt
connection on the developer's workstation. Tier `Limited`, with the limits printed below. Not
`Measured`, for one reason named in its own section: there is no physical GPU behind this machine.

## What a real machine proved, which no container run could attempt

Gate 3 says what still closes it: "a real machine with a systemd user session, cgroup delegation and
wlroots, where `./install.sh` runs to completion and the broker it starts answers." This machine has
all four, and none of them are simulated:

- systemd as PID 1, `systemd-detect-virt` reports `kvm`
- a real logind seat, `seat0`, with two live sessions
- a lingering unprivileged account whose user manager owns `cpu memory pids`, both in
  `cgroup.controllers` and in `cgroup.subtree_control`
- a real DRM device from virtio-gpu: `/dev/dri/card0` and `/dev/dri/renderD128`, driver `virtio-pci`
- a real Wayland compositor with a real 1280 by 800 screen

From tracked source (`git archive`, 441 files, no `node_modules`, no `output/`) and the frozen
lockfile, in order, every step exit 0:

| Step | Result |
|---|---|
| `bun install --frozen-lockfile` | 100 packages, 23.45 s |
| `./bin/sbar-orbit preflight` | passes |
| `./install.sh --dry-run --json` | plan printed |
| `./install.sh --json` | `installed: true`, every step done |
| `./install.sh --native` | builds the private compositor and pointer helper into `~/.local/share/sbar-orbit/runtime/sway-1.11-3.fc44-f2bb8c` |
| `sbar-orbit.service` | `active`, `running`, `NRestarts=0`, still active after a wait |
| `doctor` | answers on `/run/user/1000/sbar-orbit/broker.sock` |
| `doctor --report` | answers, tier `Reasoned`, distribution `fedora 44` |
| `sbarorbit.slice` | exists, `cgroup.controllers: cpu memory pids` |

The slice is real and enforcing: `CPUQuotaPerSecUSec=1s`, `MemoryMax=2147483648`, `TasksMax=1536`,
and its own `cpu.stat` shows `nr_throttled 24` with `throttled_usec 730610`, so the kernel was
actually holding the quota rather than the quota being nominal.

### The browser half, through the installed command

Session created, navigated to `https://example.com/`, read `h1` and got `Example Domain`, captured a
1280 by 800 JPEG of 17697 bytes, stopped cleanly.

### The native half, which is what this gate was waiting for

A private display session on a machine with a screen. Both applications were typed into, and both
typed strings were read back off the captured pixels by eye, not inferred from an exit code:

- A Wayland application, GNOME Text Editor: launched, typed into, clicked, closed. The frame
  `native-wayland-typed.jpg` shows the editor with **"orbit wayland on a real machine"** legible in
  the document body, the title bar reading "orbit wayland on a real" and a "Save Changes?" modal
  open over it, which is the click landing.
- An X11 application under Xwayland, xterm: launched and typed into. The frame
  `native-x11-typed.jpg` shows the xterm with **"orbit xwayland on a real machine"** legible at a
  shell prompt reading `[orbit@sbar-orbit-gate3 ~]$`.

Seven frames were captured across the run and all seven are byte distinct. The cost of the whole
session sequence was 6561 ms of processor inside the budget above, 12 tasks and 191 MiB at the end,
with zero refused forks.

### The SIGKILL containment guarantee, on a real machine for the first time

`tests/owned-group.test.ts`, the five checks that cover killing a supervisor outright and sweeping
the process group it led: **5 pass, 0 fail** under `ORBIT_TEST_NATIVE=1`. This is the property the
project exists to provide, and every previous assertion of it was in a container or on the
developer's own workstation.

### The suite

Run one bounded command at a time, with `ORBIT_CAPTURE_TIMEOUT_MS` unset so the suite reads its own
defaults:

| Command | Result |
|---|---|
| `bun run verify` | **341 pass, 43 skip, 0 fail**, 384 tests across 77 files, 84.47 s |
| `ORBIT_TEST_NATIVE=1 bun run verify` | **355 pass, 29 skip, 0 fail**, 384 tests across 77 files, 110.54 s |

Fourteen tests flip from skip to pass under `ORBIT_TEST_NATIVE=1`: that is the private display suite
running for real against the Fedora runtime this machine built.

### Application coverage, on a real machine rather than the developer host

`experiments/application-coverage.ts`: **13 of 15 mapped**, 606 ms to 1693 ms, each launched alone
and closed before the next. GTK4 libadwaita (Ptyxis, Characters, Clocks, Weather, Loupe, Papers,
Showtime, Snapshot, Font Viewer), GTK3 (Inkscape), LibreOffice VCL (Writer, which opened
`coverage.txt`), GLFW/OpenGL (kitty), and GTK4 forced through Xwayland (Calculator). Per application
the cost from launch to first frame was about 18 to 24% of one core, 4.6 to 5.9% of the machine,
with `hostIowaitPercent` 0.

The two that did not map are **not measured**, not failures of Orbit. Konsole and Dolphin, both
Qt 6 with KDE Frameworks, abort before mapping. Run directly on the guest with no compositor, no
private display and no Orbit anywhere in the picture:

```
$ /usr/bin/dolphin --version
Aborted (core dumped)          RC=134
$ /usr/bin/konsole --version
Aborted (core dumped)          RC=134
```

The guest's Qt 6 / KDE Frameworks packages are internally inconsistent on this Fedora 44 cloud
image: `libKF6Codecs.so.6` wants a `GLIBCXX_3.4.35` symbol the image's `libstdc++` does not export.
Installing `kf6-kio` and upgrading `libstdc++` was attempted once and did not change the result.
Orbit reported `BACKEND_FAILED: Application exited before mapping` in 104 and 156 ms, which is the
correct and honest result for a program that died before it could map a window.

## The limits, printed beside every row above

1. **No physical GPU.** This is a VM. Everything above is composited and rendered in software.
2. **The compositor bound `pixman`, not a GL renderer.** Every native session reported
   `"renderer":{"asked":"pixman","bound":"pixman"}`. So the compositor itself composites in
   software on this machine, and that is the honest headline for the whole graphics section.
3. **The capture budget was raised for the session runs.** `ORBIT_CAPTURE_TIMEOUT_MS=30000`, up from
   the shipped 3000 ms default, deliberately and recorded here: a software rasteriser paints far
   slower than the workstation this project was written on, and the default would have read slowness
   as a broken capture path. The suite numbers above were taken with it unset.
4. **One private display at 1280 by 800**, applications launched one at a time.

## The 3D question, which is now answered rather than assumed

An earlier draft of this run treated kitty as the OpenGL row. That overclaimed. kitty is a terminal
that happens to composite glyphs through GL; its window mapping proves a GL-using client can start,
map a surface and be captured, and nothing about a 3D scene. So a real one was run.

`experiments/real-machine/gl-probe.sh` launched **glxgears**, an actual animated 3D scene, under
Xwayland inside the private display, and captured two frames four seconds apart:

- `gl-gears-first.jpg`, 70118 bytes: three shaded, perspective-projected gears, red, blue and green,
  with visible depth shading and cast shadow on their teeth. Verified by eye, not by byte count.
- `gl-gears-second.jpg`, 69216 bytes: the same scene with the gears at a different rotation.

The two frames are not byte identical, which is what animation means here: the scene advanced
between captures. So a real 3D application renders inside an Orbit private display on virtio-gpu
with software rendering, and is captured correctly. That row is a measured pass at tier `Limited`,
limited on software rendering.

What is still `not measured`: hardware GL. `glmark2-wayland --off-screen` refused with
`Error: main: Could not initialize canvas`, and `glxinfo -B` cannot run outside a display so its
renderer string was not obtained on this guest. Whether llvmpipe or virgl was behind glxgears is
therefore not established; only that a 3D scene rendered and animated.

## Two failures found, neither of them a product defect

**A test that read ambient environment.** `the capture budget defaults to the 3000 ms it used to
hardcode` failed on this machine while passing on the developer's workstation, because
`captureTimeoutMs(undefined)` triggers a default parameter that reads `process.env`, so the test
asserted the host's environment rather than the default. Running the suite on a second real machine,
with a legitimate configuration of a documented knob, is what exposed it. Fixed on main as `995ba79`.

**An uninstalled workspace read as a Fedora result.** `website/tests/locale.test.tsx` failed with
`Cannot find module 'react/jsx-dev-runtime'` because `website/` is a separate bun workspace whose
dependencies were never installed on the guest. Not a Fedora result and not a gate 3 result. The
step is now in `experiments/real-machine/provision.sh` so the next person who builds this machine
does not rediscover it, and the final suite numbers above were taken with it installed.

**A harness defect of mine, recorded because it wasted a run.** The first run reported three capture
steps as exit 1 with a `JSONDecodeError`. The product was fine; my `capture()` helper wrapped its
pipeline in `bash -c` with a nested double-quoted python program, the shell ate the quotes, and a
truncated document surfaced as a parse error that looked like a capture failure. This is the same
class of defect main fixed in `5576f11` for the `act` argument. The helper now uses a single-quoted
heredoc, which is quote-proof by construction, and it asserts the frame's content, a JPEG magic
number and an 8000 byte floor, rather than trusting an exit code.

## Open questions this run closed

**Does the budget read the host's totals rather than the guest's?** This is the defect the roadmap
already records for the container run, where the budget sized was a quarter of the host rather than
a quarter of the container. **It does not reproduce on a VM.** The guest reports `nproc` 4 and
`MemTotal` 6054556 kB, which are its own figures and not the 24 processors and 32 GiB of the host it
runs on, because a VM has its own kernel. The budget sized from them, `CPUQuotaPerSecUSec=1s` and
`MemoryMax=2147483648`, is a quarter of this machine.

**Does `doctor --report` still read this as the project's measured host class?** On this real Fedora
44 VM it assigns tier `Reasoned`, with the reason "This is the same host class the measurements were
taken on", which is correct here and is a genuine Fedora 44 machine rather than a container
pretending to be one.

**Does a fresh install report unit drift?** No. `doctor` reports no drift on this guest, which is
the correct answer for an install made minutes earlier.

## The runtime package list, which is a deliverable

The private compositor is unpacked rather than installed, so everything it links against has to be
present already. On a Fedora 44 cloud image these 26 are required, and the bootstrap names them:

`cairo gdk-pixbuf2 glib2 json-c lcms2 libdisplay-info libdrm libevdev libglvnd-egl libglvnd-gles
libinput libseat libwayland-client libwayland-cursor libwayland-server libxcb libxkbcommon
mesa-libgbm pango pcre2 pixman systemd-libs vulkan-loader xcb-util-errors xcb-util-renderutil
xcb-util-wm`

Beyond those, this machine also needed, and `experiments/real-machine/provision.sh` installs:
`tar unzip procps-ng git curl cpio chromium python3 grim wl-clipboard xorg-x11-server-Xwayland gcc
pkgconf-pkg-config wayland-devel libxkbcommon-devel wayland-utils xterm btrfs-progs
mesa-dri-drivers mesa-libEGL mesa-libGL libglvnd-glx`, plus `glx-utils mesa-demos glmark2` for the
3D probe. `btrfs-progs` is there because without it every `session.create` threw, which is the
defect the container run found.

## No viewer was ever opened

The guest was driven over SSH on a forwarded loopback port for the whole run. No `virt-viewer`, no
`virt-manager`, no `remote-viewer`, no SPICE window, nothing on the person's screen. The domain
declares a VNC display only because QEMU wants a display device behind virtio-gpu, and nothing
connected to it.

## What this supports claiming

Tier `Limited` for the native half of gate 3 on Fedora 44, with the limits above printed beside it:
no physical GPU, the compositor bound `pixman`, and an elevated capture budget for the session runs.
A machine with a real GPU, and a person's own desktop session, is still what would take any of these
rows to `Measured`.

## Evidence

Frames cited above are kept in `docs/fragments/real-machine-frames/` so they survive the VM:
`native-wayland-typed.jpg`, `native-x11-typed.jpg`, `gl-gears-first.jpg`, `gl-gears-second.jpg`,
`browser.jpg`, `native-opengl.jpg`, and `application-coverage-report.json`. The full logs and the
thirteen coverage frames are in `output/real-machine/`, which is gitignored.
