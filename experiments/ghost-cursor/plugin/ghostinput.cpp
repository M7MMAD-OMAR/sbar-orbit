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
//   ghost-cursor <address> <x> <y>             render the agent cursor without input
//   ghost-hide-cursor <address>                remove that window's cursor
#include <hyprland/src/plugins/PluginAPI.hpp>
// Load generated request storage before other protocol headers include it.
#define private public
#include <hyprland/protocols/wayland.hpp>
#undef private
#include <hyprland/src/desktop/state/WindowState.hpp>
#include <hyprland/src/desktop/view/Window.hpp>
#include <hyprland/src/desktop/Workspace.hpp>
#include <hyprland/src/desktop/rule/windowRule/WindowRuleApplicator.hpp>
#include <hyprland/src/desktop/rule/windowRule/WindowRule.hpp>
#include <hyprland/src/desktop/rule/Engine.hpp>
#include <hyprland/src/managers/TokenManager.hpp>
#include <hyprland/src/managers/SeatManager.hpp>
#include <hyprland/src/protocols/core/Seat.hpp>
#include <hyprland/src/protocols/core/Compositor.hpp>
#include <hyprland/src/protocols/XDGShell.hpp>
#include <hyprland/src/devices/IKeyboard.hpp>
#include <xkbcommon/xkbcommon.h>
#include <chrono>
#include <format>
#include <sstream>
#include <vector>
#include <map>
#include <cmath>
#include <hyprland/src/render/Renderer.hpp>
#include <hyprland/src/render/pass/TexPassElement.hpp>
#include <hyprland/src/render/Texture.hpp>
#include <cairo/cairo.h>
#include <functional>
// Version-matched private access follows Hyprland's documented plugin pattern.
#define private public
#include <hyprland/src/protocols/PrimarySelection.hpp>
#include <hyprland/src/protocols/core/DataDevice.hpp>
#undef private
#include <hyprland/src/Compositor.hpp>
#include <cstring>
#include <fstream>
#include <sys/syscall.h>
#include <poll.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <regex>
#include <memory>

// Native scoped identity begin. Also compiled independently by the lease probe.
class ScopedProcess {
    pid_t pid;
    int processFD = -1;
    int directoryFD = -1;
    std::string group;
    std::string directory;
    bool revoked = false;

    static std::string processGroup(pid_t pid) {
        std::ifstream stream(std::format("/proc/{}/cgroup", pid));
        std::string line;
        while (std::getline(stream, line))
            if (line.starts_with("0::"))
                return line.substr(3);
        return {};
    }

  public:
    ScopedProcess(pid_t value, const std::string& unit) : pid(value) {
        if (pid <= 0 || !std::regex_match(unit, std::regex{"orbit-native-[0-9a-f]{32}\\.scope"}))
            throw std::runtime_error("invalid native scope identity");
        struct stat process{};
        if (stat(std::format("/proc/{}", pid).c_str(), &process) || process.st_uid != getuid())
            throw std::runtime_error("native process has another owner");
        group = std::format("/user.slice/user-{}.slice/user@{}.service/sbarorbit.slice/{}", getuid(), getuid(), unit);
        const auto actual = processGroup(pid);
        if (actual != group && !actual.starts_with(group + "/"))
            throw std::runtime_error("process is outside its native scope");
        directory = "/sys/fs/cgroup" + group;
        processFD = syscall(SYS_pidfd_open, pid, 0);
        if (processFD < 0)
            throw std::runtime_error("cannot retain native process");
        directoryFD = open(directory.c_str(), O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (directoryFD < 0 || !valid()) {
            if (directoryFD >= 0)
                close(directoryFD);
            close(processFD);
            throw std::runtime_error("native identity changed during registration");
        }
    }
    ScopedProcess(const ScopedProcess&) = delete;
    ScopedProcess& operator=(const ScopedProcess&) = delete;
    ~ScopedProcess() {
        close(directoryFD);
        close(processFD);
    }
    bool exited() const {
        pollfd process{processFD, POLLIN, 0};
        return poll(&process, 1, 0) > 0 && (process.revents & POLLIN);
    }
    static bool descriptorLive(int descriptor) {
        pollfd process{descriptor, POLLIN, 0};
        const int result = poll(&process, 1, 0);
        if (result < 0 || (process.revents & (POLLERR | POLLNVAL)) ||
            (result > 0 && !(process.revents & POLLIN)))
            throw std::runtime_error("registered root liveness unavailable");
        return !(process.revents & POLLIN);
    }
    bool live() const {
        return descriptorLive(processFD);
    }
    bool belongsTo(const std::string& unit) const {
        return group.ends_with("/" + unit);
    }
    bool valid() {
        if (revoked)
            return false;
        pollfd process{processFD, POLLIN, 0};
        struct stat retained{}, current{};
        if (poll(&process, 1, 0) != 0 || fstat(directoryFD, &retained) ||
            lstat(directory.c_str(), &current) || !S_ISDIR(current.st_mode) ||
            retained.st_dev != current.st_dev || retained.st_ino != current.st_ino) {
            revoked = true;
            return false;
        }
        const auto actual = processGroup(pid);
        revoked = (actual != group && !actual.starts_with(group + "/")) || poll(&process, 1, 0) != 0;
        return !revoked;
    }
};
// Native scoped identity end.

inline HANDLE PHANDLE = nullptr;
static const std::string AGENT_SPACE = "special:ghost";
struct SCursor {
    PHLWINDOWREF window;
    Vector2D local;
};
static std::map<std::string, SCursor> cursors;
static std::map<std::string, PHLWINDOWREF> awakeWindows;
static CHyprSignalListener renderListener;
static SP<Render::ITexture> cursorTextures[2];
class CAgentKeyboard : public IKeyboard {
  public:
    bool isVirtual() override { return true; }
    SP<Aquamarine::IKeyboard> aq() override { return nullptr; }
};
static SP<CAgentKeyboard> agentKeyboard;
static std::map<CWLPointerResource*, WP<CWLPointerResource>> scrollPointers;
static std::map<CWLKeyboardResource*, WP<CWLKeyboardResource>> agentKeyboards;

using PrimaryHandler = std::function<void(CZwpPrimarySelectionDeviceV1*, wl_resource*, uint32_t)>;
struct SPrimaryGuard {
    CZwpPrimarySelectionDeviceV1* device;
    PrimaryHandler original;
    wl_listener destroy{};
};
static std::map<wl_resource*, SPrimaryGuard> primaryGuards;
using ClipboardHandler = std::function<void(CWlDataDevice*, wl_resource*, uint32_t)>;
struct SClipboardGuard {
    CWlDataDevice* device;
    ClipboardHandler original;
    wl_listener destroy{};
};
static std::map<wl_resource*, SClipboardGuard> clipboardGuards;
static wl_protocol_logger* selectionLogger = nullptr;
static std::string selectionDiagnostic;
static std::map<pid_t, int> registeredProcesses;
static std::map<pid_t, std::unique_ptr<ScopedProcess>> scopedProcesses;
static std::map<pid_t, SP<Desktop::Rule::CWindowRule>> launchRules;
static CHyprSignalListener configReloadListener;

static void pruneLaunchRules() {
    for (auto it = launchRules.begin(); it != launchRules.end();) {
        const auto process = scopedProcesses.find(it->first);
        if (process == scopedProcesses.end() || !process->second->valid()) {
            Desktop::Rule::ruleEngine()->unregisterRule(it->second);
            it = launchRules.erase(it);
        } else
            ++it;
    }
}

static std::pair<SP<Desktop::Rule::CWindowRule>, std::string> prepareLaunchRule() {
    using namespace Desktop::Rule;
    const auto token = g_pTokenManager->getRandomUUID();
    if (!std::regex_match(token, std::regex{"[0-9a-fA-F-]{36}"}))
        throw std::runtime_error("cannot create native launch identity");
    auto rule = makeShared<CWindowRule>("orbit_native_" + token);
    // Token-only matching has no numeric PID fallback and survives PID reuse.
    rule->registerMatch(RULE_PROP_EXEC_TOKEN, "^" + token + "$");
    for (const auto& [effect, value] : std::vector<std::pair<eWindowRuleEffect, std::string>>{
             {WINDOW_RULE_EFFECT_WORKSPACE, "special:ghost silent"},
             {WINDOW_RULE_EFFECT_NOINITIALFOCUS, "1"},
             {WINDOW_RULE_EFFECT_FOCUS_ON_ACTIVATE, "0"},
             {WINDOW_RULE_EFFECT_RENDER_UNFOCUSED, "1"}}) {
        if (auto result = rule->addEffect(effect, value); !result)
            throw std::runtime_error("cannot prepare native launch rule: " + result.error());
    }
    return {rule, token};
}

static void pruneScopedProcesses() {
    for (auto it = scopedProcesses.begin(); it != scopedProcesses.end();)
        if (it->second->exited())
            it = scopedProcesses.erase(it);
        else
            ++it;
}

static void pruneRegisteredProcesses() {
    for (auto it = registeredProcesses.begin(); it != registeredProcesses.end();) {
        pollfd fd{it->second, POLLIN, 0};
        if (poll(&fd, 1, 0) > 0) {
            close(it->second);
            it = registeredProcesses.erase(it);
        } else
            ++it;
    }
}

static bool agentClient(wl_client* client) {
    pruneRegisteredProcesses();
    pid_t pid;
    wl_client_get_credentials(client, &pid, nullptr, nullptr);
    const auto runtime = std::getenv("XDG_RUNTIME_DIR");
    const bool privateLab = runtime && std::string_view{runtime}.starts_with("/tmp/gl-");
    const auto scoped = scopedProcesses.find(pid);
    bool found = scoped != scopedProcesses.end() && scoped->second->valid();
    if (scoped != scopedProcesses.end() && !found)
        return false; // An expired scoped registration cannot fall back to workspace ownership.
    found = found || (privateLab && registeredProcesses.contains(pid));
    for (const auto& window : Desktop::windowState()->windows()) {
        auto surface = window->resource();
        if (!window->m_isMapped || !surface || surface->client() != client)
            continue;
        if (!window->m_workspace || window->m_workspace->m_name != AGENT_SPACE)
            return false;
        found = found || privateLab;
    }
    return found;
}

template <typename Device, typename Guards, typename Destroy, typename Configure>
static void installSelectionGuard(Device* raw, Guards& guards, Destroy destroy, Configure configure) {
    auto resource = raw->resource();
    if (guards.contains(resource))
        return;
    const auto original = raw->requests.setSelection;
    auto [it, inserted] = guards.try_emplace(resource);
    auto& guard = it->second;
    guard.device = raw;
    guard.original = original;
    guard.destroy.notify = destroy;
    wl_resource_add_destroy_listener(resource, &guard.destroy);
    configure(raw, original);
}

template <typename Guards>
static void restoreSelectionGuards(Guards& guards) {
    for (auto& [resource, guard] : guards) {
        guard.device->setSetSelection(guard.original);
        wl_list_remove(&guard.destroy.link);
    }
    guards.clear();
}

static void guardPrimarySelection(wl_client* client) {
    for (const auto& device : PROTO::primarySelection->m_devices) {
        if (device->client() != client)
            continue;
        installSelectionGuard(device->m_resource.get(), primaryGuards, [](wl_listener* listener, void* data) {
            wl_list_remove(&listener->link);
            primaryGuards.erase(static_cast<wl_resource*>(data));
        }, [](auto* raw, auto original) {
          raw->setSetSelection([original](CZwpPrimarySelectionDeviceV1* current, wl_resource* source, uint32_t serial) {
            // Native text selection stays local. It must not publish or clear the person's primary selection.
            if (!agentClient(current->client()))
                original(current, source, serial);
          });
        });
    }
}

static void guardClipboard(wl_client* client) {
    for (const auto& device : PROTO::data->m_devices) {
        if (device->client() != client)
            continue;
        installSelectionGuard(device->m_resource.get(), clipboardGuards, [](wl_listener* listener, void* data) {
            wl_list_remove(&listener->link);
            clipboardGuards.erase(static_cast<wl_resource*>(data));
        }, [](auto* raw, auto original) {
          raw->setSetSelection([original](CWlDataDevice* current, wl_resource* sourceR, uint32_t serial) {
            if (!agentClient(current->client())) {
                original(current, sourceR, serial);
                return;
            }
            auto source = sourceR ? CWLDataSourceResource::fromResource(sourceR) : SP<CWLDataSourceResource>{};
            if (source)
                source->markUsed();
            // Offers are client-local. Do not change the seat selection or invalidate owner offers.
            for (const auto& target : PROTO::data->m_devices) {
                if (target->client() == current->client())
                    PROTO::data->sendSelectionToDevice(target, source);
            }
          });
        });
    }
}

static void selectionRequest(void*, wl_protocol_logger_type direction, const wl_protocol_logger_message* message) {
    if (direction != WL_PROTOCOL_LOGGER_REQUEST || std::strcmp(message->message->name, "set_selection") != 0)
        return;
    auto client = wl_resource_get_client(message->resource);
    if (!agentClient(client)) {
        const auto interface = wl_resource_get_class(message->resource);
        if (std::strcmp(interface, "zwp_primary_selection_device_v1") == 0) {
            std::string state;
            for (const auto& window : Desktop::windowState()->windows()) {
                auto surface = window->resource();
                if (surface && surface->client() == client)
                    state += std::format("mapped={} workspace={};", window->m_isMapped,
                        window->m_workspace ? window->m_workspace->m_name : "none");
            }
            selectionDiagnostic = state.empty() ? "no known window for requesting client" : state;
        }
        return;
    }
    const auto interface = wl_resource_get_class(message->resource);
    if (std::strcmp(interface, "zwp_primary_selection_device_v1") == 0)
        guardPrimarySelection(client);
    else if (std::strcmp(interface, "wl_data_device") == 0)
        guardClipboard(client);
}

// Render-only geometry has no Wayland surface or input region.
static void drawCursors(eRenderStage stage) {
    if (stage != RENDER_LAST_MOMENT)
        return;
    auto mon = g_pHyprRenderer->m_renderData.pMonitor.lock();
    if (!mon)
        return;
    for (auto it = cursors.begin(); it != cursors.end();) {
        auto w = it->second.window.lock();
        if (!w || !w->m_isMapped || !w->m_workspace || w->m_workspace->m_name != AGENT_SPACE) {
            it = cursors.erase(it);
            continue;
        }
        if (w->m_monitor.lock() != mon) {
            ++it;
            continue;
        }
        auto box = w->surfaceLogicalBox();
        if (!box) {
            ++it;
            continue;
        }
        const Vector2D pos = (Vector2D{box->x, box->y} + it->second.local - mon->m_position) * mon->m_scale;
        const int variant = (reinterpret_cast<uintptr_t>(w.get()) >> 4) & 1;
        if (!cursorTextures[variant]) {
            // Rasterize once at 4x resolution, then reuse one filtered texture.
            auto surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, 120, 144);
            auto cr = cairo_create(surface);
            cairo_scale(cr, 4, 4);
            cairo_set_line_join(cr, CAIRO_LINE_JOIN_ROUND);
            cairo_move_to(cr, 4, 3);
            cairo_line_to(cr, 4, 25);
            cairo_line_to(cr, 10, 20);
            cairo_line_to(cr, 14.5, 30);
            cairo_line_to(cr, 19, 28);
            cairo_line_to(cr, 14.5, 18.5);
            cairo_line_to(cr, 23, 18.5);
            cairo_close_path(cr);
            cairo_set_source_rgb(cr, 0.10, 0.14, 0.20);
            cairo_fill_preserve(cr);
            cairo_set_source_rgb(cr, 0.98, 0.99, 1.0);
            cairo_set_line_width(cr, 1.6);
            cairo_stroke(cr);
            // A small accent distinguishes agent pointers from the owner's.
            cairo_arc(cr, 24, 28, 3.2, 0, 2 * M_PI);
            cairo_set_source_rgb(cr, variant ? 0.28 : 0.08, variant ? 0.55 : 0.72, variant ? 0.98 : 0.62);
            cairo_fill_preserve(cr);
            cairo_set_source_rgb(cr, 0.98, 0.99, 1.0);
            cairo_set_line_width(cr, 1.2);
            cairo_stroke(cr);
            cairo_destroy(cr);
            cairo_surface_flush(surface);
            cursorTextures[variant] = g_pHyprRenderer->createTexture(surface);
            cairo_surface_destroy(surface);
        }
        CTexPassElement::SRenderData data;
        data.tex = cursorTextures[variant];
        data.box = CBox{pos.x - 4 * mon->m_scale, pos.y - 3 * mon->m_scale, 30 * mon->m_scale, 36 * mon->m_scale};
        data.damage = CRegion{data.box};
        g_pHyprRenderer->addPassElement(makeUnique<CTexPassElement>(std::move(data)));
        ++it;
    }
}

static uint32_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

struct STarget {
    PHLWINDOW               window;
    SP<CWLSurfaceResource>  surface;
    SP<CWLSeatResource>     seat;
    std::string             error;
};

static STarget resolve(const std::string& address, bool wake = true) {
    STarget t;
    std::string want = address;
    std::string stable, unit;
    if (const auto separator = want.find('@'); separator != std::string::npos) {
        const auto next = want.find('@', separator + 1);
        if (next == std::string::npos || want.find('@', next + 1) != std::string::npos) {
            t.error = "refused: invalid guarded native target";
            return t;
        }
        stable = want.substr(separator + 1, next - separator - 1);
        unit = want.substr(next + 1);
        want.resize(separator);
        if (!std::regex_match(stable, std::regex{"[0-9a-f]{1,16}"}) ||
            !std::regex_match(unit, std::regex{"orbit-native-[0-9a-f]{32}\\.scope"})) {
            t.error = "refused: invalid guarded native identity";
            return t;
        }
    }
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
    if (!stable.empty() && std::format("{:x}", t.window->m_stableID) != stable) {
        t.error = "refused: native window stable identity changed";
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
    if (!unit.empty()) {
        pid_t pid = 0;
        wl_client_get_credentials(t.surface->client(), &pid, nullptr, nullptr);
        const auto registration = scopedProcesses.find(pid);
        if (registration == scopedProcesses.end() || !registration->second->valid() ||
            !registration->second->belongsTo(unit)) {
            t.error = "refused: native target belongs to another scope";
            return t;
        }
    }
    if (!agentClient(t.surface->client())) {
        t.error = "refused: target client also owns non-agent windows";
        return t;
    }
    // Never deliver to whatever the seat itself focuses: that is the person's input path.
    auto keyboardFocus = g_pSeatManager->m_state.keyboardFocus.lock();
    auto pointerFocus = g_pSeatManager->m_state.pointerFocus.lock();
    if ((keyboardFocus && keyboardFocus->client() == t.surface->client()) ||
        (pointerFocus && pointerFocus->client() == t.surface->client())) {
        t.error = "refused: target client holds the seat focus";
        return t;
    }
    t.seat = g_pSeatManager->seatResourceForClient(t.surface->client());
    if (!t.seat)
        t.error = "client has no seat";
    else if (wake) {
        guardPrimarySelection(t.surface->client());
        // Background rendering requires the client to keep processing paint events.
        auto xdg = t.window->m_xdgSurface.lock();
        if (xdg && xdg->m_toplevel &&
            std::ranges::find(xdg->m_toplevel->m_pendingApply.states, XDG_TOPLEVEL_STATE_SUSPENDED) !=
                xdg->m_toplevel->m_pendingApply.states.end())
            awakeWindows[address] = t.window;
        t.window->setSuspended(false);
    }
    return t;
}

// One keystroke: keycode in evdev numbering (xkb keycode minus 8).
struct SStroke {
    uint32_t evdev;
    uint32_t mods;
    uint32_t group;
};

static bool sendStrokes(const STarget& t, const std::vector<SStroke>& strokes) {
    int sent = 0;
    wl_array keys;
    wl_array_init(&keys);
    for (auto const& kw : t.seat->m_keyboards) {
        auto k = kw.lock();
        if (!k)
            continue;
        ++sent;
        k->sendKeymap(agentKeyboard);
        k->sendEnter(t.surface, &keys);
        for (auto const& s : strokes) {
            // Our own modifier state, never the seat's: a Shift the person holds must not leak in.
            k->sendMods(s.mods, 0, 0, s.group);
            k->sendKey(nowMs(), s.evdev, WL_KEYBOARD_KEY_STATE_PRESSED);
            k->sendKey(nowMs(), s.evdev, WL_KEYBOARD_KEY_STATE_RELEASED);
        }
        k->sendMods(0, 0, 0, 0);
        // Keep the target resource stable until the task has read back its result.
        agentKeyboards[k.get()] = k;
    }
    wl_array_release(&keys);
    return sent > 0;
}

static xkb_keymap* seatKeymap() {
    return agentKeyboard ? agentKeyboard->m_xkbKeymap : nullptr;
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
    if (cmd == "ghost-texthex") {
        if (text.size() > 131072 || text.size() % 2)
            return "invalid hex text length";
        std::string decoded;
        decoded.reserve(text.size() / 2);
        auto nibble = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        for (size_t i = 0; i < text.size(); i += 2) {
            const int high = nibble(text[i]), low = nibble(text[i + 1]);
            if (high < 0 || low < 0)
                return "invalid hex text";
            decoded.push_back(static_cast<char>((high << 4) | low));
        }
        text = std::move(decoded);
    }
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
        int           len = c < 0x80 ? 1 : c >= 0xC2 && c <= 0xDF ? 2 : c >= 0xE0 && c <= 0xEF ? 3 : c >= 0xF0 && c <= 0xF4 ? 4 : 0;
        if (!len || i + len > text.size())
            return "invalid UTF-8";
        cp               = len == 1 ? c : len == 2 ? (c & 0x1F) : len == 3 ? (c & 0x0F) : (c & 0x07);
        for (int j = 1; j < len; ++j) {
            if ((static_cast<unsigned char>(text[i + j]) & 0xC0) != 0x80)
                return "invalid UTF-8";
            cp = (cp << 6) | (text[i + j] & 0x3F);
        }
        if ((len == 2 && cp < 0x80) || (len == 3 && cp < 0x800) || (len == 4 && cp < 0x10000) ||
            cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF))
            return "invalid UTF-8";
        i += len;
        xkb_keysym_t sym = cp == '\n' ? XKB_KEY_Return : cp == '\t' ? XKB_KEY_Tab : xkb_utf32_to_keysym(cp);
        SStroke      s;
        if (!findKeysym(km, sym, s))
            return std::format("no key for U+{:04X} in the seat keymap", cp);
        strokes.push_back(s);
    }
    if (!sendStrokes(t, strokes))
        return "target has no keyboard resource";
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
        const auto index = xkb_keymap_mod_get_index(km, name);
        if (index == XKB_MOD_INVALID || index >= 32)
            return "modifier unavailable " + m;
        mods |= 1u << index;
    }
    xkb_keysym_t sym = xkb_keysym_from_name(key.c_str(), XKB_KEYSYM_CASE_INSENSITIVE);
    if (sym == XKB_KEY_NoSymbol)
        return "unknown key " + key;
    SStroke s;
    if (!findKeysym(km, sym, s))
        return "no key for " + key;
    s.mods |= mods;
    if (!sendStrokes(t, {s}))
        return "target has no keyboard resource";
    return "ok";
}

static std::string pointerCmd(std::string req, int kind) {
    std::istringstream in(req);
    std::string        cmd, address;
    double             x = 0, y = 0, extra = 0;
    if (!(in >> cmd >> address >> x >> y))
        return "expected window address and x y coordinates";
    in >> extra;
    auto t = resolve(address);
    if (!t.error.empty())
        return t.error;
    const Vector2D local{x, y};
    const auto box = t.window->surfaceLogicalBox();
    if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(extra) || !box ||
        x < 0 || y < 0 || x >= box->w || y >= box->h)
        return "refused: coordinates outside target surface";
    if (kind == 2 && (extra == 0 || std::abs(extra) > 10000 || std::trunc(extra) != extra))
        return "refused: scroll steps must be a nonzero integer within 10000";
    cursors[address] = {t.window, local};
    g_pHyprRenderer->damageMonitor(t.window->m_monitor.lock());
    if (kind == 3)
        return "ok";
    int sent = 0;
    for (auto const& pw : t.seat->m_pointers) {
        auto p = pw.lock();
        if (!p)
            continue;
        ++sent;
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
            if (p->version() >= 8) {
                p->sendAxis(nowMs(), WL_POINTER_AXIS_VERTICAL_SCROLL, extra * 15.0);
                p->sendAxisValue120(WL_POINTER_AXIS_VERTICAL_SCROLL, (int32_t)(extra * 120));
            } else {
                p->sendAxisDiscrete(WL_POINTER_AXIS_VERTICAL_SCROLL, (int32_t)extra);
                p->sendAxis(nowMs(), WL_POINTER_AXIS_VERTICAL_SCROLL, extra * 15.0);
            }
            p->sendFrame();
        }
        if (kind == 2) {
            // Qt can defer a wheel frame. Keep only this client's synthetic
            // pointer focus until a later pointer action or explicit release.
            scrollPointers[p.get()] = p;
        } else {
            p->sendLeave();
            p->sendFrame();
            scrollPointers.erase(p.get());
        }
    }
    std::erase_if(scrollPointers, [](const auto& entry) { return !entry.second.lock(); });
    return sent ? "ok" : "target has no pointer resource";
}

APICALL EXPORT std::string PLUGIN_API_VERSION() {
    return HYPRLAND_API_VERSION;
}

APICALL EXPORT PLUGIN_DESCRIPTION_INFO PLUGIN_INIT(HANDLE handle) {
    PHANDLE = handle;
#ifndef ORBIT_PLUGIN_SOURCE_SHA256
    throw std::runtime_error("[ghostinput] build.sh source stamp is required");
#else
    const std::string sourceStamp = ORBIT_PLUGIN_SOURCE_SHA256;
    if (sourceStamp.size() != 64 || sourceStamp.find_first_not_of("0123456789abcdef") != std::string::npos)
        throw std::runtime_error("[ghostinput] invalid compiled source stamp");
#endif
    const std::string HASH = __hyprland_api_get_hash();
    if (HASH != __hyprland_api_get_client_hash()) {
        HyprlandAPI::addNotification(PHANDLE, "[ghostinput] built for another Hyprland, refusing", CHyprColor{1.0, 0.2, 0.2, 1.0}, 5000);
        throw std::runtime_error("[ghostinput] version mismatch");
    }
    agentKeyboard = makeShared<CAgentKeyboard>();
    const auto context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    const xkb_rule_names names{.rules = "evdev", .model = "pc105", .layout = "us,ara", .variant = "", .options = ""};
    agentKeyboard->m_xkbKeymap = xkb_keymap_new_from_names(context, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
    xkb_context_unref(context);
    if (!agentKeyboard->m_xkbKeymap)
        throw std::runtime_error("[ghostinput] cannot build agent keymap");
    agentKeyboard->updateKeymapFD();
#ifdef ORBIT_PLUGIN_SOURCE_SHA256
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-build-info", false,
        [sourceStamp, HASH](eHyprCtlOutputFormat, std::string request) {
            if (request != "ghost-build-info")
                return std::string{"refused: build-info takes no arguments"};
            std::map<pid_t, bool> liveRoots;
            try {
                for (const auto& [pid, identity] : scopedProcesses)
                    if (identity->live())
                        liveRoots[pid] = true;
                for (const auto& [pid, descriptor] : registeredProcesses)
                    if (ScopedProcess::descriptorLive(descriptor))
                        liveRoots[pid] = true;
            } catch (const std::exception&) {
                return std::string{"refused: registered root liveness unavailable"};
            }
            return std::string{"{\"schema\":1,\"source_sha256\":\""} + sourceStamp +
                "\",\"abi_hash\":\"" + HASH + "\",\"live_roots\":" + std::to_string(liveRoots.size()) + "}";
        }});
#endif
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-register-scope-process", false,
        [](eHyprCtlOutputFormat, std::string request) {
            std::istringstream in(request);
            std::string command, unit, extra;
            pid_t pid = 0;
            if (!(in >> command >> pid >> unit) || (in >> extra))
                return std::string{"invalid scoped process"};
            pruneScopedProcesses();
            pruneLaunchRules();
            if (!scopedProcesses.contains(pid) && scopedProcesses.size() >= 64)
                return std::string{"native process registration limit reached"};
            try {
                auto identity = std::make_unique<ScopedProcess>(pid, unit);
                auto [rule, token] = prepareLaunchRule();
                SP<Desktop::Rule::IRule> baseRule = rule;
                Desktop::Rule::ruleEngine()->registerRule(std::move(baseRule));
                if (auto existing = launchRules.find(pid); existing != launchRules.end())
                    Desktop::Rule::ruleEngine()->unregisterRule(existing->second);
                launchRules[pid] = std::move(rule);
                scopedProcesses[pid] = std::move(identity);
                return "ok " + token;
            } catch (const std::exception& error) {
                return std::string{error.what()};
            }
        }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-register-process", false,
        [](eHyprCtlOutputFormat, std::string request) {
            std::istringstream in(request);
            std::string command, extra;
            pid_t pid = 0;
            in >> command >> pid;
            if (pid <= 0 || (in >> extra))
                return std::string{"invalid process"};
            const auto runtime = std::getenv("XDG_RUNTIME_DIR");
            if (!runtime || !std::string_view{runtime}.starts_with("/tmp/gl-"))
                return std::string{"process registration is currently lab-only"};
            const int fd = syscall(SYS_pidfd_open, pid, 0);
            if (fd < 0)
                return std::string{"cannot retain process identity"};
            std::ifstream stream(std::format("/proc/{}/environ", pid));
            std::string environment((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
            const std::string expected = std::string{"XDG_RUNTIME_DIR="} + runtime + '\0';
            bool matches = false;
            for (size_t at = 0; at < environment.size();) {
                const auto end = environment.find('\0', at);
                if (end == std::string::npos)
                    break;
                if (environment.substr(at, end - at + 1) == expected)
                    matches = true;
                at = end + 1;
            }
            if (!matches) {
                close(fd);
                return std::string{"process is not in this private lab"};
            }
            pruneRegisteredProcesses();
            if (auto existing = registeredProcesses.find(pid); existing != registeredProcesses.end())
                close(existing->second);
            registeredProcesses[pid] = fd;
            return std::string{"ok"};
        }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-selection-diagnostic", false,
        [](eHyprCtlOutputFormat, std::string) { return selectionDiagnostic; }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-target-check", false, [](eHyprCtlOutputFormat, std::string r) {
        std::istringstream in(r);
        std::string command, address, extra;
        if (!(in >> command >> address) || (in >> extra) || address.find('@') == std::string::npos)
            return std::string{"refused: guarded target required"};
        const auto target = resolve(address, false);
        return target.error.empty() ? std::string{"ok"} : target.error;
    }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-state", false, [](eHyprCtlOutputFormat, std::string r) {
        std::istringstream in(r);
        std::string cmd, address;
        in >> cmd >> address;
        auto target = resolve(address, false);
        if (!target.error.empty())
            return target.error;
        auto xdg = target.window->m_xdgSurface.lock();
        if (!xdg || !xdg->m_toplevel)
            return std::string{"state unavailable: target is not an XDG toplevel"};
        const auto& states = xdg->m_toplevel->m_pendingApply.states;
        const bool suspended = std::ranges::find(states, XDG_TOPLEVEL_STATE_SUSPENDED) != states.end();
        return std::format("{{\"suspended\":{},\"render_unfocused\":{}}}",
            suspended ? "true" : "false",
            target.window->m_ruleApplicator->renderUnfocused().valueOrDefault() ? "true" : "false");
    }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-type", false, cmdType});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-texthex", false, cmdType});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-key", false, cmdKey});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-click", false, [](eHyprCtlOutputFormat, std::string r) { return pointerCmd(r, 1); }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-move", false, [](eHyprCtlOutputFormat, std::string r) { return pointerCmd(r, 0); }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-scroll", false, [](eHyprCtlOutputFormat, std::string r) { return pointerCmd(r, 2); }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-release", false, [](eHyprCtlOutputFormat, std::string r) {
        std::istringstream in(r);
        std::string cmd, address;
        in >> cmd >> address;
        auto target = resolve(address);
        if (!target.error.empty())
            return target.error;
        for (const auto& weak : target.seat->m_pointers) {
            if (auto pointer = weak.lock()) {
                if (!scrollPointers.contains(pointer.get()))
                    continue;
                pointer->sendLeave();
                pointer->sendFrame();
                scrollPointers.erase(pointer.get());
            }
        }
        for (const auto& weak : target.seat->m_keyboards) {
            if (auto keyboard = weak.lock()) {
                if (!agentKeyboards.contains(keyboard.get()))
                    continue;
                keyboard->sendLeave();
                keyboard->sendKeymap(g_pSeatManager->m_keyboard.lock());
                agentKeyboards.erase(keyboard.get());
            }
        }
        if (auto it = awakeWindows.find(address); it != awakeWindows.end()) {
            if (auto window = it->second.lock(); window && !g_pHyprRenderer->shouldRenderWindow(window))
                window->setSuspended(true);
            awakeWindows.erase(it);
        }
        return std::string{"ok"};
    }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-cursor", false, [](eHyprCtlOutputFormat, std::string r) { return pointerCmd(r, 3); }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-hide-cursor", false, [](eHyprCtlOutputFormat, std::string r) {
        std::istringstream in(r);
        std::string cmd, address;
        in >> cmd >> address;
        auto target = resolve(address, false);
        if (!target.error.empty())
            return target.error;
        auto it = cursors.find(address);
        if (it == cursors.end())
            return std::string{"no cursor for window"};
        if (auto w = it->second.window.lock())
            g_pHyprRenderer->damageMonitor(w->m_monitor.lock());
        cursors.erase(it);
        return std::string{"ok"};
    }});
    renderListener = Event::bus()->m_events.render.stage.listen(drawCursors);
    configReloadListener = Event::bus()->m_events.config.reloaded.listen([] {
        pruneLaunchRules();
        for (const auto& [pid, rule] : launchRules) {
            const auto active = std::ranges::any_of(Desktop::Rule::ruleEngine()->rules(),
                [&rule](const auto& current) { return current.get() == rule.get(); });
            if (!active) {
                SP<Desktop::Rule::IRule> baseRule = rule;
                Desktop::Rule::ruleEngine()->registerRule(std::move(baseRule));
            }
        }
    });
    selectionLogger = wl_display_add_protocol_logger(g_pCompositor->m_wlDisplay, selectionRequest, nullptr);
    if (!selectionLogger)
        throw std::runtime_error("[ghostinput] cannot install selection request observer");
    return {"ghostinput", "Background keyboard and pointer input to one window", "sbar-orbit experiment", "0.1"};
}

APICALL EXPORT void PLUGIN_EXIT() {
    configReloadListener.reset();
    for (const auto& [pid, rule] : launchRules)
        Desktop::Rule::ruleEngine()->unregisterRule(rule);
    launchRules.clear();
    if (selectionLogger) {
        wl_protocol_logger_destroy(selectionLogger);
        selectionLogger = nullptr;
    }
    for (const auto& [key, weak] : scrollPointers) {
        auto pointer = weak.lock();
        auto focus = g_pSeatManager->m_state.pointerFocus.lock();
        if (!pointer || !pointer->m_owner ||
            (focus && focus->client() == pointer->m_owner->client()))
            continue;
        pointer->sendLeave();
        pointer->sendFrame();
    }
    scrollPointers.clear();
    for (const auto& [key, weak] : agentKeyboards) {
        auto keyboard = weak.lock();
        auto focus = g_pSeatManager->m_state.keyboardFocus.lock();
        if (!keyboard || !keyboard->m_owner ||
            (focus && focus->client() == keyboard->m_owner->client()))
            continue;
        keyboard->sendLeave();
        keyboard->sendKeymap(g_pSeatManager->m_keyboard.lock());
    }
    agentKeyboards.clear();
    restoreSelectionGuards(primaryGuards);
    restoreSelectionGuards(clipboardGuards);
    for (const auto& [address, weak] : awakeWindows) {
        if (auto window = weak.lock(); window && !g_pHyprRenderer->shouldRenderWindow(window))
            window->setSuspended(true);
    }
    awakeWindows.clear();
    renderListener.reset();
    for (const auto& [address, cursor] : cursors) {
        if (auto w = cursor.window.lock())
            g_pHyprRenderer->damageMonitor(w->m_monitor.lock());
    }
    cursors.clear();
    for (auto& texture : cursorTextures)
        texture.reset();
    agentKeyboard.reset();
    for (const auto& [pid, fd] : registeredProcesses)
        close(fd);
    registeredProcesses.clear();
    scopedProcesses.clear();
}
