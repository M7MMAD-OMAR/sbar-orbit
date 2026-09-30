# Private display device enumeration

The [opt-in experiment](private-device-inventory.ts) launches a GTK application
through the normal Fedora session dispatcher and native launch action. It
enumerates PulseAudio sinks and sources via the private application's environment,
and counts `/dev/video[0-9]*` paths there. The application writes aggregate
counts to its own disposable result file and shows them in its private window.
No device names, audio samples, camera images or account data are retained.

```sh
ORBIT_DEVICE_INVENTORY=1 bun run scripts/limited.ts bun run experiments/private-device-inventory.ts
```

On 30 September 2026 the private application enumerated two audio sinks and
four audio sources successfully. It saw two video device nodes, matching the
host's two node paths. Orbit's captured frame showed the inventory window and
those counts. The result and frame were saved in
`output/private-device-inventory-2026-09-30/`, a local ignored artifact directory.
The owned session was closed and its temporary application files removed.
Type checking passed.

## Evidence limits

Audio sources may include monitor/loopback sources. Four sources is not a claim
that four physical microphones exist. Multiple video nodes can belong to one
camera, including metadata nodes; two nodes is not a claim of two cameras.
The experiment did not open a physical video device, record audio, play sound,
change volume or alter routing. Enumeration establishes that the native private
application can reach the user's audio service and see video paths, not that
capture permission or media operation succeeded. Recording, playback, camera
streaming, portal grants and behavior in the user's account applications remain
not measured.

## Read-only camera capability query

The optional mode opens each video node with `O_RDWR | O_NONBLOCK`, issues only
`VIDIOC_QUERYCAP`, and closes it immediately. It never requests buffers or
starts a stream. The ioctl number, structure size and capability offsets come
from the installed `/usr/include/linux/videodev2.h`, whose capability structure
is 104 bytes. Device names, serial identifiers and bus details are discarded.

```sh
ORBIT_DEVICE_INVENTORY=1 ORBIT_CAMERA_QUERY=1 bun run scripts/limited.ts bun run experiments/private-device-inventory.ts
```

On 30 September 2026 the private application opened and queried both nodes
successfully. One reported video capture capability; the other reported
metadata capture capability. Both reported streaming support. The private
window and aggregate results were captured in
`output/private-device-query-2026-09-30/`. This corrects the ambiguity of the
earlier node count: it is not evidence of two physical cameras.

These are actual successful device opens and kernel queries from the normally
launched private application. They establish that its process has access to the
video nodes on this workstation. Actual frame capture, browser permission
prompts, media application behavior and account-specific device choices remain
not measured. The session was closed after capture, and type checking passed.
