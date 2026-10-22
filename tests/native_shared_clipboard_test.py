"""Actual shared-selection callbacks in a bounded protocol-resource fixture.

This component check does not establish real application input or capture.
"""
from pathlib import Path
import shlex
import os
import subprocess
import tempfile
import unittest

SOURCE = Path(os.environ.get("ORBIT_CLIPBOARD_SOURCE", str(Path(__file__).resolve().parents[1] / "experiments/ghost-cursor/plugin/ghostinput.cpp")))


def definition(source, signature):
    start = source.index(signature)
    opening = source.index("{", start)
    depth, end = 1, opening + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


FIXTURE = r"""
#include <wayland-server-core.h>
#include <wayland-server-protocol.h>
#include <sys/socket.h>
#include <unistd.h>
#include <functional>
#include <memory>
#include <map>
#include <set>
#include <stdexcept>
#include <vector>
template<typename T> using SP = std::shared_ptr<T>;
struct IDataSource { virtual ~IDataSource() = default; };
struct CWLDataSourceResource : IDataSource {
    static SP<CWLDataSourceResource> fromResource(wl_resource*) { return std::make_shared<CWLDataSourceResource>(); }
    void markUsed() {}
};
struct CPrimarySelectionSource : IDataSource {
    static SP<CPrimarySelectionSource> fromResource(wl_resource*) { return std::make_shared<CPrimarySelectionSource>(); }
};
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
template<typename T> struct Device { SP<T> m_resource; wl_client* client() { return m_resource->client(); } };
struct Data { std::vector<SP<Device<CWlDataDevice>>> m_devices; void sendSelectionToDevice(SP<Device<CWlDataDevice>>, SP<CWLDataSourceResource>) {} };
struct Primary { std::vector<SP<Device<CZwpPrimarySelectionDeviceV1>>> m_devices; };
namespace PROTO { SP<Data> data = std::make_shared<Data>(); SP<Primary> primarySelection = std::make_shared<Primary>(); }
static std::set<wl_client*> leased;
struct Lease { wl_client* client; bool paused = false; };
static std::map<std::string, std::unique_ptr<Lease>> applicationLeases;
static Lease* applicationLeaseForClient(wl_client* client) {
    for (auto& [id, lease] : applicationLeases) if (lease->client == client) return lease.get();
    return nullptr;
}
static int broadcasts = 0;
static void sendSharedSelection(wl_client*, bool) { ++broadcasts; }
struct Seat {
    int clipboardCalls = 0, primaryCalls = 0;
    SP<IDataSource> clipboard, primary;
    void setCurrentSelection(SP<IDataSource> source) { ++clipboardCalls; clipboard = source; }
    void setCurrentPrimarySelection(SP<IDataSource> source) { ++primaryCalls; primary = source; }
};
static auto g_pSeatManager = std::make_shared<Seat>();
// Old callbacks are compiled unchanged for the explicit unfixed comparison.
static bool privateSelectionClient(wl_client* client) { return leased.contains(client); }
static void sendPrivateClipboardSelection(wl_client*, SP<CWLDataSourceResource>) {}
static void sendPrivatePrimarySelection(wl_client*, SP<CPrimarySelectionSource>) {}
static void recordApplicationFailure(wl_client*, const char*) {}

using PrimaryHandler = std::function<void(CZwpPrimarySelectionDeviceV1*, wl_resource*, uint32_t)>;
struct SPrimaryGuard { CZwpPrimarySelectionDeviceV1* device; PrimaryHandler original; wl_listener destroy{}; };
using ClipboardHandler = std::function<void(CWlDataDevice*, wl_resource*, uint32_t)>;
struct SClipboardGuard {
    CWlDataDevice* device; ClipboardHandler original;
    decltype(std::declval<CWlDataDevice>().requests.startDrag) originalStartDrag;
    wl_listener destroy{};
};
static std::map<wl_resource*, SPrimaryGuard> primaryGuards;
static std::map<wl_resource*, SClipboardGuard> clipboardGuards;
"""
MAIN = r"""
int main() {
    auto display = wl_display_create();
    int sockets[2]; if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sockets)) return 1;
    auto client = wl_client_create(display, sockets[0]);
    auto clipboard = std::make_shared<CWlDataDevice>();
    clipboard->handle = wl_resource_create(client, &wl_data_device_interface, 1, 0);
    auto primary = std::make_shared<CZwpPrimarySelectionDeviceV1>();
    primary->handle = wl_resource_create(client, &wl_data_device_interface, 1, 0);
    int originalClipboard = 0, originalPrimary = 0;
    clipboard->requests.setSelection = [&](auto*, auto*, auto) { ++originalClipboard; };
    primary->requests.setSelection = [&](auto*, auto*, auto) { ++originalPrimary; };
    PROTO::data->m_devices.push_back(std::make_shared<Device<CWlDataDevice>>(Device<CWlDataDevice>{clipboard}));
    PROTO::primarySelection->m_devices.push_back(std::make_shared<Device<CZwpPrimarySelectionDeviceV1>>(Device<CZwpPrimarySelectionDeviceV1>{primary}));
    leased.insert(client);
    applicationLeases["test"] = std::make_unique<Lease>(Lease{client});
    guardClipboard(client); guardPrimarySelection(client);
    clipboard->requests.setSelection(clipboard.get(), clipboard->handle, 7);
    primary->requests.setSelection(primary.get(), primary->handle, 8);
    if (g_pSeatManager->clipboardCalls != 1 || !g_pSeatManager->clipboard || originalClipboard) return 2;
    if (g_pSeatManager->primaryCalls != 1 || !g_pSeatManager->primary || originalPrimary) return 3;
    broadcastSharedSelection(false); if (broadcasts != 1) return 6;
    applicationLeases.at("test")->paused = true;
    clipboard->requests.setSelection(clipboard.get(), nullptr, 11);
    primary->requests.setSelection(primary.get(), nullptr, 12);
    if (g_pSeatManager->clipboardCalls != 1 || g_pSeatManager->primaryCalls != 1 || originalClipboard != 1 || originalPrimary != 1) return 7;
    broadcastSharedSelection(false); if (broadcasts != 1) return 8;
    // Normal owner handlers remain intact after the application's lease ends.
    leased.erase(client);
    applicationLeases.clear();
    clipboard->requests.setSelection(clipboard.get(), nullptr, 9);
    primary->requests.setSelection(primary.get(), nullptr, 10);
    if (originalClipboard != 2 || originalPrimary != 2) return 4;
    // Actual Wayland destroy listeners release callback records exactly once.
    wl_resource_destroy(clipboard->handle); wl_resource_destroy(primary->handle);
    if (!clipboardGuards.empty() || !primaryGuards.empty()) return 5;
    wl_client_destroy(client); close(sockets[1]); wl_display_destroy(display);
}
"""


class SharedClipboardTests(unittest.TestCase):
    def test_actual_callbacks_publish_to_shared_selections_and_restore_owner_handlers(self):
        source = SOURCE.read_text()
        code = FIXTURE + "template <typename Protocol>\n" + definition(source, "static bool clientHasDataControlDevice(")
        code += "\ntemplate <typename Device, typename Guards, typename Destroy, typename Configure>\n" + definition(source, "static void installSelectionGuard(")
        code += "\n" + definition(source, "static void guardPrimarySelection(")
        code += "\n" + definition(source, "static void guardClipboard(")
        code += "\n" + definition(source, "static void broadcastSharedSelection(") + MAIN
        with tempfile.TemporaryDirectory(prefix="orbit-shared-clipboard-") as temporary:
            root = Path(temporary)
            (root / "probe.cpp").write_text(code)
            flags = shlex.split(subprocess.check_output(["pkg-config", "--cflags", "--libs", "wayland-server"], text=True))
            subprocess.run(["g++", "-std=c++23", "-O0", str(root / "probe.cpp"), *flags, "-o", str(root / "probe")], check=True, timeout=25)
            subprocess.run([str(root / "probe")], check=True, timeout=5)


if __name__ == "__main__":
    unittest.main()
