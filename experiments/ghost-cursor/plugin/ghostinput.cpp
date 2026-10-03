// ghostinput: deliver keyboard and pointer input to one background window without touching the
// shared seat. Every event goes only to the target client's own wl_keyboard / wl_pointer resources,
// framed by its own enter and leave, so the seat's focus, the person's pointer and the person's
// application never see anything. The Linux analog of posting events to one process.
//
// hyprctl commands (all refuse any window outside the agent workspace special:ghost):
//   ghost-type  <address> <text>                 type UTF-8 text through the seat keymap
//   ghost-key   <address> <combo>                one key, e.g. Return, ctrl+a, shift+Tab
//   ghost-click <address> <x> <y> [button]       press and release at surface-local x,y
//   ghost-move  <address> <x> <y>                pointer enter and motion only
//   ghost-scroll <address> <x> <y> <dy>         vertical scroll in steps of 15 units
#include <hyprland/src/plugins/PluginAPI.hpp>
#include <hyprland/src/desktop/state/WindowState.hpp>
#include <hyprland/src/desktop/view/Window.hpp>
#include <hyprland/src/desktop/Workspace.hpp>
#include <hyprland/src/managers/SeatManager.hpp>
#include <hyprland/src/protocols/core/Seat.hpp>
#include <hyprland/src/protocols/core/Compositor.hpp>
#include <hyprland/src/devices/IKeyboard.hpp>
#include <xkbcommon/xkbcommon.h>
#include <chrono>
#include <format>
#include <sstream>
#include <vector>

inline HANDLE PHANDLE = nullptr;
static const std::string AGENT_SPACE = "special:ghost";

static uint32_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

struct STarget {
    PHLWINDOW               window;
    SP<CWLSurfaceResource>  surface;
    SP<CWLSeatResource>     seat;
    std::string             error;
};

static STarget resolve(const std::string& address) {
    STarget t;
    std::string want = address;
    if (want.starts_with("0x"))
        want = want.substr(2);
    for (auto const& w : Desktop::windowState()->windows()) {
        if (std::format("{:x}", reinterpret_cast<uintptr_t>(w.get())) == want) {
            t.window = w;
            break;
        }
    }
    if (!t.window) {
        t.error = "no such window";
        return t;
    }
    if (!t.window->m_isMapped || !t.window->m_workspace || t.window->m_workspace->m_name != AGENT_SPACE) {
        t.error = "refused: window is not in " + AGENT_SPACE;
        t.window.reset();
        return t;
    }
    t.surface = t.window->resource();
    if (!t.surface) {
        t.error = "window has no surface";
        return t;
    }
    // Never deliver to whatever the seat itself focuses: that is the person's input path.
    if (g_pSeatManager->m_state.keyboardFocus.lock() == t.surface || g_pSeatManager->m_state.pointerFocus.lock() == t.surface) {
        t.error = "refused: window holds the seat focus";
        return t;
    }
    t.seat = g_pSeatManager->seatResourceForClient(t.surface->client());
    if (!t.seat)
        t.error = "client has no seat";
    return t;
}

// One keystroke: keycode in evdev numbering (xkb keycode minus 8).
struct SStroke {
    uint32_t evdev;
    uint32_t mods;
    uint32_t group;
};

static void sendStrokes(const STarget& t, const std::vector<SStroke>& strokes) {
    wl_array keys;
    wl_array_init(&keys);
    for (auto const& kw : t.seat->m_keyboards) {
        auto k = kw.lock();
        if (!k)
            continue;
        k->sendEnter(t.surface, &keys);
        for (auto const& s : strokes) {
            // Our own modifier state, never the seat's: a Shift the person holds must not leak in.
            k->sendMods(s.mods, 0, 0, s.group);
            k->sendKey(nowMs(), s.evdev, WL_KEYBOARD_KEY_STATE_PRESSED);
            k->sendKey(nowMs(), s.evdev, WL_KEYBOARD_KEY_STATE_RELEASED);
        }
        k->sendMods(0, 0, 0, 0);
        k->sendLeave();
    }
    wl_array_release(&keys);
}

static xkb_keymap* seatKeymap() {
    auto kb = g_pSeatManager->m_keyboard.lock();
    return kb ? kb->m_xkbKeymap : nullptr;
}

static bool findKeysym(xkb_keymap* km, xkb_keysym_t sym, SStroke& out) {
    const xkb_mod_index_t shift = xkb_keymap_mod_get_index(km, XKB_MOD_NAME_SHIFT);
    for (xkb_keycode_t kc = xkb_keymap_min_keycode(km); kc <= xkb_keymap_max_keycode(km); ++kc) {
        const xkb_layout_index_t layouts = xkb_keymap_num_layouts_for_key(km, kc);
        for (xkb_layout_index_t g = 0; g < layouts; ++g) {
            const xkb_level_index_t levels = xkb_keymap_num_levels_for_key(km, kc, g);
            for (xkb_level_index_t lv = 0; lv < levels && lv < 2; ++lv) {
                const xkb_keysym_t* syms = nullptr;
                const int           n    = xkb_keymap_key_get_syms_by_level(km, kc, g, lv, &syms);
                for (int i = 0; i < n; ++i) {
                    if (syms[i] == sym) {
                        out = {kc - 8, lv == 1 && shift != XKB_MOD_INVALID ? (1u << shift) : 0u, g};
                        return true;
                    }
                }
            }
        }
    }
    return false;
}

static std::string cmdType(eHyprCtlOutputFormat, std::string req) {
    std::istringstream in(req);
    std::string        cmd, address;
    in >> cmd >> address;
    std::string text;
    std::getline(in, text);
    if (!text.empty() && text[0] == ' ')
        text.erase(0, 1);
    auto t = resolve(address);
    if (!t.error.empty())
        return t.error;
    auto km = seatKeymap();
    if (!km)
        return "no seat keymap";
    std::vector<SStroke> strokes;
    // Decode UTF-8 to code points.
    for (size_t i = 0; i < text.size();) {
        uint32_t      cp = 0;
        unsigned char c  = text[i];
        int           len = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : 4;
        cp               = len == 1 ? c : len == 2 ? (c & 0x1F) : len == 3 ? (c & 0x0F) : (c & 0x07);
        for (int j = 1; j < len && i + j < text.size(); ++j)
            cp = (cp << 6) | (text[i + j] & 0x3F);
        i += len;
        xkb_keysym_t sym = cp == '\n' ? XKB_KEY_Return : cp == '\t' ? XKB_KEY_Tab : xkb_utf32_to_keysym(cp);
        SStroke      s;
        if (!findKeysym(km, sym, s))
            return std::format("no key for U+{:04X} in the seat keymap", cp);
        strokes.push_back(s);
    }
    sendStrokes(t, strokes);
    return std::format("ok {} keys", strokes.size());
}

static std::string cmdKey(eHyprCtlOutputFormat, std::string req) {
    std::istringstream in(req);
    std::string        cmd, address, combo;
    in >> cmd >> address >> combo;
    auto t = resolve(address);
    if (!t.error.empty())
        return t.error;
    auto km = seatKeymap();
    if (!km)
        return "no seat keymap";
    uint32_t    mods = 0;
    std::string key  = combo;
    size_t      plus;
    while ((plus = key.find('+')) != std::string::npos && plus + 1 < key.size()) {
        std::string m = key.substr(0, plus);
        key           = key.substr(plus + 1);
        const char* name = m == "ctrl" ? XKB_MOD_NAME_CTRL : m == "shift" ? XKB_MOD_NAME_SHIFT : m == "alt" ? XKB_MOD_NAME_ALT : m == "super" ? XKB_MOD_NAME_LOGO : nullptr;
        if (!name)
            return "unknown modifier " + m;
        mods |= 1u << xkb_keymap_mod_get_index(km, name);
    }
    xkb_keysym_t sym = xkb_keysym_from_name(key.c_str(), XKB_KEYSYM_CASE_INSENSITIVE);
    if (sym == XKB_KEY_NoSymbol)
        return "unknown key " + key;
    SStroke s;
    if (!findKeysym(km, sym, s))
        return "no key for " + key;
    s.mods |= mods;
    sendStrokes(t, {s});
    return "ok";
}

static std::string pointerCmd(std::string req, int kind) {
    std::istringstream in(req);
    std::string        cmd, address;
    double             x = 0, y = 0, extra = 0;
    in >> cmd >> address >> x >> y;
    in >> extra;
    auto t = resolve(address);
    if (!t.error.empty())
        return t.error;
    const Vector2D local{x, y};
    for (auto const& pw : t.seat->m_pointers) {
        auto p = pw.lock();
        if (!p)
            continue;
        p->sendEnter(t.surface, local);
        p->sendMotion(nowMs(), local);
        p->sendFrame();
        if (kind == 1) {
            const uint32_t button = extra == 2 ? 0x111 /* BTN_RIGHT */ : extra == 3 ? 0x112 /* BTN_MIDDLE */ : 0x110 /* BTN_LEFT */;
            p->sendButton(nowMs(), button, WL_POINTER_BUTTON_STATE_PRESSED);
            p->sendFrame();
            p->sendButton(nowMs(), button, WL_POINTER_BUTTON_STATE_RELEASED);
            p->sendFrame();
        } else if (kind == 2) {
            p->sendAxisSource(WL_POINTER_AXIS_SOURCE_WHEEL);
            p->sendAxis(nowMs(), WL_POINTER_AXIS_VERTICAL_SCROLL, extra * 15.0);
            p->sendAxisValue120(WL_POINTER_AXIS_VERTICAL_SCROLL, (int32_t)(extra * 120));
            p->sendFrame();
        }
        p->sendLeave();
        p->sendFrame();
    }
    return "ok";
}

APICALL EXPORT std::string PLUGIN_API_VERSION() {
    return HYPRLAND_API_VERSION;
}

APICALL EXPORT PLUGIN_DESCRIPTION_INFO PLUGIN_INIT(HANDLE handle) {
    PHANDLE = handle;
    const std::string HASH = __hyprland_api_get_hash();
    if (HASH != GIT_COMMIT_HASH) {
        HyprlandAPI::addNotification(PHANDLE, "[ghostinput] built for another Hyprland, refusing", CHyprColor{1.0, 0.2, 0.2, 1.0}, 5000);
        throw std::runtime_error("[ghostinput] version mismatch");
    }
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-type", false, cmdType});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-key", false, cmdKey});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-click", false, [](eHyprCtlOutputFormat, std::string r) { return pointerCmd(r, 1); }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-move", false, [](eHyprCtlOutputFormat, std::string r) { return pointerCmd(r, 0); }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-scroll", false, [](eHyprCtlOutputFormat, std::string r) { return pointerCmd(r, 2); }});
    return {"ghostinput", "Background keyboard and pointer input to one window", "sbar-orbit experiment", "0.1"};
}

APICALL EXPORT void PLUGIN_EXIT() {}
