#!/usr/bin/python3
"""Owner-configured action modes and a synchronized private action journal.

This is a controller for cooperative callers, not an OS security boundary.
Direct compositor IPC remains a separate experimental surface.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid


import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.control import ActionControl, ControlError


def cli_request(argv):
    return "ghost-cli " + json.dumps(argv, separators=(",", ":"), ensure_ascii=True)


def dispatch_native(request):
    from ghost import _hypr
    parts = request.split()
    commands = {"ghost-key", "ghost-type", "ghost-texthex", "ghost-click", "ghost-move", "ghost-scroll",
                "ghost-cursor", "ghost-hide-cursor", "ghost-release", "ghost-state"}
    if not parts or parts[0] not in commands:
        raise ControlError("Unknown native action; mode changes use the owner settings entry point")
    response = _hypr(request).strip()
    if response == "ok" and parts[0] != "ghost-state":
        return response
    if parts[0] in ("ghost-type", "ghost-texthex") and re.fullmatch(r"ok \d+ keys", response):
        return response
    if parts[0] == "ghost-state":
        try:
            state = json.loads(response)
        except json.JSONDecodeError:
            pass
        else:
            if isinstance(state, dict) and all(isinstance(state.get(key), bool) for key in ("suspended", "render_unfocused")):
                return response
    raise ControlError(response)


def controlled_native(request):
    from lab import guard
    guard(os.environ)
    directory = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
    with ActionControl(directory) as control:
        return control.execute(request, lambda: dispatch_native(request))


def main():
    from lab import guard
    guard(os.environ)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    settings = sub.add_parser("mode", help="Owner settings entry point")
    settings.add_argument("value", choices=["protected", "full"])
    approval = sub.add_parser("approve", help="Approve one exact request")
    approval.add_argument("request")
    sub.add_parser("status")
    cli = sub.add_parser("cli-request", help="Print the exact approval request for ghost.py arguments")
    cli.add_argument("argv", nargs=argparse.REMAINDER)
    action = sub.add_parser("act")
    action.add_argument("request")
    args = parser.parse_args()
    if args.command == "cli-request":
        print(cli_request(args.argv[1:] if args.argv[:1] == ["--"] else args.argv))
        return 0
    directory = Path(os.environ["XDG_STATE_HOME"]) / "orbit-native-control"
    with ActionControl(directory) as control:
        if args.command == "mode":
            result = control.configure(mode=args.value)
        elif args.command == "approve":
            result = control.configure(approve=args.request)
        elif args.command == "status":
            result = control.inspect()
            print(json.dumps(result))
            return 1 if result["unresolved"] else 0
        else:
            result = control.execute(args.request, lambda: dispatch_native(args.request))
        print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
