"""Compile the real owner input functions: focus and hover never end a lease, physical input pauses it, idle resumes it."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SOURCE = Path(os.environ.get("ORBIT_OWNER_INPUT_SOURCE", str(Path(__file__).resolve().parents[1]
    / "experiments/ghost-cursor/plugin/ghostinput.cpp")))


def function(source, signature):
    start = source.index(signature)
    return source[start:source.index("\n}\n", start) + 3]


FIXTURE = r'''
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <thread>
#include <vector>
struct wl_client {};
struct wl_array { int unused; };
static void wl_array_init(wl_array*) {}
static void wl_array_release(wl_array*) {}
enum wl_keyboard_key_state { WL_KEYBOARD_KEY_STATE_PRESSED = 1 };
enum wl_pointer_button_state { WL_POINTER_BUTTON_STATE_PRESSED = 1 };
enum wl_pointer_axis { WL_POINTER_AXIS_VERTICAL_SCROLL };
enum wl_pointer_axis_source { WL_POINTER_AXIS_SOURCE_WHEEL };
enum wl_pointer_axis_relative_direction { WL_POINTER_AXIS_RELATIVE_DIRECTION_IDENTICAL };
template<typename T> using SP = std::shared_ptr<T>;
template<typename T> using WP = std::weak_ptr<T>;
struct Vector2D { double x = 0, y = 0; };
struct CWLSurfaceResource { wl_client* owner; wl_client* client() { return owner; } };
static int keymaps = 0, keyLeaves = 0, keyEnters = 0, pointerLeaves = 0, pointerEnters = 0, frames = 0, damages = 0, cancels = 0;
struct Keymap {};
struct CWLKeyboardResource {
    WP<CWLSurfaceResource> m_currentSurface;
    void sendLeave() { ++keyLeaves; m_currentSurface.reset(); }
    void sendKeymap(SP<Keymap>) { ++keymaps; }
    void sendEnter(SP<CWLSurfaceResource> surface, wl_array*) { ++keyEnters; m_currentSurface = surface; }
};
static int pointerMotions = 0;
static uint32_t nowMs() { return 7; }
struct CWLPointerResource {
    Vector2D lastEnter, lastMotion;
    WP<CWLSurfaceResource> m_currentSurface;
    void sendLeave() { if (!m_currentSurface.lock()) return; ++pointerLeaves; m_currentSurface.reset(); }
    // Mirrors the compositor: entering the surface the pointer already occupies does nothing.
    void sendEnter(SP<CWLSurfaceResource> surface, const Vector2D& local) {
        if (m_currentSurface.lock() == surface) return;
        ++pointerEnters; lastEnter = local; m_currentSurface = surface;
    }
    void sendMotion(uint32_t, const Vector2D& local) { ++pointerMotions; lastMotion = local; }
    void sendFrame() { ++frames; }
};
struct CWLSeatResource {
    wl_client* owner;
    std::vector<WP<CWLKeyboardResource>> m_keyboards;
    std::vector<WP<CWLPointerResource>> m_pointers;
    wl_client* client() { return owner; }
};
struct CSeatManager {
    struct {
        WP<CWLSurfaceResource> keyboardFocus, pointerFocus;
        WP<CWLSeatResource> keyboardFocusResource, pointerFocusResource;
    } m_state;
    SP<Keymap> keyboardKeymap = std::make_shared<Keymap>();
    struct Holder { SP<Keymap> value; SP<Keymap> lock() { return value; } } m_keyboard;
    Vector2D m_lastLocalCoords{12, 34};
    std::map<wl_client*, SP<CWLSeatResource>> seats;
    SP<CWLSeatResource> seatResourceForClient(wl_client* client) { auto it = seats.find(client); return it == seats.end() ? nullptr : it->second; }
};
static auto g_pSeatManagerStorage = std::make_unique<CSeatManager>();
static CSeatManager* const g_pSeatManagerRaw = nullptr;
#define g_pSeatManager g_pSeatManagerStorage
struct Monitor {};
struct Window { std::weak_ptr<Monitor> m_monitor; };
struct Renderer { void damageMonitor(SP<Monitor>) { ++damages; } };
static auto g_pHyprRendererStorage = std::make_unique<Renderer>();
#define g_pHyprRenderer g_pHyprRendererStorage
struct SLeasedWindow { std::weak_ptr<Window> window; };
struct SApplicationLease {
    wl_client* client = nullptr;
    bool paused = false;
    std::chrono::steady_clock::time_point ownerInputUntil{};
    std::map<uint64_t, SLeasedWindow> windows;
};
static std::map<std::string, std::unique_ptr<SApplicationLease>> applicationLeases;
static std::map<CWLKeyboardResource*, WP<CWLKeyboardResource>> agentKeyboards;
static std::map<CWLPointerResource*, WP<CWLPointerResource>> scrollPointers;
static SApplicationLease* applicationLeaseForClient(wl_client* client) {
    for (auto& [id, lease] : applicationLeases) if (lease->client == client) return lease.get();
    return nullptr;
}
static void cancelKeyboardClient(wl_client*) { ++cancels; }
static constexpr auto ownerIdleResume = std::chrono::milliseconds{2000};
struct CFunctionHook { void* m_original; };
static int upstreamKeys = 0, upstreamButtons = 0, upstreamAxes = 0, upstreamFocus = 0;
static void upstreamKey(CSeatManager*, uint32_t, uint32_t, wl_keyboard_key_state) { ++upstreamKeys; }
static void upstreamButton(CSeatManager*, uint32_t, uint32_t, wl_pointer_button_state) { ++upstreamButtons; }
static void upstreamAxis(CSeatManager*, uint32_t, wl_pointer_axis, double, int32_t, int32_t, wl_pointer_axis_source, wl_pointer_axis_relative_direction) { ++upstreamAxes; }
static void upstreamFocusFn(CSeatManager*, SP<CWLSurfaceResource>&) { ++upstreamFocus; }
static CFunctionHook keyHookStorage{reinterpret_cast<void*>(upstreamKey)}, buttonHookStorage{reinterpret_cast<void*>(upstreamButton)},
    axisHookStorage{reinterpret_cast<void*>(upstreamAxis)}, focusHookStorage{reinterpret_cast<void*>(upstreamFocusFn)};
static CFunctionHook* keyboardKeyHook = &keyHookStorage;
static CFunctionHook* pointerButtonHook = &buttonHookStorage;
static CFunctionHook* pointerAxisHook = &axisHookStorage;
static CFunctionHook* keyboardFocusHook = &focusHookStorage;
'''

MAIN = r'''
#define CHECK(condition) do { if (!(condition)) { std::fprintf(stderr, "line %d: %s\n", __LINE__, #condition); ++failed; } } while (0)
struct World {
    wl_client leased, other;
    SP<CWLSurfaceResource> leasedSurface, otherSurface;
    SP<CWLKeyboardResource> keyboard = std::make_shared<CWLKeyboardResource>();
    SP<CWLPointerResource> pointer = std::make_shared<CWLPointerResource>();
    SP<CWLSeatResource> leasedSeat, otherSeat;
    SApplicationLease* lease = nullptr;
    World() {
        leasedSurface = std::make_shared<CWLSurfaceResource>(CWLSurfaceResource{&leased});
        otherSurface = std::make_shared<CWLSurfaceResource>(CWLSurfaceResource{&other});
        leasedSeat = std::make_shared<CWLSeatResource>(CWLSeatResource{&leased, {keyboard}, {pointer}});
        otherSeat = std::make_shared<CWLSeatResource>(CWLSeatResource{&other, {}});
        g_pSeatManager = std::make_unique<CSeatManager>();
        g_pSeatManager->m_keyboard.value = g_pSeatManager->keyboardKeymap;
        g_pSeatManager->seats[&leased] = leasedSeat;
        g_pSeatManager->seats[&other] = otherSeat;
        applicationLeases.clear(); agentKeyboards.clear(); scrollPointers.clear(); pointerMotions = 0;
        auto value = std::make_unique<SApplicationLease>();
        value->client = &leased;
        lease = value.get();
        applicationLeases.emplace("lease", std::move(value));
        keymaps = keyLeaves = keyEnters = pointerLeaves = pointerEnters = frames = damages = cancels = 0;
        upstreamKeys = upstreamButtons = upstreamAxes = upstreamFocus = 0;
    }
    void focusOwner(SP<CWLSurfaceResource> surface, SP<CWLSeatResource> seat) {
        g_pSeatManager->m_state.keyboardFocus = surface; g_pSeatManager->m_state.pointerFocus = surface;
        g_pSeatManager->m_state.keyboardFocusResource = seat; g_pSeatManager->m_state.pointerFocusResource = seat;
    }
};
int main() {
    int failed = 0;
    {   // Focus and hover alone: no pause, no handback, upstream still runs.
        World w;
        w.focusOwner(w.leasedSurface, w.leasedSeat);
        w.keyboard->m_currentSurface = w.leasedSurface;
        auto surface = w.leasedSurface;
        beforeKeyboardFocus(g_pSeatManager.get(), surface);
        CHECK(upstreamFocus == 1);
        CHECK(applicationLeases.size() == 1 && !w.lease->paused && !ownerInputActive(*w.lease));
        CHECK(damages == 0 && cancels == 0);
    }
    {   // Entering focus retires an enrolled agent keymap before the seat's enter.
        World w;
        w.keyboard->m_currentSurface = w.leasedSurface;
        agentKeyboards[w.keyboard.get()] = w.keyboard;
        auto surface = w.leasedSurface;
        w.focusOwner(w.leasedSurface, w.leasedSeat);
        beforeKeyboardFocus(g_pSeatManager.get(), surface);
        CHECK(keymaps == 1 && agentKeyboards.empty() && upstreamFocus == 1 && !ownerInputActive(*w.lease));
    }
    {   // Typing into the leased client pauses it and restores the owner's keymap first.
        World w;
        w.focusOwner(w.leasedSurface, w.leasedSeat);
        w.keyboard->m_currentSurface = w.leasedSurface;
        agentKeyboards[w.keyboard.get()] = w.keyboard;
        ownerKeyboardKey(g_pSeatManager.get(), 1, 30, WL_KEYBOARD_KEY_STATE_PRESSED);
        CHECK(upstreamKeys == 1 && ownerInputActive(*w.lease) && !w.lease->paused);
        CHECK(keymaps == 1 && agentKeyboards.empty() && cancels == 1);
        CHECK(applicationLeases.size() == 1);
    }
    {   // Button and wheel pause too; a second event only extends the deadline.
        World w;
        w.focusOwner(w.leasedSurface, w.leasedSeat);
        ownerPointerButton(g_pSeatManager.get(), 1, 0x110, WL_POINTER_BUTTON_STATE_PRESSED);
        CHECK(upstreamButtons == 1 && ownerInputActive(*w.lease));
        CHECK(pointerMotions == 0 && pointerLeaves == 0);
        const int first = damages;
        w.lease->ownerInputUntil = std::chrono::steady_clock::now() + std::chrono::milliseconds{50};
        ownerPointerAxis(g_pSeatManager.get(), 1, WL_POINTER_AXIS_VERTICAL_SCROLL, 1.0, 0, 120, WL_POINTER_AXIS_SOURCE_WHEEL, WL_POINTER_AXIS_RELATIVE_DIRECTION_IDENTICAL);
        CHECK(upstreamAxes == 1 && ownerInputActive(*w.lease) && damages == first);
    }
    {   // A pointer the agent left on the client's surface is put back on the owner's position
        // before the owner's wheel or button, and the same-surface enter is never relied on.
        World w;
        w.focusOwner(w.leasedSurface, w.leasedSeat);
        w.pointer->m_currentSurface = w.leasedSurface;
        scrollPointers[w.pointer.get()] = w.pointer;
        ownerPointerAxis(g_pSeatManager.get(), 1, WL_POINTER_AXIS_VERTICAL_SCROLL, 1.0, 0, 120, WL_POINTER_AXIS_SOURCE_WHEEL, WL_POINTER_AXIS_RELATIVE_DIRECTION_IDENTICAL);
        CHECK(scrollPointers.empty() && pointerMotions == 1 && w.pointer->lastMotion.x == 12 && w.pointer->lastMotion.y == 34);
        CHECK(pointerLeaves == 0 && pointerEnters == 0 && upstreamAxes == 1);
    }
    {   // Input delivered to another client never touches the lease.
        World w;
        w.focusOwner(w.otherSurface, w.otherSeat);
        ownerKeyboardKey(g_pSeatManager.get(), 1, 30, WL_KEYBOARD_KEY_STATE_PRESSED);
        ownerPointerButton(g_pSeatManager.get(), 1, 0x110, WL_POINTER_BUTTON_STATE_PRESSED);
        CHECK(upstreamKeys == 1 && upstreamButtons == 1 && !ownerInputActive(*w.lease) && cancels == 0 && damages == 0);
    }
    {   // No focus at all is a plain pass through.
        World w;
        ownerKeyboardKey(g_pSeatManager.get(), 1, 30, WL_KEYBOARD_KEY_STATE_PRESSED);
        CHECK(upstreamKeys == 1 && !ownerInputActive(*w.lease));
    }
    {   // Idle resumes by itself.
        World w;
        w.focusOwner(w.leasedSurface, w.leasedSeat);
        w.lease->ownerInputUntil = std::chrono::steady_clock::now() + std::chrono::milliseconds{150};
        CHECK(ownerInputActive(*w.lease));
        std::this_thread::sleep_for(std::chrono::milliseconds{200});
        CHECK(!ownerInputActive(*w.lease));
    }
    {   // Ending agent input hands the client back what the seat told it.
        World w;
        w.focusOwner(w.leasedSurface, w.leasedSeat);
        w.keyboard->m_currentSurface = w.leasedSurface;
        returnClientPointer(w.pointer, &w.leased);   // pointer not on any surface: a fresh enter
        CHECK(pointerLeaves == 0 && pointerEnters == 1 && w.pointer->lastEnter.x == 12 && w.pointer->lastEnter.y == 34 && frames == 1);
        returnClientPointer(w.pointer, &w.leased);   // already on the owner's surface: a motion to the owner's position
        CHECK(pointerLeaves == 0 && pointerEnters == 1 && pointerMotions == 1 && w.pointer->lastMotion.x == 12 && frames == 2);
        w.pointer->m_currentSurface = w.otherSurface;  // left on a sibling surface by the agent
        returnClientPointer(w.pointer, &w.leased);
        CHECK(pointerLeaves == 1 && pointerEnters == 2);
        returnClientKeyboard(w.keyboard, &w.leased);
        CHECK(keyLeaves == 0 && keymaps == 1 && keyEnters == 0);
        w.keyboard->m_currentSurface.reset();
        returnClientKeyboard(w.keyboard, &w.leased);
        CHECK(keyEnters == 1 && w.keyboard->m_currentSurface.lock() == w.leasedSurface);
        w.focusOwner(w.otherSurface, w.otherSeat);
        pointerEnters = 0; pointerLeaves = 0;
        returnClientPointer(w.pointer, &w.leased);
        returnClientKeyboard(w.keyboard, &w.leased);
        CHECK(pointerLeaves == 1 && pointerEnters == 0 && keyLeaves == 1);
    }
    return failed ? 1 : 0;
}
'''


class OwnerInputTests(unittest.TestCase):
    def test_focus_hover_keep_lease_and_physical_input_pauses_then_idle_resumes(self):
        source = SOURCE.read_text()
        names = ["static bool ownerInputActive(", "static void returnClientPointer(", "static void returnClientKeyboard(",
                 "static void restoreAgentKeyboards(", "static void restoreAgentPointers(", "static void noteOwnerInput(", "static wl_client* seatFocusClient(",
                 "static void beforeKeyboardFocus(", "static void ownerKeyboardKey(", "static void ownerPointerButton(",
                 "static void ownerPointerAxis("]
        body = "".join(function(source, name) for name in names)
        self.assertNotIn("handbackFocusedApplication", source)
        self.assertNotIn("application client is receiving owner input", source)
        with tempfile.TemporaryDirectory(prefix="orbit-owner-input-") as directory:
            root = Path(directory)
            cpp, binary = root / "probe.cpp", root / "probe"
            cpp.write_text(FIXTURE + body + MAIN)
            subprocess.run(["g++", "-std=c++23", "-Wall", str(cpp), "-o", str(binary)], check=True, timeout=60)
            subprocess.run([str(binary)], check=True, timeout=10)


if __name__ == "__main__":
    unittest.main()
