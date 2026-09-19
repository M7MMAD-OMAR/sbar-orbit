#!/usr/bin/env bash
#
# Build, boot and tear down a Fedora 44 guest under the session libvirt connection, for the half of
# acceptance gate 3 no container can reach: systemd as PID 1, a real logind seat, a lingering user
# whose manager owns delegated cgroup controllers, and a real DRM device from virtio-gpu.
#
# It never opens a graphical viewer. The guest is driven over SSH on a forwarded loopback port only,
# which is the same rule this project holds for the person's own screen.
#
# Usage:
#   experiments/real-machine/vm.sh create     # download, seed, define and boot
#   experiments/real-machine/vm.sh ssh [cmd]  # run a command in the guest
#   experiments/real-machine/vm.sh destroy    # shut down, undefine, delete the disk
#
# Bounds, because this host has 24 cores shared with other work and its known failure mode is btrfs
# disk I/O: 4 vCPU, 6 GiB, one qcow2 overlay over the shared read only base image.
set -euo pipefail

name=${ORBIT_VM_NAME:-sbar-orbit-gate3}
state=${ORBIT_VM_STATE:-$HOME/.local/state/sbar-orbit-real-machine}
images=$HOME/.local/share/libvirt/images
base=$images/Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2
base_url=https://dl.fedoraproject.org/pub/fedora/linux/releases/44/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2
disk=$images/$name.qcow2
seed=$images/$name-seed.iso
key=$state/id_ed25519
port=${ORBIT_VM_SSH_PORT:-2242}
guest_user=orbit

virsh() { command virsh --connect qemu:///session "$@"; }

ssh_guest() {
  ssh -i "$key" -p "$port" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    -o ConnectTimeout=10 -o ServerAliveInterval=30 \
    "$guest_user@127.0.0.1" "$@"
}

create() {
  mkdir -p "$state" "$images"
  [ -f "$key" ] || ssh-keygen -t ed25519 -N '' -f "$key" -C "sbar-orbit-gate3" >/dev/null
  if [ ! -s "$base" ]; then
    echo "downloading the Fedora 44 cloud image"
    curl -fL --retry 3 -o "$base.part" "$base_url"
    mv "$base.part" "$base"
  fi
  # An overlay keeps the writes small: the base stays read only and shared.
  rm -f "$disk"
  qemu-img create -f qcow2 -F qcow2 -b "$base" "$disk" 24G >/dev/null

  # cloud-init: one unprivileged account with our key, passwordless sudo so the run can install the
  # runtime packages the bootstrap needs, and linger so its user manager starts without a login.
  local cidir=$state/cloud-init
  mkdir -p "$cidir"
  cat > "$cidir/meta-data" <<META
instance-id: $name
local-hostname: $name
META
  cat > "$cidir/user-data" <<USER
#cloud-config
users:
  - name: $guest_user
    sudo: ALL=(ALL) NOPASSWD:ALL
    groups: wheel, video, render, input
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - $(cat "$key.pub")
ssh_pwauth: false
package_update: false
runcmd:
  - [ loginctl, enable-linger, $guest_user ]
  - [ systemctl, disable, --now, zram-swap.service ]
USER
  genisoimage -quiet -output "$seed" -volid cidata -joliet -rock "$cidir/user-data" "$cidir/meta-data"

  cat > "$state/$name.xml" <<XML
<domain type='kvm'>
  <name>$name</name>
  <memory unit='MiB'>6144</memory>
  <currentMemory unit='MiB'>6144</currentMemory>
  <vcpu placement='static'>4</vcpu>
  <os>
    <type arch='x86_64' machine='q35'>hvm</type>
    <boot dev='hd'/>
  </os>
  <features><acpi/><apic/></features>
  <cpu mode='host-passthrough' check='none'/>
  <clock offset='utc'/>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>destroy</on_crash>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2' cache='unsafe' discard='unmap'/>
      <source file='$disk'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file='$seed'/>
      <target dev='sda' bus='sata'/>
      <readonly/>
    </disk>
    <!-- passt rather than the default slirp, because passt is what supports declared port forwards
         on an unprivileged user network. Only loopback is forwarded, and only to the guest's ssh. -->
    <interface type='user'>
      <backend type='passt'/>
      <model type='virtio'/>
      <portForward proto='tcp' address='127.0.0.1'>
        <range start='$port' to='22'/>
      </portForward>
    </interface>
    <serial type='file'>
      <source path='$state/$name-console.log'/>
      <target type='isa-serial' port='0'><model name='isa-serial'/></target>
    </serial>
    <console type='file'>
      <source path='$state/$name-console.log'/>
      <target type='serial' port='0'/>
    </console>
    <!-- virtio-gpu, so a wlroots compositor in the guest has a real DRM device to bind. Nobody ever
         connects to this display: the run drives the guest over SSH only. -->
    <video><model type='virtio' heads='1' primary='yes'><acceleration accel3d='no'/></model></video>
    <graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/>
    <input type='tablet' bus='usb'/>
    <memballoon model='virtio'/>
    <rng model='virtio'><backend model='random'>/dev/urandom</backend></rng>
  </devices>
</domain>
XML

  virsh define "$state/$name.xml"
  virsh start "$name"
  echo "waiting for ssh on 127.0.0.1:$port"
  for _ in $(seq 1 120); do
    if ssh_guest true 2>/dev/null; then echo "guest is up"; return 0; fi
    /usr/bin/python3 -c 'import time; time.sleep(5)'
  done
  echo "guest never answered ssh; see $state/$name-console.log" >&2
  return 1
}

destroy() {
  virsh destroy "$name" 2>/dev/null || true
  virsh undefine "$name" --nvram 2>/dev/null || virsh undefine "$name" 2>/dev/null || true
  rm -f "$disk" "$seed"
  echo "removed domain $name, its overlay disk and its seed image; the shared base image stays"
}

case "${1:-}" in
  create) create ;;
  ssh) shift; ssh_guest "$@" ;;
  scp-in) shift; scp -i "$key" -P "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$1" "$guest_user@127.0.0.1:$2" ;;
  scp-out) shift; scp -i "$key" -P "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$guest_user@127.0.0.1:$1" "$2" ;;
  destroy) destroy ;;
  *) echo "usage: $0 {create|ssh|scp-in|scp-out|destroy}" >&2; exit 2 ;;
esac
