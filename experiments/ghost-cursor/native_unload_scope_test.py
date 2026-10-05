#!/usr/bin/python3
"""Compile the actual cgroup population parser and reject incomplete evidence."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from scoped_process_probe import function, require_budget


class PopulationTest(unittest.TestCase):
    def test_actual_parser_refuses_unknown_population(self):
        require_budget()
        source = Path(os.environ.get("ORBIT_UNLOAD_TEST_SOURCE", str(Path(__file__).with_name("plugin") / "ghostinput.cpp")))
        parser = function(source.read_text(), "static bool populated(")
        program = r'''
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include <iostream>
'''+parser+r'''
int main() {
    const std::vector<std::pair<std::string, int>> cases{
        {"populated 0\nfrozen 0\n", 0}, {"frozen 1\npopulated 1\n", 1},
        {"", -1}, {"frozen 0\n", -1}, {"populated 2\n", -1},
        {"populated 0 extra\n", -1}, {"populated 0\nfrozen\n", -1},
        {"populated 0\npopulated 0\n", -1}, {"populated\n", -1},
        {"populated false\n", -1}
    };
    for (const auto& [data, expected] : cases) {
        int actual = -1;
        try { actual = populated(data) ? 1 : 0; }
        catch (const std::runtime_error&) {}
        if (actual != expected) { std::cerr << "Population refusal mismatch: " << data; return 1; }
    }
    std::cout << "10 population checks\n";
}
'''
        with tempfile.TemporaryDirectory(prefix="orbit-population-test-") as directory:
            cpp, binary = Path(directory) / "probe.cpp", Path(directory) / "probe"
            cpp.write_text(program)
            subprocess.run(["/usr/bin/g++", "-std=c++23", str(cpp), "-o", str(binary)], check=True, timeout=30)
            result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "10 population checks\n")


if __name__ == "__main__":
    unittest.main()
