import json
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path


class TunnelControl(unittest.TestCase):
    def test_exact_target_and_opaque_payload(self):
        with tempfile.TemporaryDirectory(prefix="orbit-nextcloud-tunnel-control-", dir="/var/tmp") as root:
            root = Path(root)
            directory = root / "nextcloud-config"
            directory.mkdir(mode=0o700)
            config = directory / "nextcloud.cfg"
            summary = root / "tunnel-summary.json"
            upstream = socket.socket()
            upstream.bind(("127.0.0.1", 0))
            upstream.listen()
            target_port = upstream.getsockname()[1]
            def echo():
                connection, _ = upstream.accept()
                with connection:
                    while data := connection.recv(65536):
                        connection.sendall(data)
            worker = threading.Thread(target=echo, daemon=True)
            worker.start()
            fixture = ("[Accounts]\n0\\url=https://127.0.0.1:" + str(target_port) +
                       "\n0\\networkProxyType=0\n0\\networkProxyHostName=\n0\\networkProxyPort=0\n"
                       "0\\networkProxyNeedsAuth=false\n0\\networkProxyUser=\n0\\opaque=@ByteArray(\\x01)\n")
            config.write_text(fixture)
            process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("nextcloud-account-tunnel.py")), str(config), str(summary)],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                announced = json.loads(process.stdout.readline())
                self.assertTrue(announced["ready"])
                port = announced["port"]
                with socket.create_connection(("127.0.0.1", port), timeout=2) as selected:
                    selected.sendall(f"CONNECT 127.0.0.1:{target_port} HTTP/1.1\r\n\r\n".encode())
                    self.assertIn(b"200 Connection Established", selected.recv(1024))
                    payload = b"\x16\x03\x03opaque-fixture-bytes\x00\xff"
                    selected.sendall(payload)
                    self.assertEqual(selected.recv(1024), payload)
                for request in (f"CONNECT 127.0.0.2:{target_port} HTTP/1.1", "CONNECT 127.0.0.1:1 HTTP/1.1", "GET / HTTP/1.1"):
                    with socket.create_connection(("127.0.0.1", port), timeout=2) as blocked:
                        blocked.sendall((request + "\r\n\r\n").encode())
                        self.assertIn(b"403 Forbidden", blocked.recv(1024))
                self.assertIn("0\\opaque=@ByteArray(\\x01)", config.read_text())
                self.assertIn("0\\networkProxyHostName=127.0.0.1", config.read_text())
            finally:
                process.stdin.close()
                process.wait(timeout=3)
                if process.returncode:
                    self.fail(process.stderr.read().decode())
                upstream.close()
                process.stdout.close()
                process.stderr.close()
            result = json.loads(summary.read_text())
            self.assertEqual(result["acceptedTunnels"], 1)
            self.assertEqual(result["blockedRequests"], 3)
            self.assertGreater(result["clientBytes"], 0)
            self.assertEqual(result["clientBytes"], result["serverBytes"])


if __name__ == "__main__":
    unittest.main()
