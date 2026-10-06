"""Compile the actual claim admission expression against protocol lifecycle fixtures.

Run only on an isolated runner after the owner compositor incident.
ORBIT_DATA_CONTROL_SOURCE selects the broken or corrected source for red/green.
"""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

SOURCE = Path(os.environ.get("ORBIT_DATA_CONTROL_SOURCE", str(Path(__file__).resolve().parents[1] / "experiments/ghost-cursor/plugin/ghostinput.cpp")))


def body(source, signature):
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


FIXTURE = r"""
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
struct wl_client {};
struct Device { wl_client* owner; wl_client* client() const { return owner; } };
struct Protocol {
    std::vector<std::shared_ptr<Device>> m_devices;
    std::shared_ptr<Device> dataDeviceForClient(wl_client* owner) {
        for (const auto& item : m_devices) if (item->client() == owner) return item;
        return {};
    }
};
namespace PROTO { std::shared_ptr<Protocol> dataWlr, extDataDevice; }
"""
MAIN = r"""
int main(int argc, char** argv) {
    if (argc != 2) return 10;
    wl_client target, other;
    std::string name = argv[1];
    if (name == "absent") return admission(&target) == 0 ? 0 : 11;
    PROTO::extDataDevice = std::make_shared<Protocol>();
    auto& devices = PROTO::extDataDevice->m_devices;
    if (name == "empty") return admission(&target) == 0 ? 0 : 12;
    if (name == "unrelated") devices.push_back(std::make_shared<Device>(Device{&other}));
    if (name == "match" || name == "match-then-null") devices.push_back(std::make_shared<Device>(Device{&target}));
    if (name == "null" || name == "match-then-null") devices.push_back({});
    if (name == "null-owner") devices.push_back(std::make_shared<Device>(Device{nullptr}));
    int expected = name == "match" ? 1 : name == "unrelated" ? 0 : 2;
    return admission(&target) == expected ? 0 : 13;
}
"""


class DeviceAdmissionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = SOURCE.read_text()
        claim = body(source, "static std::string claimApplication(")
        expression = re.search(r'if \((.*?)\)\s*throw std::runtime_error\("existing application uses unsupported data-control devices"\)', claim, re.S)
        if expression is None:
            raise RuntimeError("Claim admission expression was not found")
        # The preceding guards also contain if statements. Start at the device lookup.
        condition = expression[1]
        start = condition.rfind("clientHasDataControlDevice(PROTO::dataWlr")
        if start < 0:
            start = condition.rfind("(PROTO::dataWlr &&")
        if start < 0:
            raise RuntimeError("No recognized data-control admission path")
        condition = condition[start:]
        helper = ""
        if "clientHasDataControlDevice" in condition:
            helper = "template <typename Protocol>\n" + body(source, "static bool clientHasDataControlDevice(")
        wrapper = "int admission(wl_client* client) { try { return (" + condition + ") ? 1 : 0; } catch (...) { return 2; } }\n"
        cls.work = tempfile.TemporaryDirectory(prefix="orbit-device-admission-")
        cls.addClassCleanup(cls.work.cleanup)
        root = Path(cls.work.name)
        cpp = root / "probe.cpp"
        cpp.write_text(FIXTURE + helper + wrapper + MAIN)
        cls.binary = root / "probe"
        subprocess.run(["g++", "-std=c++23", "-O0", str(cpp), "-o", str(cls.binary)], check=True, timeout=30)

    def test_device_lifetimes(self):
        for name in ("absent", "empty", "unrelated", "match", "null", "null-owner", "match-then-null"):
            with self.subTest(name=name):
                result = subprocess.run([str(self.binary), name], capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
