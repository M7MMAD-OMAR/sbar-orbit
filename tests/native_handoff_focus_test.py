"""Compile the actual claim function: owner focus and hover never block a claim or move seat focus."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class HandoffFocusTests(unittest.TestCase):
    def test_owner_focus_and_hover_never_block_a_claim_or_move_focus(self):
        source = Path(os.environ.get("ORBIT_HANDOFF_FOCUS_SOURCE", str(Path(__file__).resolve().parents[1]
            / "experiments/ghost-cursor/plugin/ghostinput.cpp"))).read_text()
        start = source.index("static std::string claimApplication(")
        claim = source[start:source.index("\n}\n", start) + 3]
        # Retain the real removed helper only when injecting pre-fix source for a RED run.
        release = ""
        signature = "static void releaseClaimedSeatFocus("
        if signature in source:
            start = source.index(signature)
            release = source[start:source.index("\n}\n", start) + 3]
        fixture = r'''
#include <array>
#include <cmath>
#include <cstdio>
#include <format>
#include <map>
#include <memory>
#include <regex>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
#include <cstdint>
#include <cstddef>
struct wl_client {};
struct wl_list {};
struct wl_listener { void (*notify)(wl_listener*,void*) = nullptr; wl_list link; };
static int listenerChanges = 0, ruleChanges = 0, selectionChanges = 0, relatedChanges = 0;
static void wl_list_remove(wl_list*) {}
static void wl_client_add_destroy_listener(wl_client*, wl_listener*) { ++listenerChanges; }
struct Vector { double x = 720, y = 640; };
struct CWLSurfaceResource { wl_client* owner; wl_client* client() { return owner; } };
template<typename T> using SP = std::shared_ptr<T>;
struct Workspace { std::string m_name = "7"; };
struct Window {
    SP<CWLSurfaceResource> surface;
    std::shared_ptr<Window> parentWindow;
    bool m_isMapped = true, m_isX11 = false, m_isFloating = true, m_xdgSurface = true;
    std::shared_ptr<Workspace> m_workspace = std::make_shared<Workspace>();
    uint64_t m_stableID = 1;
    auto resource() { return surface; }
    auto parent() { return parentWindow; }
    Vector size(int) { return {}; }
};
using PHLWINDOW = std::shared_ptr<Window>;
struct Seat {
    struct { std::weak_ptr<CWLSurfaceResource> keyboardFocus, pointerFocus; } m_state;
    bool m_seatGrab = false;
    int keyboardCalls = 0, pointerCalls = 0, physicalX = 300, physicalY = 400;
    void setKeyboardFocus(SP<CWLSurfaceResource> value) { ++keyboardCalls; m_state.keyboardFocus = value; }
    void setPointerFocus(SP<CWLSurfaceResource> value, Vector) { ++pointerCalls; m_state.pointerFocus = value; }
};
static auto g_pSeatManager = std::make_shared<Seat>();
namespace Desktop {
    enum { FOCUS_REASON_OTHER };
    namespace View { namespace IGeometric { enum { GEOMETRIC_GOAL }; } }
    struct Focus {
        SP<CWLSurfaceResource> active;
        PHLWINDOW focusWindow;
        auto surface() { return active; }
        void rawWindowFocus(std::nullptr_t, int) {
            active.reset(); focusWindow.reset(); g_pSeatManager->setKeyboardFocus(nullptr);
        }
        void resetWindowFocus() { active.reset(); focusWindow.reset(); }
    };
    struct Windows { std::vector<PHLWINDOW> values; auto& windows() { return values; } };
    static auto focus = std::make_shared<Focus>();
    static auto state = std::make_shared<Windows>();
    static auto focusState() { return focus; }
    static auto windowState() { return state; }
}
namespace Math { struct SExpressionVec2 { std::string x, y; }; }
struct Protocol { bool dndActive() { return false; } };
namespace PROTO {
    static auto data = std::make_shared<Protocol>();
    static auto primarySelection = std::make_shared<Protocol>();
}
struct RetainedWindow { std::weak_ptr<Window> window; };
struct SApplicationLease {
    wl_client* client = nullptr;
    std::string id, homeWorkspace, homeWorkspaceRule;
    bool windowBound = false;
    PHLWINDOW windowRoot;
    std::set<uint64_t> baselineWindows;
    Math::SExpressionVec2 newWindowSize;
    std::map<uint64_t, RetainedWindow> windows;
    wl_listener destroy;
    std::array<char,256> claimFailure{};
};
static bool admissionPaused = false;
static std::map<std::string,std::unique_ptr<SApplicationLease>> applicationLeases;
static std::set<std::string> retiredApplicationLeases;
static void clientHasDataControlDevice(std::shared_ptr<Protocol>, wl_client*) {}
static SApplicationLease* applicationLeaseForClient(wl_client* client) {
    for (auto& [id, lease] : applicationLeases) if (lease->client == client) return lease.get();
    return nullptr;
}
static void restoreRelatedWindows(SApplicationLease&, wl_client* = nullptr, SApplicationLease* = nullptr) { ++relatedChanges; }
static bool applicationWindowAllowed(SApplicationLease& lease, PHLWINDOW window) {
    return !lease.windowBound || window == lease.windowRoot;
}
static void retainApplicationWindow(SApplicationLease& lease, PHLWINDOW window) {
    lease.windows.emplace(window->m_stableID, RetainedWindow{window});
}
static void retireKeyboardClient(wl_client*) {}
static void clearApplicationCursors(const std::string&) {}
static void applyApplicationWindow(PHLWINDOW) { ++ruleChanges; }
static void guardPrimarySelection(wl_client*) { ++selectionChanges; }
static void guardClipboard(wl_client*) { ++selectionChanges; }
static void sendSharedSelection(wl_client*,bool) { ++selectionChanges; }
static void handbackApplication(const std::string& id) { applicationLeases.erase(id); }
static void recordApplicationFailure(wl_client*,const char*) {}
'''
        main = r'''
static PHLWINDOW makeWindow(wl_client* owner, uint64_t id) {
    auto window = std::make_shared<Window>();
    window->surface = std::make_shared<CWLSurfaceResource>(CWLSurfaceResource{owner});
    window->m_stableID = id;
    return window;
}
int main() {
    wl_client target, other;
    int failed = 0;
    for (bool portal : {false, true}) for (int ownerFocus : {0,1,2,3,4}) {
        applicationLeases.clear(); retiredApplicationLeases.clear();
        listenerChanges = ruleChanges = selectionChanges = relatedChanges = 0;
        g_pSeatManager = std::make_shared<Seat>();
        auto selected = makeWindow(&target, 0xab), sibling = makeWindow(&target, 0xac);
        sibling->m_workspace->m_name = "1";
        auto owner = makeWindow(&other, 0xad);
        if (portal) selected->parentWindow = owner;
        Desktop::state->values = {selected, sibling, owner};
        auto keyboard = ownerFocus == 0 ? selected->surface : ownerFocus == 1 ? sibling->surface : owner->surface;
        auto pointer = ownerFocus == 2 ? sibling->surface : ownerFocus == 4 ? selected->surface : owner->surface;
        auto focusWindow = ownerFocus == 0 ? selected : ownerFocus == 1 ? sibling : owner;
        g_pSeatManager->m_state.keyboardFocus = keyboard;
        g_pSeatManager->m_state.pointerFocus = pointer;
        Desktop::focus->active = keyboard;
        Desktop::focus->focusWindow = focusWindow;
        bool busy = false;
        std::string result;
        try {
            result = claimApplication(std::format("0x{:x}", reinterpret_cast<uintptr_t>(selected.get())), "ab", std::string(32,'a'));
        } catch (const std::runtime_error& error) {
            busy = std::string(error.what()) == "application client is receiving owner input";
        }
        const bool expectedBusy = false;
        const bool preserved = g_pSeatManager->m_state.keyboardFocus.lock() == keyboard &&
            g_pSeatManager->m_state.pointerFocus.lock() == pointer && Desktop::focus->active == keyboard &&
            Desktop::focus->focusWindow == focusWindow && !g_pSeatManager->keyboardCalls && !g_pSeatManager->pointerCalls &&
            g_pSeatManager->physicalX == 300 && g_pSeatManager->physicalY == 400;
        const bool unchanged = applicationLeases.empty() && retiredApplicationLeases.empty() &&
            !listenerChanges && !ruleChanges && !selectionChanges && !relatedChanges;
        if (!preserved || (expectedBusy && (!busy || !unchanged)) ||
            (!expectedBusy && (busy || applicationLeases.size()!=1 || retiredApplicationLeases.size()!=1 || result.empty()))) {
            std::fprintf(stderr, "portal=%d ownerFocus=%d busy=%d preserved=%d unchanged=%d leases=%zu\n",
                portal, ownerFocus, busy, preserved, unchanged, applicationLeases.size());
            ++failed;
        }
    }
    for (int invalid : {0,1,2,3,4}) {
        applicationLeases.clear(); retiredApplicationLeases.clear();
        g_pSeatManager = std::make_shared<Seat>();
        auto selected = makeWindow(&target, 0xab), owner = makeWindow(&other, 0xad);
        Desktop::state->values = {selected, owner};
        g_pSeatManager->m_state.keyboardFocus = owner->surface;
        g_pSeatManager->m_state.pointerFocus = owner->surface;
        Desktop::focus->active = owner->surface; Desktop::focus->focusWindow = owner;
        auto existing = std::make_unique<SApplicationLease>();
        existing->client = &other; existing->id = std::string(32,'b');
        existing->windows.emplace(owner->m_stableID, RetainedWindow{owner});
        applicationLeases.emplace(existing->id, std::move(existing));
        std::string id = invalid == 0 ? "invalid" : std::string(32,'a');
        if (invalid == 1) selected->m_xdgSurface = false;
        if (invalid == 2) {
            auto sibling = makeWindow(&target, 0xac); sibling->m_isX11 = true;
            Desktop::state->values.push_back(sibling);
        }
        if (invalid == 3) for (uint64_t n = 0; n < 65; ++n)
            Desktop::state->values.push_back(makeWindow(&target, 0x100 + n));
        if (invalid == 4) retiredApplicationLeases.insert(id);
        listenerChanges = ruleChanges = selectionChanges = relatedChanges = 0;
        bool refused = false;
        try {
            claimApplication(std::format("0x{:x}", reinterpret_cast<uintptr_t>(selected.get())), "ab", id);
        } catch (const std::runtime_error& error) {
            refused = std::string(error.what()) == (invalid == 0 || invalid == 4 ?
                "cannot mint application lease identity" : "client includes unsupported targets");
        }
        if (!refused || applicationLeases.size() != 1 || relatedChanges || ruleChanges || listenerChanges || selectionChanges ||
            retiredApplicationLeases.size() != (invalid == 4 ? 1 : 0) ||
            Desktop::focus->focusWindow != owner || g_pSeatManager->m_state.keyboardFocus.lock() != owner->surface ||
            g_pSeatManager->m_state.pointerFocus.lock() != owner->surface ||
            g_pSeatManager->keyboardCalls || g_pSeatManager->pointerCalls ||
            g_pSeatManager->physicalX != 300 || g_pSeatManager->physicalY != 400) {
            std::fprintf(stderr, "invalid=%d refused=%d relatedChanges=%d leases=%zu\n", invalid, refused, relatedChanges, applicationLeases.size());
            ++failed;
        }
    }
    return failed ? 1 : 0;
}
'''
        with tempfile.TemporaryDirectory(prefix="orbit-handoff-focus-") as directory:
            root = Path(directory)
            cpp, binary = root / "probe.cpp", root / "probe"
            # The claim records the owner token, so the fixture carries the plugin's real owner helpers.
            owner = source[source.index("// BEGIN lease-owner"):source.index("// END lease-owner")] if "// BEGIN lease-owner" in source else ""
            body = fixture.replace("struct RetainedWindow", owner + "struct RetainedWindow", 1) if owner else fixture
            if owner:
                body = ("#include <chrono>\n#include <cstdlib>\n#include <filesystem>\n#include <fstream>\n#include <sstream>\n" + body).replace(
                    "    std::array<char,256> claimFailure{};\n};", "    std::array<char,256> claimFailure{};\n    lease_owner::Owner owner;\n};", 1)
            cpp.write_text(body + release + claim + main)
            subprocess.run(["g++", "-std=c++23", str(cpp), "-o", str(binary)], check=True, timeout=30)
            subprocess.run([str(binary)], check=True, timeout=5)


if __name__ == "__main__":
    unittest.main()
