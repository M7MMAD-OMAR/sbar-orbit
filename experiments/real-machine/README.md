# The real machine run, acceptance gate 3, native half

Gate 3 says what still closes it: "a real machine with a systemd user session, cgroup delegation and
wlroots, where `./install.sh` runs to completion and the broker it starts answers." The browser half
closed on a GitHub Ubuntu runner, which refused the bundled compositor by soname. The container run
in `experiments/fresh-machine/` closed the systemd half and stopped at hardware: no GPU, no real
compositor, no screen, and a budget sized from the host's processor and memory totals rather than
the container's.

This directory builds the missing machine: a Fedora 44 guest under the session libvirt connection,
with systemd as PID 1, a real logind seat, a lingering account whose user manager owns delegated
cgroup controllers, and a real DRM device from virtio-gpu, which is what gives a wlroots compositor
something to draw on.

## What this is and is not

It is a real machine in every way the gate names. It is not a real machine in one: the GPU is
virtual and rendering is software, so the honest ceiling is `Limited` under
[support tiers](../../docs/support-tiers.md), with that limit printed. Not `Measured`.

## No viewer, ever

The guest is driven over SSH on a forwarded loopback port. No `virt-viewer`, no `virt-manager`, no
`remote-viewer`, no SPICE window. The domain declares a VNC display only because QEMU wants a
display device behind virtio-gpu; nothing connects to it. That rule is the point of this project and
it holds while working on the project too.

## Bounds

4 vCPU and 6 GiB, one qcow2 overlay over a shared read only base image, because this host has 24
cores shared with concurrent work and its known failure mode is btrfs disk I/O rather than CPU.

## Running it

```sh
experiments/real-machine/vm.sh create                 # download, seed, define, boot, wait for ssh
experiments/real-machine/vm.sh scp-in experiments/real-machine/provision.sh provision.sh
experiments/real-machine/vm.sh ssh 'bash provision.sh'
git archive --format=tar -o /tmp/source.tar HEAD
experiments/real-machine/vm.sh scp-in /tmp/source.tar source.tar
experiments/real-machine/vm.sh ssh 'bash run.sh'
experiments/real-machine/vm.sh destroy                # shut down, undefine, delete the overlay
```

`win11` on the same connection is somebody else's guest. Nothing here touches it: the domain name,
the disk path, the seed image and the forwarded port are all distinct.

## Files

- `vm.sh` builds, drives and destroys the domain.
- `provision.sh` installs what a real desktop machine would already have, in three named groups:
  base, the 26 runtime libraries the unpacked compositor links against, and the fifteen applications
  `experiments/application-coverage.ts` launches. The package list is itself a deliverable.
- `run.sh` is the gate run: tracked source, frozen lockfile, preflight, dry run, install, native
  bootstrap, the service, the delegated controllers and the slice, a browser session, a native
  session with a Wayland application and an X11 application, and a frame content check.
