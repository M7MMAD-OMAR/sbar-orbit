#!/usr/bin/python3
"""Exercise actual plugin selection callbacks with real Wayland resource lifetimes."""
import os
from pathlib import Path
import subprocess
import signal
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from scoped_process_probe import function, require_budget


def run(argv, *, timeout, capture_output=False, text=False, check=False):
    child = subprocess.Popen(argv, start_new_session=True, text=text,
                             stdout=subprocess.PIPE if capture_output else None,
                             stderr=subprocess.PIPE if capture_output else None)
    errors = []
    output = error = None
    try:
        output, error = child.communicate(timeout=timeout)
    except BaseException as primary:
        errors.append(primary)
    if child.returncode is None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except BaseException as cleanup:
            errors.append(cleanup)
    try:
        child.wait(timeout=2)
    except BaseException as cleanup:
        errors.append(cleanup)
    for failure in errors:
        if isinstance(failure, KeyboardInterrupt):
            remaining = [item for item in errors if item is not failure]
            if remaining:
                raise failure from BaseExceptionGroup("Selection deadline cleanup failed", remaining)
            raise failure
    if len(errors) == 1:
        raise errors[0]
    if errors:
        raise BaseExceptionGroup("Selection fixture and cleanup failed", errors)
    result = subprocess.CompletedProcess(argv, child.returncode, output, error)
    if check and result.returncode:
        raise subprocess.CalledProcessError(result.returncode, argv, output, error)
    return result


FIXTURE = r'''
#include <wayland-server-core.h>
#include <wayland-server-protocol.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cstring>
#include <functional>
#include <format>
#include <iostream>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>
template<typename T> using SP = std::shared_ptr<T>;
static std::set<wl_client*> admitted;
static bool agentClient(wl_client* client) { return admitted.contains(client); }
static int ownerPrimary = 0, ownerClipboard = 0, ownerDrag = 0;
struct Lease {};
static Lease lease;
static std::set<wl_client*> leased;
static Lease* applicationLeaseForClient(wl_client* client) { return leased.contains(client) ? &lease : nullptr; }
static std::vector<wl_client*> privatePrimaryRecipients, privateClipboardRecipients;
static std::string applicationFailure;
static void recordApplicationFailure(wl_client*, const char* error) { applicationFailure = error; }
struct CZwpPrimarySelectionDeviceV1 {
    wl_resource* handle;
    struct { std::function<void(CZwpPrimarySelectionDeviceV1*, wl_resource*, uint32_t)> setSelection; } requests;
    wl_resource* resource() { return handle; }
    wl_client* client() { return wl_resource_get_client(handle); }
    template<typename F> void setSetSelection(F callback) { requests.setSelection = callback; }
};
struct CWlDataDevice {
    wl_resource* handle;
    struct {
        std::function<void(CWlDataDevice*, wl_resource*, uint32_t)> setSelection;
        std::function<void(CWlDataDevice*, wl_resource*, wl_resource*, wl_resource*, uint32_t)> startDrag;
    } requests;
    wl_resource* resource() { return handle; }
    wl_client* client() { return wl_resource_get_client(handle); }
    template<typename F> void setSetSelection(F callback) { requests.setSelection = callback; }
};
struct CWLDataSourceResource {
    static SP<CWLDataSourceResource> fromResource(wl_resource*) { return std::make_shared<CWLDataSourceResource>(); }
    void markUsed() {}
};
struct CPrimarySelectionSource {
    static SP<CPrimarySelectionSource> fromResource(wl_resource*) { return std::make_shared<CPrimarySelectionSource>(); }
};
static void sendPrivatePrimarySelection(wl_client* client, SP<CPrimarySelectionSource>) { privatePrimaryRecipients.push_back(client); }
static void sendPrivateClipboardSelection(wl_client* client, SP<CWLDataSourceResource>) { privateClipboardRecipients.push_back(client); }
struct CZwlrDataControlDeviceV1 {};
struct CExtDataControlDeviceV1 {};
static std::map<wl_resource*, int> wlrGuards, extGuards;
template<typename T> static void guardDataControl(T*, std::map<wl_resource*, int>&) { throw std::runtime_error("unexpected data-control fixture request"); }
template<typename T> struct Device {
    SP<T> m_resource;
    wl_client* client() { return m_resource->client(); }
};
struct Primary { std::vector<SP<Device<CZwpPrimarySelectionDeviceV1>>> m_devices; };
struct Data {
    std::vector<SP<Device<CWlDataDevice>>> m_devices;
    std::vector<wl_client*> offers;
    void sendSelectionToDevice(SP<Device<CWlDataDevice>> device, SP<CWLDataSourceResource>) { offers.push_back(device->client()); }
};
namespace PROTO { static SP<Primary> primarySelection = std::make_shared<Primary>(); static SP<Data> data = std::make_shared<Data>(); }
struct Surface { wl_client* client() { return nullptr; } };
struct Workspace { std::string m_name; };
struct Window { bool m_isMapped = false; SP<Workspace> m_workspace; SP<Surface> resource() { return nullptr; } };
struct State { std::vector<SP<Window>> items; auto& windows() { return items; } };
namespace Desktop { static State state; static State* windowState() { return &state; } }
static std::string selectionDiagnostic;
using PrimaryHandler = std::function<void(CZwpPrimarySelectionDeviceV1*, wl_resource*, uint32_t)>;
struct SPrimaryGuard { CZwpPrimarySelectionDeviceV1* device; PrimaryHandler original; wl_listener destroy{}; };
static std::map<wl_resource*, SPrimaryGuard> primaryGuards;
using ClipboardHandler = std::function<void(CWlDataDevice*, wl_resource*, uint32_t)>;
struct SClipboardGuard { CWlDataDevice* device; ClipboardHandler original;
    std::function<void(CWlDataDevice*, wl_resource*, wl_resource*, wl_resource*, uint32_t)> originalStartDrag;
    wl_listener destroy{}; };
static std::map<wl_resource*, SClipboardGuard> clipboardGuards;
static std::map<wl_client*, wl_listener> selectionClients;
'''

MAIN = r'''
static const wl_interface primaryInterface{"zwp_primary_selection_device_v1", 1, 0, nullptr, 0, nullptr};
static const wl_message selectionMessage{"set_selection", "?ou", nullptr};
template<typename T> static SP<T> device(wl_client* client) {
    auto raw = std::make_shared<T>();
    raw->handle = wl_resource_create(client, std::is_same_v<T, CWlDataDevice> ? &wl_data_device_interface : &primaryInterface, 1, 0);
    if (!raw->handle) throw std::runtime_error("resource allocation failed");
    raw->setSetSelection([](T*, wl_resource*, uint32_t) {
        if constexpr (std::is_same_v<T, CWlDataDevice>) ++ownerClipboard;
        else ++ownerPrimary;
    });
    if constexpr (std::is_same_v<T, CWlDataDevice>)
        raw->requests.startDrag = [](CWlDataDevice*, wl_resource*, wl_resource*, wl_resource*, uint32_t) { ++ownerDrag; };
    auto wrapper = std::make_shared<Device<T>>(); wrapper->m_resource = raw;
    if constexpr (std::is_same_v<T, CWlDataDevice>) PROTO::data->m_devices.push_back(wrapper);
    else PROTO::primarySelection->m_devices.push_back(wrapper);
    return raw;
}
template<typename T> static void request(SP<T> raw) {
    wl_protocol_logger_message message{}; message.resource = raw->handle; message.message = &selectionMessage;
    selectionRequest(nullptr, WL_PROTOCOL_LOGGER_REQUEST, &message);
    raw->requests.setSelection(raw.get(), nullptr, 7);
}
int main(int argc, char** argv) {
    if (argc != 2) return 2;
    auto display = wl_display_create();
    int agentSockets[2], ownerSockets[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, agentSockets) || socketpair(AF_UNIX, SOCK_STREAM, 0, ownerSockets)) return 3;
    auto agent = wl_client_create(display, agentSockets[0]); auto owner = wl_client_create(display, ownerSockets[0]);
    admitted.insert(agent);
    auto primary = device<CZwpPrimarySelectionDeviceV1>(agent); auto clipboard = device<CWlDataDevice>(agent);
    auto ownerDevice = device<CWlDataDevice>(owner);
    const std::string test = argv[1];
    if (test == "lease" || test == "lease-drag") leased.insert(agent);
    if (test == "before-first") { guardPrimarySelection(agent); guardClipboard(agent); }
    else { request(primary); request(clipboard); }
    if (ownerPrimary || ownerClipboard) { std::cerr << "admitted selection reached owner handler"; return 4; }
    if (test == "lease" || test == "lease-drag") {
        if (privatePrimaryRecipients != std::vector<wl_client*>{agent} ||
            privateClipboardRecipients != std::vector<wl_client*>{agent} || !PROTO::data->offers.empty()) {
            std::cerr << "leased selection did not use private recipients"; return 14;
        }
        if (test == "lease-drag") {
            clipboard->requests.startDrag(clipboard.get(), nullptr, nullptr, nullptr, 7);
            if (ownerDrag || applicationFailure.empty()) { std::cerr << "leased drag escaped guard"; return 15; }
        }
        restoreSelectionGuards(primaryGuards); restoreSelectionGuards(clipboardGuards); clearSelectionClients();
        clipboard->requests.startDrag(clipboard.get(), nullptr, nullptr, nullptr, 7);
        if (ownerDrag != 1) { std::cerr << "unload did not restore drag callback"; return 16; }
        wl_client_destroy(agent); wl_client_destroy(owner); close(agentSockets[1]); close(ownerSockets[1]); wl_display_destroy(display);
        return 0;
    }
    if (!privatePrimaryRecipients.empty() || !privateClipboardRecipients.empty()) {
        std::cerr << "owned client without lease entered lease-only selection path"; return 17;
    }
    admitted.erase(agent);
    if (test == "existing") {
        request(primary); request(clipboard);
        if (ownerPrimary || ownerClipboard) { std::cerr << "revoked existing device reached owner handler"; return 5; }
    } else if (test == "new" || test == "before-first") {
        request(device<CZwpPrimarySelectionDeviceV1>(agent)); request(device<CWlDataDevice>(agent));
        if (ownerPrimary || ownerClipboard) { std::cerr << "revoked new device reached owner handler"; return 6; }
    } else if (test == "owner") {
        request(ownerDevice);
        if (ownerClipboard != 1 || ownerPrimary) { std::cerr << "unknown owner handler changed"; return 7; }
        for (auto recipient : PROTO::data->offers)
            if (recipient != agent) { std::cerr << "private offer reached owner client"; return 8; }
    } else if (test == "lifetime") {
        if (!selectionClients.contains(agent)) { std::cerr << "private connection not retained"; return 9; }
        wl_resource_destroy(primary->handle);
        if (!primaryGuards.empty()) { std::cerr << "destroyed device retained"; return 10; }
        wl_client_destroy(agent);
        if (!selectionClients.empty() || !clipboardGuards.empty()) { std::cerr << "destroyed client retained"; return 11; }
        wl_client_destroy(owner); close(agentSockets[1]); close(ownerSockets[1]); wl_display_destroy(display);
        return 0;
    } else return 12;
    restoreSelectionGuards(primaryGuards); restoreSelectionGuards(clipboardGuards); clearSelectionClients();
    const auto before = ownerClipboard;
    clipboard->requests.setSelection(clipboard.get(), nullptr, 7);
    if (ownerClipboard != before + 1 || !selectionClients.empty()) { std::cerr << "unload did not restore callbacks"; return 13; }
    wl_client_destroy(agent); wl_client_destroy(owner); close(agentSockets[1]); close(ownerSockets[1]); wl_display_destroy(display);
}
'''


class SelectionGuardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_budget()
        cls.work = tempfile.TemporaryDirectory(prefix="orbit-selection-guard-")
        cls.addClassCleanup(cls.work.cleanup)
        directory = Path(cls.work.name)
        source = Path(os.environ.get("ORBIT_SELECTION_TEST_SOURCE", str(Path(__file__).with_name("plugin") / "ghostinput.cpp"))).read_text()
        functions = []
        for signature in ("static bool privateSelectionClient(", "static void clearSelectionClients("):
            if signature in source:
                functions.append(function(source, signature))
            elif "bool" in signature:
                functions.append("static bool privateSelectionClient(wl_client* client) { return agentClient(client); }")
            else:
                functions.append("static void clearSelectionClients() {}")
        for signature in ("static void installSelectionGuard(", "static void restoreSelectionGuards(",
                          "static void guardPrimarySelection(", "static void guardClipboard(", "static void selectionRequest("):
            body = function(source, signature)
            if "installSelectionGuard" in signature:
                body = "template<typename Device, typename Guards, typename Destroy, typename Configure>\n" + body
            if "restoreSelectionGuards" in signature:
                body = "template<typename Guards>\n" + body
            functions.append(body)
        cpp = directory / "probe.cpp"
        cls.binary = directory / "probe"
        cpp.write_text(FIXTURE + "\n".join(functions) + MAIN)
        flags = run(["pkg-config", "--cflags", "--libs", "wayland-server"], capture_output=True,
                    text=True, check=True, timeout=5).stdout.split()
        run(["/usr/bin/g++", "-std=c++23", str(cpp), "-o", str(cls.binary), *flags], check=True, timeout=30)

    def check(self, case):
        result = run([str(self.binary), case], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_existing_device_stays_private_after_revocation(self):
        self.check("existing")

    def test_new_device_stays_private_after_revocation(self):
        self.check("new")

    def test_direct_guard_precedes_first_request_and_revocation(self):
        self.check("before-first")

    def test_unknown_owner_and_offers_are_unchanged(self):
        self.check("owner")
        self.check("lease")
        self.check("lease-drag")

    def test_destroy_and_unload_clear_retained_resources(self):
        self.check("lifetime")

    def test_cleanup_failure_preserves_suite_interrupt(self):
        child = Mock(returncode=None)
        interrupt = KeyboardInterrupt("total deadline")
        child.communicate.side_effect = interrupt
        child.wait.side_effect = subprocess.TimeoutExpired("fixture", 2)
        with patch("subprocess.Popen", return_value=child), patch("os.killpg", side_effect=OSError("kill refused")):
            with self.assertRaises(KeyboardInterrupt) as caught:
                run(["fixture"], timeout=5)
        child.wait.assert_called_once_with(timeout=2)
        self.assertIs(caught.exception, interrupt)
        self.assertIsInstance(caught.exception.__cause__, BaseExceptionGroup)
        failures = caught.exception.__cause__.exceptions
        self.assertEqual(len(failures), 2)
        self.assertIsInstance(failures[0], OSError)
        self.assertIsInstance(failures[1], subprocess.TimeoutExpired)

    def test_cleanup_failure_keeps_original_failure(self):
        child = Mock(returncode=None)
        primary = RuntimeError("fixture failed")
        child.communicate.side_effect = primary
        child.wait.side_effect = subprocess.TimeoutExpired("fixture", 2)
        with patch("subprocess.Popen", return_value=child), patch("os.killpg", side_effect=OSError("kill refused")):
            with self.assertRaises(BaseExceptionGroup) as caught:
                run(["fixture"], timeout=5)
        child.wait.assert_called_once_with(timeout=2)
        self.assertEqual(len(caught.exception.exceptions), 3)
        self.assertIs(caught.exception.exceptions[0], primary)

    def test_deadline_aborts_and_reaps_subprocess(self):
        result = run(["/usr/bin/python3", __file__, "--deadline-control"],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "deadline cleanup pass\n")


if __name__ == "__main__":
    def deadline(signum, frame):
        raise KeyboardInterrupt("Selection callback fixture exceeded its total 40 second budget")

    signal.signal(signal.SIGALRM, deadline)
    if sys.argv[1:] == ["--deadline-control"]:
        require_budget()
        with tempfile.TemporaryDirectory(prefix="orbit-selection-deadline-") as directory:
            record = Path(directory) / "child.pid"
            signal.alarm(2)
            try:
                run(["/usr/bin/python3", "-c",
                                "import os,sys,time;from pathlib import Path;Path(sys.argv[1]).write_text(str(os.getpid()));time.sleep(30)",
                                str(record)], check=True, timeout=5)
            except KeyboardInterrupt:
                signal.alarm(0)
                assert record.is_file(), "deadline child did not start"
                assert not Path("/proc", record.read_text()).exists(), "deadline child survived"
            else:
                raise RuntimeError("Selection deadline did not abort the subprocess")
        print("deadline cleanup pass")
        sys.exit(0)
    signal.alarm(40)
    unittest.main()
