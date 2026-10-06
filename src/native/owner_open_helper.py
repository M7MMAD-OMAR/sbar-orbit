"""Replace the compositor launch helper with the requested application."""
import json
import os
from pathlib import Path
import stat
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
    os.execv(spec["argv"][0], spec["argv"])


if __name__ == "__main__":
    main(sys.argv[1])
