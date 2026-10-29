#!/usr/bin/python3
"""List and repair native application leases whose Orbit worker is gone.

A lease is claimed by one worker process. If that worker is killed before it hands the
application back, the compositor plugin still holds the lease and every later handoff of
that application client is refused. This module finds such leases and releases only those
whose owner is provably dead and which no live broker session still references.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.control import ActionControl
from src.native.host import read_plan
from src.native.transport import NativeTransport, action_response

LEASE = re.compile(r"[0-9a-f]{32}")


def worker_root(uid=None):
    return Path("/var/tmp/orbit-native-%d" % (os.getuid() if uid is None else uid))


def stat_start_ticks(stat_text):
    """Field 22 of /proc/<pid>/stat, counted after the last ')' because the name may hold anything."""
    close = stat_text.rfind(")")
    fields = stat_text[close + 1:].split() if close >= 0 else []
    # After ')' the first field is state (field 3), so field 22 is index 19.
    return int(fields[19]) if len(fields) > 19 and fields[19].isdigit() else None


def process_alive(pid, start, proc="/proc"):
    """Dead only when the process is gone or the pid now names another process; doubt means alive."""
    try:
        text = Path(proc, str(pid), "stat").read_text()
    except FileNotFoundError:
        return False
    except OSError:
        return True
    ticks = stat_start_ticks(text)
    return True if ticks is None else ticks == start


def command_mentions(path, proc="/proc"):
    """True while some live process was started with this worker directory on its command line."""
    needle = str(path).encode()
    try:
        entries = [entry for entry in os.listdir(proc) if entry.isdigit()]
    except OSError:
        return True
    for entry in entries:
        try:
            if needle in Path(proc, entry, "cmdline").read_bytes():
                return True
        except OSError:
            continue
    return False


def own_start_ticks():
    return stat_start_ticks(Path("/proc/self/stat").read_text())


def owner_token():
    """The claim token naming this process, as the plugin's pid:starttime."""
    ticks = own_start_ticks()
    return "%d:%d" % (os.getpid(), ticks) if ticks is not None else ""


def discover(root=None, proc="/proc"):
    """One record per worker directory still holding a handoff record."""
    found = []
    base = Path(root) if root is not None else worker_root()
    try:
        folders = sorted(base.iterdir())
    except OSError:
        return found
    for folder in folders:
        record_path = folder / "worker" / "handoff.json"
        try:
            record = json.loads(record_path.read_text())
        except (OSError, ValueError):
            continue
        lease = record.get("lease_id") if isinstance(record, dict) else None
        if not isinstance(lease, str) or not LEASE.fullmatch(lease):
            continue
        pid, start = record.get("pid"), record.get("start")
        if type(pid) is int and type(start) is int:
            alive = process_alive(pid, start, proc)
        else:
            alive = command_mentions(folder / "worker", proc)
        found.append({"lease_id": lease, "worker_dir": str(folder / "worker"), "worker_alive": alive,
                      "owner_pid": pid if type(pid) is int else None})
    return found


class Leases:
    def __init__(self, transport, root=None, live=(), proc="/proc"):
        self.transport, self.root, self.live, self.proc = transport, root, set(live), proc

    def info(self, lease):
        try:
            reply = json.loads(self.transport._exchange("ghost-application-info " + lease))
        except (ValueError, OSError):
            return "unknown"
        return reply.get("status", "unknown") if isinstance(reply, dict) else "unknown"

    def plugin_list(self):
        try:
            reply = json.loads(self.transport._exchange("ghost-application-list"))
        except (ValueError, OSError):
            return None
        return reply.get("leases") if isinstance(reply, dict) and isinstance(reply.get("leases"), list) else None

    def records(self):
        known = {}
        for entry in discover(self.root, self.proc):
            status = self.info(entry["lease_id"])
            if status == "unavailable":
                continue
            known[entry["lease_id"]] = entry | {"plugin_status": status, "source": "worker-directory"}
        for lease in self.plugin_list() or []:
            if not isinstance(lease, dict) or not LEASE.fullmatch(str(lease.get("lease_id", ""))):
                continue
            entry = known.setdefault(lease["lease_id"], {"lease_id": lease["lease_id"], "worker_dir": None,
                "worker_alive": None, "owner_pid": None, "plugin_status": "active", "source": "plugin"})
            entry.update(owner_pid=lease.get("owner_pid") or entry["owner_pid"], age_seconds=lease.get("age_seconds"),
                         plugin_owner_alive=lease.get("owner_alive"))
            if entry["worker_alive"] is None and lease.get("owner_alive") in ("yes", "no"):
                entry["worker_alive"] = lease["owner_alive"] == "yes"
        for entry in known.values():
            entry["session_live"] = entry["lease_id"] in self.live
            entry["releasable"] = (entry["plugin_status"] in ("active", "paused") and entry["worker_alive"] is False
                                   and not entry["session_live"])
            entry["reason"] = ("owner worker is gone and no broker session holds it" if entry["releasable"]
                               else "a broker session still holds it" if entry["session_live"]
                               else "owner worker is alive" if entry["worker_alive"]
                               else "owner is unknown" if entry["worker_alive"] is None else "lease is not active")
        return sorted(known.values(), key=lambda entry: entry["lease_id"])

    def release(self, lease, control=None, force_owner_dead=False):
        """Hand the application back. Refuses a live owner, a live session, or an unknown lease."""
        if not LEASE.fullmatch(lease):
            raise ValueError("A 32 character lease identity is required")
        entries = {entry["lease_id"]: entry for entry in self.records()}
        entry = entries.get(lease)
        if entry is None:
            raise ValueError("No active lease with that identity")
        if not (entry["releasable"] or (force_owner_dead and entry["worker_alive"] is False and entry["plugin_status"] in ("active", "paused"))):
            raise ValueError("Refused: " + entry["reason"])

        result = self.release_unchecked(lease, control)
        if entry.get("worker_dir"):
            (Path(entry["worker_dir"]) / "handoff.json").unlink(missing_ok=True)
        return result

    def reap_worker(self, worker_dir, control=None):
        """After a worker exited, release the lease its directory still records, whatever its session says."""
        try:
            record = json.loads((Path(worker_dir) / "handoff.json").read_text())
        except (OSError, ValueError):
            return {"released": False, "reason": "no handoff record"}
        lease = record.get("lease_id") if isinstance(record, dict) else None
        if not isinstance(lease, str) or not LEASE.fullmatch(lease):
            return {"released": False, "reason": "invalid handoff record"}
        if command_mentions(worker_dir, self.proc):
            return {"released": False, "reason": "worker is still running"}
        if self.info(lease) in ("active", "paused"):
            self.live.discard(lease)
            result = self.release_unchecked(lease, control)
            (Path(worker_dir) / "handoff.json").unlink(missing_ok=True)
            return {"released": True, **result}
        (Path(worker_dir) / "handoff.json").unlink(missing_ok=True)
        return {"released": False, "reason": "lease already gone"}

    def release_unchecked(self, lease, control):
        """Plugin handback then reap, journaled as owned cleanup when a control directory is given."""
        def handback():
            action_response("application-control", self.transport._exchange(f"ghost-application-control {lease} handback"))
            action_response("application-reap", self.transport._exchange("ghost-application-reap " + lease))
            return {"handedBack": True, "applicationClosed": False, "lease_id": lease}
        return control.cleanup("native-lease-release " + lease, handback) if control is not None else handback()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("plan", type=Path)
    parser.add_argument("control", type=Path)
    parser.add_argument("verb", choices=["list", "release", "reap-worker"])
    parser.add_argument("argument", nargs="?")
    parser.add_argument("--live-lease", action="append", default=[])
    args = parser.parse_args(argv)
    try:
        require_budget()
        plan = read_plan(args.plan.resolve())
        leases = Leases(NativeTransport(plan), live=args.live_lease)
        control = ActionControl(args.control)
        with control:
            if args.verb == "list":
                print(json.dumps({"ok": True, "result": {"leases": leases.records()}}))
            elif args.verb == "release":
                print(json.dumps({"ok": True, "result": leases.release(args.argument or "", control)}))
            else:
                print(json.dumps({"ok": True, "result": leases.reap_worker(args.argument or "", control)}))
        return 0
    except (OSError, ValueError, RuntimeError, ExceptionGroup) as error:
        print(json.dumps({"ok": False, "error": {"code": "CONFIG_REQUIRED", "message": str(error)}}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
