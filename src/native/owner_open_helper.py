"""Replace the compositor launch helper with the requested application."""
import json
import os
from pathlib import Path
import stat
import re
import sys
import time


def main(path):
    path = Path(path)
    info = path.lstat()
    if (path.resolve() != path or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 32768):
        raise RuntimeError("Invalid private application launch specification")
    spec = json.loads(path.read_text())
    receipt = Path(spec["receipt"])
    if receipt.parent != path.parent or not 0 < spec["expires"] - time.time() <= 15:
        raise RuntimeError("Expired or invalid application launch specification")
    fields = Path(f"/proc/{os.getpid()}/stat").read_text().rsplit(")", 1)[1].split()
    temporary = receipt.with_name(receipt.name + ".writing")
    with temporary.open("x") as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump([os.getpid(), int(fields[19])], stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.link(temporary, receipt)
    temporary.unlink()
    if "cwd" in spec:
        os.chdir(spec["cwd"])
    environment = None
    if "activationToken" in spec:
        token = spec["activationToken"]
        if not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{32}", token):
            raise RuntimeError("Invalid original application activation token")
        environment = {**os.environ, "XDG_ACTIVATION_TOKEN": token, "DESKTOP_STARTUP_ID": token}
    if "scope" in spec:
        if not isinstance(spec["scope"], str) or not re.fullmatch(r"orbit-open-[0-9a-f]{32}\.scope", spec["scope"]):
            raise RuntimeError("Invalid original application scope")
        # Scope mode inherits the real owner environment and cwd. It neither
        # creates a desktop/profile nor ties application lifetime to this worker.
        argv = ["/usr/bin/systemd-run", "--user", "--scope", "--quiet", "--collect",
                 "--unit=" + spec["scope"], "--slice=app.slice", "--expand-environment=no", "--", *spec["argv"]]
        return os.execve("/usr/bin/systemd-run", argv, environment) if environment is not None else os.execv("/usr/bin/systemd-run", argv)
    if environment is not None:
        return os.execve(spec["argv"][0], spec["argv"], environment)
    os.execv(spec["argv"][0], spec["argv"])


if __name__ == "__main__":
    main(sys.argv[1])
