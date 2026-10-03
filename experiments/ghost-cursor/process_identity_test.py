#!/usr/bin/python3
"""Private-lab checks for launch ownership when an app strips its environment."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from lab import guard
from process_scope import identity, launch_identity, processes, terminate

guard(os.environ)


class LaunchIdentityChecks(unittest.TestCase):
    def test_root_start_time_is_required_without_launch_tag(self):
        environment = dict(os.environ)
        environment.pop("ORBIT_AGENT_LAUNCH_ID", None)
        child = subprocess.Popen(["/usr/bin/python3", "-c", "import sys; sys.stdin.read()"],
                                 env=environment, stdin=subprocess.PIPE)
        item = identity(child.pid)
        self.assertIsNotNone(item)
        try:
            self.assertNotIn(item, processes("missing-launch-token"))
            self.assertIn(item, processes("missing-launch-token", item))
            self.assertNotIn(item, processes("missing-launch-token", (item[0], item[1] + 1)))
        finally:
            terminate({item})
            child.wait(timeout=5)
            child.stdin.close()

    def test_marker_retains_identity_and_refuses_pid_only(self):
        with tempfile.TemporaryDirectory(dir=os.environ["XDG_STATE_HOME"]) as temporary:
            marker = Path(temporary) / "marker"
            marker.write_text("")
            self.assertIsNone(launch_identity(marker))
            item = identity(os.getpid())
            marker.write_text(json.dumps(item))
            self.assertEqual(launch_identity(marker), item)
            for invalid in (os.getpid(), [os.getpid()], [os.getpid(), -1], [True, 5]):
                marker.write_text(json.dumps(invalid))
                with self.assertRaises(ValueError):
                    launch_identity(marker)


if __name__ == "__main__":
    unittest.main()
