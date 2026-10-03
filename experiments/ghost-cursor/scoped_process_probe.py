#!/usr/bin/python3
"""Compile the actual plugin ownership code and exercise private systemd scopes."""
import hashlib
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.native.budget import require_budget
from src.native.lease import NativeLease, LeaseError, manager_environment, process_identity


def function(source, signature):
    start = source.index(signature)
    at = source.index("{", start)
    depth = 1
    end = at + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


PRELUDE = r'''
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <poll.h>
#include <format>
#include <fstream>
#include <iostream>
#include <regex>
#include <memory>
#include <vector>
#include <map>
'''

POLICY = r'''
struct wl_client {};
static wl_client client;
void wl_client_get_credentials(wl_client*, pid_t* pid, void*, void*) { *pid = getpid(); }
struct Surface { wl_client* client() { return &::client; } };
struct Workspace { std::string m_name = "special:ghost"; };
struct Window {
    bool m_isMapped = true;
    std::shared_ptr<Workspace> m_workspace = std::make_shared<Workspace>();
    std::shared_ptr<Surface> resource() { return std::make_shared<Surface>(); }
};
struct State {
    std::vector<std::shared_ptr<Window>> items{std::make_shared<Window>()};
    auto& windows() { return items; }
};
namespace Desktop { State state; State* windowState() { return &state; } }
static const std::string AGENT_SPACE = "special:ghost";
static std::map<pid_t, int> registeredProcesses;
static std::map<pid_t, std::unique_ptr<ScopedProcess>> scopedProcesses;
static void pruneRegisteredProcesses() {}
'''

MAIN = r'''
int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string{argv[1]} == "policy") {
        unsetenv("XDG_RUNTIME_DIR");
        if (agentClient(&client)) { std::cerr << "workspace alone enrolled an owner client\n"; return 1; }
        setenv("XDG_RUNTIME_DIR", "/run/user/test", 1);
        registeredProcesses[getpid()] = -1;
        if (agentClient(&client)) { std::cerr << "lab registration escaped into owner runtime\n"; return 1; }
        setenv("XDG_RUNTIME_DIR", "/tmp/gl-policy/runtime", 1);
        if (!agentClient(&client)) return 2;
        Desktop::state.items[0]->m_workspace->m_name = "1";
        if (agentClient(&client)) return 3;
        std::cout << "policy pass\n";
        return 0;
    }
    std::cout << "ready " << getpid() << std::endl;
    std::string unit;
    std::getline(std::cin, unit);
    ScopedProcess own(getpid(), unit);
    if (!own.valid()) return 4;
    for (const auto& invalid : {std::string{"sbarorbit.slice"}, unit + "-sibling",
                                std::string{"orbit-native-"} + std::string(32, 'f') + ".scope"}) {
        bool refused = false;
        try { ScopedProcess foreign(getpid(), invalid); }
        catch (const std::exception&) { refused = true; }
        if (!refused) return 5;
    }
    pid_t child = fork();
    if (child == 0) { pause(); _exit(0); }
    if (child < 0) return 6;
    ScopedProcess childIdentity(child, unit);
    if (!childIdentity.valid()) return 7;
    kill(child, SIGTERM);
    waitpid(child, nullptr, 0);
    if (childIdentity.valid()) return 8;
    pid_t keeper = fork();
    if (keeper == 0) { pause(); _exit(0); }
    if (keeper < 0) return 15;
    scopedProcesses[getpid()] = std::make_unique<ScopedProcess>(getpid(), unit);
    unsetenv("XDG_RUNTIME_DIR");
    if (!agentClient(&client)) return 9;
    std::cout << "registered pass" << std::endl;
    std::getline(std::cin, unit);
    if (own.valid() || agentClient(&client)) return 10;
    setenv("XDG_RUNTIME_DIR", "/tmp/gl-policy/runtime", 1);
    if (agentClient(&client)) return 11;
    pruneScopedProcesses();
    if (agentClient(&client)) return 13;
    std::cout << "migration revoked pass" << std::endl;
    std::getline(std::cin, unit);
    if (own.valid() || agentClient(&client)) return 14;
    kill(keeper, SIGTERM);
    waitpid(keeper, nullptr, 0);
    std::cout << "return remains revoked pass" << std::endl;
  } catch (const std::exception& error) {
    std::cerr << error.what() << std::endl;
    return 12;
  }
}
'''


def line(process):
    if not select.select([process.stdout], [], [], 5)[0]:
        raise RuntimeError(f"Native identity fixture did not answer; exit={process.poll()}")
    value = process.stdout.readline().strip()
    if not value:
        raise RuntimeError(f"Native identity fixture exited: {process.poll()}")
    return value


def main():
    require_budget()
    source_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("plugin") / "ghostinput.cpp"
    source = source_path.read_text()
    if "// Native scoped identity begin." in source:
        identity = source.split("// Native scoped identity begin.", 1)[1].split("// Native scoped identity end.", 1)[0]
        identity = identity[identity.index("class ScopedProcess"):]
    else:
        identity = "class ScopedProcess { public: ScopedProcess(pid_t, const std::string&) {} bool valid() const { return false; } };"
    policy = function(source, "static bool agentClient(")
    prune = function(source, "static void pruneScopedProcesses(") if "static void pruneScopedProcesses(" in source else "static void pruneScopedProcesses() { scopedProcesses.clear(); }"
    units = []
    cleanup = []
    process = None
    original_group = None
    with tempfile.TemporaryDirectory(prefix="orbit-scoped-process-") as work:
        cpp = Path(work) / "probe.cpp"
        binary = Path(work) / "probe"
        cpp.write_text(PRELUDE + identity + POLICY + prune + policy + MAIN)
        subprocess.run(["/usr/bin/g++", "-std=c++23", "-O0", str(cpp), "-o", str(binary)], check=True, timeout=30)
        subprocess.run([str(binary), "policy"], check=True, timeout=5)
        try:
            process = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            assert line(process) == f"ready {process.pid}"
            for index in range(2):
                unit = "orbit-native-" + uuid.uuid4().hex + ".scope"
                units.append(unit)
                subprocess.run(["/usr/bin/busctl", "--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
                                "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail", "3",
                                "PIDs", "au", "1", str(process.pid), "Slice", "s", "sbarorbit.slice",
                                "RuntimeMaxUSec", "t", "30000000", "0"], env=manager_environment(),
                               capture_output=True, timeout=3, check=True)
                deadline = time.monotonic() + 3
                while True:
                    try:
                        lease = NativeLease(unit)
                        if lease.contains(process_identity(process.pid)):
                            break
                    except LeaseError:
                        pass
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Native scope did not adopt its fixture")
                    time.sleep(0.02)
                if index == 0:
                    original_group = lease.group
                process.stdin.write(unit + "\n")
                process.stdin.flush()
                assert line(process) == ("registered pass" if index == 0 else "migration revoked pass")
            assert original_group is not None
            (Path("/sys/fs/cgroup") / original_group.removeprefix("/") / "cgroup.procs").write_text(str(process.pid))
            assert NativeLease(units[0]).contains(process_identity(process.pid))
            process.stdin.write("back\n")
            process.stdin.flush()
            assert line(process) == "return remains revoked pass"
            assert process.wait(timeout=5) == 0
        finally:
            try:
                if process is not None and process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=3)
            except BaseException as error:
                cleanup.append(str(error))
            for unit in reversed(units):
                try:
                    properties = subprocess.run(["/usr/bin/systemctl", "--user", "show", unit,
                                                 "--property=LoadState,ActiveState"], env=manager_environment(),
                                                capture_output=True, text=True, timeout=3, check=True).stdout
                    if "LoadState=not-found" in properties and "ActiveState=inactive" in properties:
                        continue
                    subprocess.run(["/usr/bin/systemctl", "--user", "stop", unit], env=manager_environment(),
                                   capture_output=True, timeout=4, check=True)
                except BaseException as error:
                    cleanup.append(str(error))
            if cleanup:
                raise RuntimeError(f"Native identity cleanup failed: {cleanup}")
    print(json.dumps({"source_sha256": hashlib.sha256(source.encode()).hexdigest(), "workspace_only_refusal": "pass",
                      "scope_registration": "pass", "foreign_scope_refusal": "pass", "dead_process_revocation": "pass",
                      "scope_migration_revocation": "pass", "expired_lab_fallback_refusal": "pass",
                      "return_to_original_scope_stays_revoked": "pass",
                      "cleanup": "pass", "owner_desktop_activation": "not performed"}))


if __name__ == "__main__":
    main()
