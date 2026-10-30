// ghostinput: deliver keyboard and pointer input to one background window without touching the
// shared seat. Every event goes only to the target client's own wl_keyboard / wl_pointer resources,
// framed by its own enter and leave, so the seat's focus, the person's pointer and the person's
// application never see anything. The Linux analog of posting events to one process.
//
// Hyprctl input commands require an explicit owner application lease.
//   ghost-type  <address> <text>                 type UTF-8 text through the seat keymap
//   ghost-key   <address> <combo>                one key, e.g. Return, ctrl+a, shift+Tab
//   ghost-click <address> <x> <y> [button]       press and release at surface-local x,y
//   ghost-move  <address> <x> <y>                pointer enter and motion only
//   ghost-scroll <address> <x> <y> <dy>         vertical scroll in steps of 15 units
//   ghost-mouse-down <address> <x> <y> [button]  press and hold; moves while held follow the drawn path
//   ghost-mouse-up   <address> <x> <y> [button]  travel to the point, then release
//   ghost-drag <address> x1 y1 x2 y2 [button]    press, curved move, release; ghost-state reports motion_active
// Every pointer command keeps the synthetic pointer on the surface (hover) until the next
// action, ghost-release, owner input or a timeout (15 s hover, 30 s with a button held).
// A held button is released on all of those ends and on handback and unload.
//   ghost-cursor <address> <x> <y>             render the agent cursor without input
//   ghost-hide-cursor <address>                remove that window's cursor
#include <chrono>
#include <algorithm>
#include <cctype>
#include <sstream>
#include <hyprland/src/plugins/PluginAPI.hpp>
// Load generated request storage before other protocol headers include it.
#define private public
#include <hyprland/protocols/wayland.hpp>
#undef private
#define private public
#include <hyprland/src/managers/SeatManager.hpp>
#include <hyprland/src/protocols/core/Seat.hpp>
#undef private
#include <hyprland/src/desktop/state/WindowState.hpp>
#include <hyprland/src/desktop/state/FocusState.hpp>
#define private public
#include <hyprland/src/desktop/rule/windowRule/WindowRuleApplicator.hpp>
#undef private
#include <hyprland/src/desktop/view/window/Window.hpp>
#include <hyprland/src/desktop/view/Popup.hpp>
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
#define protected public
#include <hyprland/src/managers/eventLoop/EventLoopManager.hpp>
#include <hyprland/src/render/Renderer.hpp>
#undef protected
#include <hyprland/src/render/pass/TexPassElement.hpp>
#include <hyprland/src/render/Texture.hpp>
#include <hyprland/src/render/ElementRenderer.hpp>
#include <cairo/cairo.h>
#include <functional>
#include <array>
#include <set>
// Version-matched private access follows Hyprland's documented plugin pattern.
#define private public
#include <hyprland/src/protocols/PrimarySelection.hpp>
#include <hyprland/src/protocols/core/DataDevice.hpp>
#include <hyprland/src/protocols/DataDeviceWlr.hpp>
#include <hyprland/src/protocols/ExtDataDevice.hpp>
#undef private
#include <hyprland/src/Compositor.hpp>
#include <hyprland/src/state/MonitorState.hpp>
#include <hyprland/src/state/WorkspaceState.hpp>
#include <hyprland/src/state/WorkspacePlacementController.hpp>
#include <hyprland/src/pointer/PointerManager.hpp>
#include <hyprland/src/layout/LayoutManager.hpp>
#include <hyprland/src/animation/WorkspaceAnimationController.hpp>
#include <cstring>
#include <fstream>
#include <filesystem>
#include <sys/syscall.h>
#include <poll.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <linux/magic.h>
#include <cerrno>
#include <regex>
#include <memory>
#include <cstdio>

// Workspace ids became a numbered or special variant in Hyprland 0.57.
static std::optional<int64_t> workspaceNumber(const PHLWORKSPACE& workspace) {
    if (!workspace) return std::nullopt;
    const auto id = workspace->id();
    if (const auto numbered = std::get_if<Workspace::SWorkspaceNumberedID>(&id)) return static_cast<int64_t>(numbered->value);
    return std::nullopt;
}
static PHLWORKSPACE findNumberedWorkspace(int64_t id) {
    for (const auto& ref : State::workspaceState()->workspaces())
        if (const auto workspace = ref.lock(); workspaceNumber(workspace) == id) return workspace;
    return nullptr;
}
// Hyprland 0.57 moved the XDG resource behind the window backend.
static SP<CXDGSurfaceResource> windowXdg(const PHLWINDOW& window) {
    if (!window || window->backend().isX11()) return {};
    const auto surface = window->backend().surface();
    if (!surface || !surface->m_role || surface->m_role->role() != SURFACE_ROLE_XDG_SHELL) return {};
    return static_cast<CXDGSurfaceRole*>(surface->m_role.get())->m_xdgSurface.lock();
}

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

// Native unload scope identity begin. Compiled independently by the readiness probe.
class RetainedScope {
    int descriptor = -1;
    struct stat identity{};

  public:
    explicit RetainedScope(const std::string& unit) {
        if (!std::regex_match(unit, std::regex{"orbit-native-[0-9a-f]{32}\\.scope"}))
            throw std::runtime_error("invalid retained scope");
        const auto path = std::format("/sys/fs/cgroup/user.slice/user-{}.slice/user@{}.service/sbarorbit.slice/{}",
                                      getuid(), getuid(), unit);
        descriptor = open(path.c_str(), O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        struct statfs filesystem{};
        if (descriptor < 0 || fstat(descriptor, &identity) || fstatfs(descriptor, &filesystem) ||
            filesystem.f_type != CGROUP2_SUPER_MAGIC || !S_ISDIR(identity.st_mode)) {
            if (descriptor >= 0)
                close(descriptor);
            throw std::runtime_error("cannot retain native cgroup identity");
        }
    }
    RetainedScope(const RetainedScope&) = delete;
    RetainedScope& operator=(const RetainedScope&) = delete;
    ~RetainedScope() { close(descriptor); }
    bool sameAs(const RetainedScope& other) const {
        return identity.st_dev == other.identity.st_dev && identity.st_ino == other.identity.st_ino;
    }
    static bool populated(const std::string& data) {
        std::istringstream lines(data);
        std::string line;
        int result = -1;
        while (std::getline(lines, line)) {
            std::istringstream record(line);
            std::string key, value, extra;
            if (!(record >> key >> value) || (record >> extra))
                throw std::runtime_error("invalid native cgroup events");
            if (key == "populated") {
                if (result != -1 || (value != "0" && value != "1"))
                    throw std::runtime_error("invalid native cgroup population");
                result = value == "1";
            }
        }
        if (result < 0)
            throw std::runtime_error("native cgroup population missing");
        return result == 1;
    }
    bool empty() const {
        struct stat current{};
        if (fstat(descriptor, &current) || current.st_dev != identity.st_dev || current.st_ino != identity.st_ino)
            throw std::runtime_error("retained native scope identity unavailable");
        if (current.st_nlink == 0)
            return true;
        const int events = openat(descriptor, "cgroup.events", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        if (events < 0) {
            if (!fstat(descriptor, &current) && current.st_nlink == 0)
                return true;
            throw std::runtime_error("native cgroup population unavailable");
        }
        std::string data;
        try {
            char buffer[256];
            for (;;) {
                const auto count = read(events, buffer, sizeof(buffer));
                if (count < 0 && errno == EINTR)
                    continue;
                if (count < 0 || data.size() + count > 1024)
                    throw std::runtime_error("native cgroup events unavailable");
                if (count == 0)
                    break;
                data.append(buffer, count);
            }
        } catch (...) {
            close(events);
            throw;
        }
        close(events);
        const bool occupied = populated(data);
        if (fstat(descriptor, &current) || current.st_dev != identity.st_dev || current.st_ino != identity.st_ino)
            throw std::runtime_error("native cgroup population unverified");
        return !occupied;
    }
};
// Native unload scope identity end.

inline HANDLE PHANDLE = nullptr;
// Hyprland 0.57 replaced SHyprCtlCommand with IPC::Socket1::SCommand; keep one adapter.
#include <hyprland/src/ipc/s1/S1.hpp>
using eHyprCtlOutputFormat = IPC::Socket1::eOutputFormat;
struct SHyprCtlCommand {
    std::string name;
    bool exact;
    std::function<std::string(eHyprCtlOutputFormat, std::string)> handler;
};
static std::vector<SP<IPC::Socket1::SCommand>> ctlRegistrations;
static void registerCtl(SHyprCtlCommand command) {
    auto handler = std::move(command.handler);
    const auto registration = HyprlandAPI::registerHyprCtlCommand(PHANDLE, IPC::Socket1::SCommand{
        command.name,
        command.exact ? IPC::Socket1::COMMAND_MATCH_EXACT : IPC::Socket1::COMMAND_MATCH_PREFIX,
        [handler](const IPC::Socket1::SRequest& request) {
            return IPC::Socket1::SResponse(handler(request.format, request.command));
        }});
    if (registration) ctlRegistrations.push_back(registration);
}
// BEGIN cursor-motion
// Pure, dependency free path generator for the private visible cursor. It only
// shapes what is drawn; the application's pointer events are sent separately.
// tests/ghost-cursor-motion.test.ts extracts this region and compiles it alone.
namespace cursor_motion {
constexpr double kMinSeconds = 0.14, kMaxSeconds = 0.9, kSettleSeconds = 0.12;
constexpr double kOvershootFrom = 160, kOvershootMax = 14, kBowMax = 60, kDriftMax = 3;
constexpr double kDriftRampSeconds = 0.6;

struct Vec { double x = 0, y = 0; };

struct Rng {
    uint64_t state;
    explicit Rng(uint64_t seed) : state(seed) {}
    uint64_t next() {
        uint64_t z = (state += 0x9e3779b97f4a7c15ULL);
        z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
        z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
        return z ^ (z >> 31);
    }
    double unit() { return (next() >> 11) * (1.0 / 9007199254740992.0); }
    double range(double low, double high) { return low + (high - low) * unit(); }
};

struct Move {
    Vec from, to, c1, c2, over;
    bool overshoot = false, drift = false;
    double start = 0, mainSeconds = 0, settleSeconds = 0;
    double amplitude[2][2] = {}, rate[2][2] = {}, phase[2][2] = {};
    double total() const { return mainSeconds + settleSeconds; }
};

inline double minimumJerk(double tau) {
    tau = tau < 0 ? 0 : tau > 1 ? 1 : tau;
    return tau * tau * tau * (10 + tau * (-15 + 6 * tau));
}

inline Vec cubic(Vec a, Vec b, Vec c, Vec d, double t) {
    const double u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    return {w0 * a.x + w1 * b.x + w2 * c.x + w3 * d.x, w0 * a.y + w1 * b.y + w2 * c.y + w3 * d.y};
}

inline double travelSeconds(double distance) {
    const double seconds = 0.14 + 0.095 * std::log2(1 + distance / 30);
    return seconds < kMinSeconds ? kMinSeconds : seconds > kMaxSeconds ? kMaxSeconds : seconds;
}

// A fresh Move from the cursor's displayed position, so a new action begins
// exactly where the previous motion or drift left the drawing.
inline Move plan(Vec from, Vec to, uint64_t seed, double start, bool allowDrift, bool allowOvershoot = true) {
    Rng rng(seed);
    Move m;
    m.from = from; m.to = to; m.start = start; m.drift = allowDrift;
    const Vec delta{to.x - from.x, to.y - from.y};
    const double distance = std::hypot(delta.x, delta.y);
    if (distance >= 0.5) {
        const Vec unit{delta.x / distance, delta.y / distance}, normal{-unit.y, unit.x};
        const double sign = rng.unit() < 0.5 ? -1 : 1;
        double bow = distance * rng.range(0.04, 0.12) * sign;
        bow = bow > kBowMax ? kBowMax : bow < -kBowMax ? -kBowMax : bow;
        m.overshoot = allowOvershoot && distance >= kOvershootFrom;
        double reach = 0;
        if (m.overshoot) {
            reach = distance * 0.025 * rng.range(0.5, 1.0);
            reach = reach > kOvershootMax ? kOvershootMax : reach;
            m.over = {to.x + unit.x * reach + normal.x * bow * 0.05, to.y + unit.y * reach + normal.y * bow * 0.05};
        } else {
            m.over = to;
        }
        const Vec aim = m.over;
        m.c1 = {from.x + (aim.x - from.x) / 3 + normal.x * bow, from.y + (aim.y - from.y) / 3 + normal.y * bow};
        m.c2 = {from.x + (aim.x - from.x) * 2 / 3 + normal.x * bow * 0.6, from.y + (aim.y - from.y) * 2 / 3 + normal.y * bow * 0.6};
        m.mainSeconds = travelSeconds(distance);
        m.settleSeconds = m.overshoot ? kSettleSeconds : 0;
    }
    // Two slow sine terms per axis; the summed amplitude stays below kDriftMax.
    for (int axis = 0; axis < 2; ++axis) {
        m.amplitude[axis][0] = rng.range(0.8, 1.6);
        m.amplitude[axis][1] = rng.range(0.4, 1.0);
        m.rate[axis][0] = rng.range(0.12, 0.30) * 6.283185307179586;
        m.rate[axis][1] = rng.range(0.35, 0.60) * 6.283185307179586;
        m.phase[axis][0] = rng.range(0, 6.283185307179586);
        m.phase[axis][1] = rng.range(0, 6.283185307179586);
    }
    return m;
}

inline bool traveling(const Move& m, double now) { return now < m.start + m.total(); }

// The cursor's drawn position. Exactly `from` before start, exactly `to` at the
// end of travel, then `to` plus a bounded drift that eases in from zero.
inline Vec position(const Move& m, double now) {
    const double elapsed = now - m.start;
    if (elapsed <= 0) return m.from;
    if (elapsed < m.mainSeconds) return cubic(m.from, m.c1, m.c2, m.over, minimumJerk(elapsed / m.mainSeconds));
    if (elapsed < m.total()) {
        const double s = minimumJerk((elapsed - m.mainSeconds) / m.settleSeconds);
        return {m.over.x + (m.to.x - m.over.x) * s, m.over.y + (m.to.y - m.over.y) * s};
    }
    if (!m.drift) return m.to;
    const double idle = elapsed - m.total();
    const double ramp = minimumJerk(idle / kDriftRampSeconds);
    double offset[2];
    for (int axis = 0; axis < 2; ++axis) {
        offset[axis] = 0;
        for (int term = 0; term < 2; ++term)
            offset[axis] += m.amplitude[axis][term] * std::sin(m.rate[axis][term] * idle + m.phase[axis][term]);
        offset[axis] *= ramp;
    }
    return {m.to.x + offset[0], m.to.y + offset[1]};
}
}  // namespace cursor_motion
// END cursor-motion

struct SCursor {
    PHLWINDOWREF window;
    Vector2D local;
    Vector2D clickLocal;
    std::chrono::steady_clock::time_point clicked{};
    uint64_t sequence = 0;
    cursor_motion::Move motion;
    bool held = false;
    CBox lastDamage{};
};
static std::map<std::string, SCursor> cursors;
static uint64_t cursorSequence = 0;
static std::map<std::string, PHLWINDOWREF> awakeWindows;
static CHyprSignalListener renderListener;
static SP<Render::ITexture> cursorTextures[2];
static SP<Render::ITexture> clickTexture;
static SP<Render::ITexture> frameTextures[4];
static std::array<double, 3> indicatorColor{37.0 / 255, 95.0 / 255, 206.0 / 255};
static bool indicatorPulse = true;
static bool indicatorFrame = true;
static bool indicatorStyleDirty = false;
static std::map<int64_t, SP<Render::ITexture>> workspaceLabels;
class CAgentKeyboard : public IKeyboard {
  public:
    bool isVirtual() const override { return true; }
    SP<Aquamarine::IKeyboard> aq() override { return nullptr; }
};
static SP<CAgentKeyboard> agentKeyboard;
static std::map<CWLPointerResource*, WP<CWLPointerResource>> scrollPointers;
// Every synthetic pointer an agent keeps on a client surface is in scrollPointers and
// has one hold here: when it expires and which buttons the agent still holds down.
struct SPointerHold {
    std::set<uint32_t> buttons;
    std::chrono::steady_clock::time_point expires{};
};
static std::map<CWLPointerResource*, SPointerHold> pointerHolds;
static SP<CEventLoopTimer> holdTimer;
constexpr auto hoverHold = std::chrono::seconds(15), buttonHold = std::chrono::seconds(30);
static void armHoldTimer();
static SP<CEventLoopTimer> leaseReapTimer;
static void reapDeadOwnerLeases();
static std::map<CWLKeyboardResource*, WP<CWLKeyboardResource>> agentKeyboards;
static void cancelKeyboardClient(wl_client* client);
static void retireKeyboardClient(wl_client* client);
static void retireKeyboardLease(const std::string& id);
static void keyboardProtocolTransition(wl_protocol_logger_type, const wl_protocol_logger_message*);


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
    decltype(std::declval<CWlDataDevice>().requests.startDrag) originalStartDrag;
    wl_listener destroy{};
};
static std::map<wl_resource*, SClipboardGuard> clipboardGuards;

static wl_protocol_logger* selectionLogger = nullptr;

static std::map<pid_t, int> registeredProcesses;
static std::map<pid_t, std::unique_ptr<ScopedProcess>> scopedProcesses;
static std::map<std::string, std::unique_ptr<RetainedScope>> retainedScopes;
static bool admissionPaused = false;
static bool legacyEnrollmentOccurred = false;
static std::map<pid_t, SP<Desktop::Rule::CWindowRule>> launchRules;
static CHyprSignalListener configReloadListener;


// Existing application grants refer to actual live clients, not process ancestry.
struct SLeasedWindow {
    PHLWINDOWREF window;
    std::optional<bool> renderUnfocused;
    std::optional<bool> focusOnActivate;
    bool backgroundRenderingRegistered = false;
    bool createdWhileLeased = false;
    std::optional<bool> noInitialFocus;
    std::string originalWorkspace;
    std::optional<bool> originalFloating, originalCenter;
    std::optional<Math::SExpressionVec2> originalSize;
};
// BEGIN lease-owner
// The Orbit worker that claimed a lease names itself as pid:starttime. A lease whose
// worker is gone can never be handed back by that worker, so the plugin reaps it.
namespace lease_owner {
struct Owner { long pid = 0; unsigned long long start = 0; };

// Parse "pid:starttime"; both decimal, pid positive.
inline bool parse(const std::string& token, Owner& out) {
    const auto colon = token.find(':');
    if (colon == std::string::npos || colon == 0 || colon + 1 >= token.size() || token.size() > 40) return false;
    for (size_t i = 0; i < token.size(); ++i)
        if (i != colon && (token[i] < '0' || token[i] > '9')) return false;
    out.pid = std::strtol(token.substr(0, colon).c_str(), nullptr, 10);
    out.start = std::strtoull(token.substr(colon + 1).c_str(), nullptr, 10);
    return out.pid > 0;
}

// Field 22 of /proc/<pid>/stat, counted after the last ')' because the command name may hold anything.
inline bool startTicks(const std::string& stat, unsigned long long& ticks) {
    const auto close = stat.rfind(')');
    if (close == std::string::npos) return false;
    std::istringstream rest(stat.substr(close + 1));
    std::string field;
    for (int index = 3; index <= 22; ++index) {
        if (!(rest >> field)) return false;
        if (index == 22) { ticks = std::strtoull(field.c_str(), nullptr, 10); return true; }
    }
    return false;
}

// Dead only when the process is definitely gone or the pid now belongs to another process.
// An unreadable /proc entry is treated as alive, so nothing is reaped on a doubt.
inline bool alive(const Owner& owner, const std::string& procRoot = "/proc") {
    std::ifstream stream(procRoot + "/" + std::to_string(owner.pid) + "/stat");
    if (!stream) return std::filesystem::exists(procRoot + "/" + std::to_string(owner.pid));
    std::string line;
    std::getline(stream, line);
    unsigned long long ticks = 0;
    if (!startTicks(line, ticks)) return true;
    return ticks == owner.start;
}
}  // namespace lease_owner
// END lease-owner

struct SApplicationLease {
    wl_client* client = nullptr;
    wl_listener destroy{};
    bool paused = false;
    // Physical key, button or axis input delivered to this client pauses agent
    // input until this instant. Focus and hover alone never set it.
    std::chrono::steady_clock::time_point ownerInputUntil{};
    bool windowBound = false;
    PHLWINDOWREF windowRoot;
    std::array<char, 256> failure{};
    std::array<char, 256> claimFailure{};
    std::map<uint64_t, SLeasedWindow> windows;
    // Related portal windows receive placement only, never this client's input grant.
    std::map<uint64_t, SLeasedWindow> relatedWindows;
    std::set<uint64_t> baselineWindows;
    std::string homeWorkspace;
    std::string homeWorkspaceRule;
    std::optional<Math::SExpressionVec2> newWindowSize;
    std::string id;
    lease_owner::Owner owner;
    std::chrono::steady_clock::time_point claimedAt = std::chrono::steady_clock::now();
};
static std::map<std::string, std::unique_ptr<SApplicationLease>> applicationLeases;
static std::set<std::string> retiredApplicationLeases;
static SApplicationLease* applicationLeaseForClient(wl_client* client) {
    for (auto& [id, lease] : applicationLeases)
        if (lease->client == client)
            return lease.get();
    return nullptr;
}
static constexpr auto ownerIdleResume = std::chrono::milliseconds{2000};
static bool ownerInputActive(const SApplicationLease& lease) {
    return std::chrono::steady_clock::now() < lease.ownerInputUntil;
}
static bool applicationWindowAllowed(const SApplicationLease& lease, PHLWINDOW window) {
    if (!lease.windowBound) return true;
    const auto root = lease.windowRoot.lock();
    if (!window || !root) return false;
    if (window == root) return true;
    std::set<uint64_t> visited;
    for (auto parent = window->backend().parent(); parent && visited.size() < 16; parent = parent->backend().parent()) {
        if (!visited.insert(parent->metadata().stableID()).second) return false;
        if (parent == root) return true;
    }
    return false;
}
static void recordApplicationFailure(wl_client* client, const char* reason) noexcept {
    if (auto lease = applicationLeaseForClient(client)) {
        cancelKeyboardClient(client);
        lease->paused = true;
        std::snprintf(lease->failure.data(), lease->failure.size(), "%s", reason);
    }
}

static void retainApplicationWindow(SApplicationLease& lease, PHLWINDOW window, bool createdWhileLeased = false) {
    std::erase_if(lease.windows, [](const auto& entry) { return !entry.second.window.lock(); });
    if (lease.windows.contains(window->metadata().stableID())) return;
    if (lease.windows.size() >= 64) throw std::runtime_error("application window bound reached");
    using namespace Desktop::Types;
    auto saved = [](const COverridableVar<bool>& property) -> std::optional<bool> {
        return property.hasValue() && property.getPriority() == PRIORITY_SET_PROP ? std::optional<bool>{property.value()} : std::nullopt;
    };
    lease.windows.emplace(window->metadata().stableID(), SLeasedWindow{window,
        saved(window->m_ruleApplicator->renderUnfocused()), saved(window->m_ruleApplicator->focusOnActivate()),
        std::ranges::find(g_pHyprRenderer->m_renderUnfocused, window) != g_pHyprRenderer->m_renderUnfocused.end(),
        createdWhileLeased, window->m_ruleApplicator->static_.noInitialFocus, window->m_ruleApplicator->static_.workspace,
        window->m_ruleApplicator->static_.floating, window->m_ruleApplicator->static_.center, window->m_ruleApplicator->static_.size});
}
static void applyApplicationWindow(PHLWINDOW window) {
    using namespace Desktop::Types;
    window->m_ruleApplicator->renderUnfocused().set(true, PRIORITY_SET_PROP);
    g_pHyprRenderer->addWindowToRenderUnfocused(window);
    window->m_ruleApplicator->focusOnActivate().set(false, PRIORITY_SET_PROP);
}

// Avoid the upstream lookup, whose predicate dereferences empty device entries.
template <typename Protocol>
static bool clientHasDataControlDevice(const Protocol& protocol, wl_client* client) {
    if (!client) throw std::runtime_error("application client is unavailable");
    if (!protocol) return false;
    bool found = false;
    for (const auto& device : protocol->m_devices) {
        if (!device) throw std::runtime_error("data-control device inventory contains an unavailable device");
        auto owner = device->client();
        if (!owner) throw std::runtime_error("data-control device client is unavailable");
        found = found || owner == client;
    }
    return found;
}

// A launch token is passed through the original executable's normal startup
// environment. Observing its activation request binds a forwarded window to
// this request, rather than guessing from a shared service PID.
struct SOpeningTicket {
    std::chrono::steady_clock::time_point expires;
    WP<CWLSurfaceResource> surface;
    bool observed = false;
    bool ambiguous = false;
};
static std::map<std::string, SOpeningTicket> openingTickets;
static void pruneOpeningTickets() {
    const auto now = std::chrono::steady_clock::now();
    std::erase_if(openingTickets, [now](const auto& item) { return item.second.expires <= now; });
}
static void openingProtocolRequest(wl_protocol_logger_type direction, const wl_protocol_logger_message* message) noexcept {
    if (direction != WL_PROTOCOL_LOGGER_REQUEST || !message || !message->resource || !message->message ||
        !message->arguments || message->arguments_count != 2 ||
        std::strcmp(wl_resource_get_class(message->resource), "xdg_activation_v1") ||
        std::strcmp(message->message->name, "activate")) return;
    try {
        const char* token = message->arguments[0].s;
        if (!token || std::strlen(token) != 32 || !message->arguments[1].o) return;
        const auto found = openingTickets.find(token);
        if (found == openingTickets.end() || found->second.expires <= std::chrono::steady_clock::now()) return;
        auto surface = CWLSurfaceResource::fromResource(reinterpret_cast<wl_resource*>(message->arguments[1].o));
        if (!surface || surface->client() != wl_resource_get_client(message->resource)) return;
        auto& ticket = found->second;
        if (ticket.observed && ticket.surface.lock() != surface) ticket.ambiguous = true;
        else { ticket.surface = surface; ticket.observed = true; }
    } catch (...) {
        // Diagnostic observation must never unwind through Wayland dispatch.
    }
}
static std::string openingRequest(const std::string& operation, const std::string& token) {
    if (!std::regex_match(token, std::regex{"[0-9a-f]{32}"}))
        throw std::runtime_error("invalid opening token");
    pruneOpeningTickets();
    if (operation == "forget") { openingTickets.erase(token); return "ok"; }
    if (operation == "register") {
        if (admissionPaused || openingTickets.size() >= 64 || openingTickets.contains(token))
            throw std::runtime_error("opening ticket is unavailable");
        openingTickets.emplace(token, SOpeningTicket{std::chrono::steady_clock::now() + std::chrono::seconds{90}});
        return "ok";
    }
    if (operation != "info") throw std::runtime_error("unknown opening operation");
    const auto found = openingTickets.find(token);
    std::string windows = "[";
    bool first = true;
    const bool ambiguous = found != openingTickets.end() && found->second.ambiguous;
    if (found != openingTickets.end() && !ambiguous) {
        const auto observed = found->second.surface.lock();
        if (observed) for (const auto& window : Desktop::windowState()->windows()) {
            if (!window->mapped() || window->resource() != observed) continue;
            if (!first) windows += ',';
            first = false;
            windows += std::format("{{\"address\":\"0x{:x}\",\"stableId\":\"{:x}\"}}",
                reinterpret_cast<uintptr_t>(window.get()), window->metadata().stableID());
        }
    }
    windows += ']';
    return std::format("{{\"schema\":1,\"token\":\"{}\",\"ambiguous\":{},\"windows\":{}}}", token, ambiguous, windows);
}

static size_t liveRootCount() {
    std::map<pid_t, bool> roots;
    for (const auto& [pid, identity] : scopedProcesses)
        if (identity->live())
            roots[pid] = true;
    for (const auto& [pid, descriptor] : registeredProcesses)
        if (ScopedProcess::descriptorLive(descriptor))
            roots[pid] = true;
    pruneOpeningTickets();
    return roots.size() + openingTickets.size();
}

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
    throw std::runtime_error("Private session launch rules were removed");
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
    return applicationLeaseForClient(client) != nullptr;
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
    if constexpr (requires { guard.originalStartDrag; }) guard.originalStartDrag = raw->requests.startDrag;
    guard.destroy.notify = destroy;
    wl_resource_add_destroy_listener(resource, &guard.destroy);
    configure(raw, original);
}

template <typename Guards>
static void restoreSelectionGuards(Guards& guards) {
    for (auto& [resource, guard] : guards) {
        guard.device->requests.setSelection = std::move(guard.original);
        if constexpr (requires { guard.originalStartDrag; }) guard.device->requests.startDrag = std::move(guard.originalStartDrag);
        wl_list_remove(&guard.destroy.link);
    }
    guards.clear();
}

// Background input uses the owner's ordinary shared selections. The lease
// supplies action authority without changing the physical seat focus.
static void guardPrimarySelection(wl_client* client) {
    if (!client || !PROTO::primarySelection) throw std::runtime_error("primary selection protocol is unavailable");
    clientHasDataControlDevice(PROTO::primarySelection, client);
    for (const auto& device : PROTO::primarySelection->m_devices) {
        if (device->client() != client) continue;
        installSelectionGuard(device->m_resource.get(), primaryGuards, [](wl_listener* listener, void* data) {
            wl_list_remove(&listener->link);
            primaryGuards.erase(static_cast<wl_resource*>(data));
        }, [](auto* raw, auto original) {
            raw->setSetSelection([original](CZwpPrimarySelectionDeviceV1* current, wl_resource* source, uint32_t serial) {
                const auto lease = applicationLeaseForClient(current->client());
                if (!lease || lease->paused) { original(current, source, serial); return; }
                g_pSeatManager->setCurrentPrimarySelection(source ? CPrimarySelectionSource::fromResource(source) : SP<CPrimarySelectionSource>{});
            });
        });
    }
}

static void guardClipboard(wl_client* client) {
    if (!client || !PROTO::data) throw std::runtime_error("clipboard protocol is unavailable");
    clientHasDataControlDevice(PROTO::data, client);
    for (const auto& device : PROTO::data->m_devices) {
        if (device->client() != client) continue;
        installSelectionGuard(device->m_resource.get(), clipboardGuards, [](wl_listener* listener, void* data) {
            wl_list_remove(&listener->link);
            clipboardGuards.erase(static_cast<wl_resource*>(data));
        }, [](auto* raw, auto original) {
            raw->setSetSelection([original](CWlDataDevice* current, wl_resource* sourceResource, uint32_t serial) {
                const auto lease = applicationLeaseForClient(current->client());
                if (!lease || lease->paused) { original(current, sourceResource, serial); return; }
                auto source = sourceResource ? CWLDataSourceResource::fromResource(sourceResource) : SP<CWLDataSourceResource>{};
                if (source) source->markUsed();
                g_pSeatManager->setCurrentSelection(source);
            });
        });
    }
}

static void sendSharedSelection(wl_client* client, bool primary) {
    if (primary) {
        clientHasDataControlDevice(PROTO::primarySelection, client);
        for (const auto& device : PROTO::primarySelection->m_devices)
            if (device->client() == client) PROTO::primarySelection->sendSelectionToDevice(device, g_pSeatManager->m_selection.currentPrimarySelection.lock());
    } else {
        clientHasDataControlDevice(PROTO::data, client);
        for (const auto& device : PROTO::data->m_devices)
            if (device->client() == client) PROTO::data->sendSelectionToDevice(device, g_pSeatManager->m_selection.currentSelection.lock());
    }
}

static void broadcastSharedSelection(bool primary) {
    for (const auto& [id, lease] : applicationLeases) {
        if (lease->paused) continue;
        try { sendSharedSelection(lease->client, primary); }
        catch (const std::exception& error) { recordApplicationFailure(lease->client, error.what()); }
        catch (...) { recordApplicationFailure(lease->client, "shared selection delivery failed"); }
    }
}

static void selectionRequest(void*, wl_protocol_logger_type direction, const wl_protocol_logger_message* message) {
    openingProtocolRequest(direction, message);
    keyboardProtocolTransition(direction, message);
    if (!message || !message->resource || !message->message || direction != WL_PROTOCOL_LOGGER_REQUEST ||
        std::strcmp(message->message->name, "set_selection") != 0) return;
    auto client = wl_resource_get_client(message->resource);
    if (!agentClient(client)) return;
    try {
        const auto interface = wl_resource_get_class(message->resource);
        if (std::strcmp(interface, "zwp_primary_selection_device_v1") == 0) guardPrimarySelection(client);
        else if (std::strcmp(interface, "wl_data_device") == 0) guardClipboard(client);
    } catch (const std::exception& error) { recordApplicationFailure(client, error.what()); }
    catch (...) { recordApplicationFailure(client, "shared selection admission failed"); }
}

static bool leasedWindow(PHLWINDOW window) {
    auto surface = window ? window->resource() : SP<CWLSurfaceResource>{};
    auto lease = surface ? applicationLeaseForClient(surface->client()) : nullptr;
    if (!lease)
        return false;
    const auto retained = lease->windows.find(window->metadata().stableID());
    return retained != lease->windows.end() && retained->second.window.lock() == window;
}

template <typename Guards>
static void restoreClientSelectionGuards(Guards& guards, wl_client* client) {
    for (auto entry = guards.begin(); entry != guards.end();) {
        if (entry->second.device->client() != client) { ++entry; continue; }
        entry->second.device->requests.setSelection = std::move(entry->second.original);
        if constexpr (requires { entry->second.originalStartDrag; })
            entry->second.device->requests.startDrag = std::move(entry->second.originalStartDrag);
        wl_list_remove(&entry->second.destroy.link);
        entry = guards.erase(entry);
    }
}

static void restoreApplicationGeometry(Desktop::Rule::CWindowRuleApplicator* rules, const SLeasedWindow& retained) {
    if (!retained.createdWhileLeased) return;
    rules->static_.floating = retained.originalFloating;
    rules->static_.center = retained.originalCenter;
    rules->static_.size = retained.originalSize;
}

static void restoreRelatedWindows(SApplicationLease& lease, wl_client* selectedClient = nullptr,
                                  const SApplicationLease* selection = nullptr) {
    for (auto it = lease.relatedWindows.begin(); it != lease.relatedWindows.end();) {
        auto window = it->second.window.lock();
        auto resource = window ? window->resource() : SP<CWLSurfaceResource>{};
        if (selectedClient && resource && resource->client() != selectedClient) { ++it; continue; }
        if (selection && window && !applicationWindowAllowed(*selection, window)) { ++it; continue; }
        if (window && window->metadata().stableID() == it->first) {
            auto rules = window->m_ruleApplicator.get();
            rules->static_.noInitialFocus = it->second.noInitialFocus;
            rules->static_.workspace = it->second.originalWorkspace;
            restoreApplicationGeometry(rules, it->second);
        }
        it = lease.relatedWindows.erase(it);
    }
}

static uint32_t nowMs();
// The seat keeps its own focus while an agent drives the same client, so ending
// agent input must give the client back exactly what the seat last told it.
static void returnClientPointer(const SP<CWLPointerResource>& pointer, wl_client* client) {
    // A button the agent holds is always released before the client gets its pointer back.
    if (const auto held = pointerHolds.find(pointer.get()); held != pointerHolds.end()) {
        for (const uint32_t button : held->second.buttons) {
            pointer->sendButton(nowMs(), button, WL_POINTER_BUTTON_STATE_RELEASED);
            pointer->sendFrame();
        }
        pointerHolds.erase(held);
    }
    const auto focus = g_pSeatManager->m_state.pointerFocus.lock();
    if (focus && focus->client() == client) {
        // sendEnter is a no-op on the surface the pointer already occupies, so put
        // the client's pointer back on the owner's position with a motion instead.
        if (pointer->m_currentSurface.lock() == focus) pointer->sendMotion(nowMs(), g_pSeatManager->m_lastLocalCoords);
        else { pointer->sendLeave(); pointer->sendEnter(focus, g_pSeatManager->m_lastLocalCoords); }
    } else pointer->sendLeave();
    pointer->sendFrame();
}
static void returnClientKeyboard(const SP<CWLKeyboardResource>& keyboard, wl_client* client) {
    const auto focus = g_pSeatManager->m_state.keyboardFocus.lock();
    const bool owned = focus && focus->client() == client;
    if (!owned) keyboard->sendLeave();
    keyboard->sendKeymap(g_pSeatManager->m_keyboard.lock());
    if (owned && keyboard->m_currentSurface.lock() != focus) {
        wl_array keys;
        wl_array_init(&keys);
        keyboard->sendEnter(focus, &keys);
        wl_array_release(&keys);
    }
}

static void handbackApplication(const std::string& id) {
    if (!g_pSeatManager || !PROTO::data || !PROTO::primarySelection)
        throw std::runtime_error("application handback protocols are unavailable; lease retained");
    const auto found = applicationLeases.find(id);
    if (found == applicationLeases.end())
        throw std::runtime_error("application lease is unavailable");
    auto& lease = *found->second;
    cancelKeyboardClient(lease.client);
    lease.paused = true;
    restoreRelatedWindows(lease);
    auto seat = g_pSeatManager->seatResourceForClient(lease.client);
    if (seat) {
        for (const auto& weak : seat->m_pointers)
            if (auto pointer = weak.lock(); pointer && scrollPointers.contains(pointer.get())) {
                returnClientPointer(pointer, lease.client); scrollPointers.erase(pointer.get());
            }
        for (const auto& weak : seat->m_keyboards)
            if (auto keyboard = weak.lock(); keyboard && agentKeyboards.contains(keyboard.get())) {
                returnClientKeyboard(keyboard, lease.client);
                agentKeyboards.erase(keyboard.get());
            }
    }
    restoreClientSelectionGuards(primaryGuards, lease.client);
    restoreClientSelectionGuards(clipboardGuards, lease.client);
    for (auto cursor = cursors.begin(); cursor != cursors.end();) {
        const auto& target = cursor->first;
        const auto marker = target.rfind("@lease-");
        if (marker != std::string::npos && std::string_view{target}.substr(marker + 7) == id) {
            if (auto window = cursor->second.window.lock())
                g_pHyprRenderer->damageMonitor(window->m_monitor.lock());
            cursor = cursors.erase(cursor);
        } else ++cursor;
    }
    for (auto& [stable, retained] : lease.windows) {
        auto window = retained.window.lock();
        if (!window || window->metadata().stableID() != stable) continue;
        using namespace Desktop::Types;
        window->m_ruleApplicator->renderUnfocused().matchOptional(retained.renderUnfocused, PRIORITY_SET_PROP);
        // Upstream only prunes false properties when another entry expires.
        // Restore exact membership so handback cannot leave a background timer running.
        if (!retained.backgroundRenderingRegistered)
            std::erase_if(g_pHyprRenderer->m_renderUnfocused, [&](const auto& entry) { return entry.lock() == window; });
        window->m_ruleApplicator->focusOnActivate().matchOptional(retained.focusOnActivate, PRIORITY_SET_PROP);
        window->m_ruleApplicator->static_.noInitialFocus = retained.noInitialFocus;
        window->m_ruleApplicator->static_.workspace = std::move(retained.originalWorkspace);
        restoreApplicationGeometry(window->m_ruleApplicator.get(), retained);
    }
    for (auto awake = awakeWindows.begin(); awake != awakeWindows.end();) {
        const auto marker = awake->first.rfind("@lease-");
        if (marker == std::string::npos || std::string_view{awake->first}.substr(marker + 7) != id) { ++awake; continue; }
        if (auto window = awake->second.lock(); window && window->mapped() && !g_pHyprRenderer->shouldRenderWindow(window))
            window->setSuspended(true);
        awake = awakeWindows.erase(awake);
    }
    wl_list_remove(&lease.destroy.link);
    retireKeyboardLease(id);
    applicationLeases.erase(found);
}

// A lease whose claiming worker is gone is handed back, so a killed worker cannot leave an
// application unusable. Leases that never named an owner are left alone.
static void reapDeadOwnerLeases() {
    std::vector<std::string> dead;
    for (const auto& [id, lease] : applicationLeases)
        if (lease->owner.pid > 0 && !lease_owner::alive(lease->owner)) dead.push_back(id);
    for (const auto& id : dead) {
        try { handbackApplication(id); }
        catch (const std::exception& error) {
            if (const auto held = applicationLeases.find(id); held != applicationLeases.end())
                recordApplicationFailure(held->second->client, error.what());
        }
    }
}

static void clearApplicationCursors(std::string_view id) {
    for (auto cursor = cursors.begin(); cursor != cursors.end();) {
        const auto& target = cursor->first;
        const auto marker = target.rfind("@lease-");
        if (marker == std::string::npos || std::string_view{target}.substr(marker + 7) != id) { ++cursor; continue; }
        if (auto window = cursor->second.window.lock())
            g_pHyprRenderer->damageMonitor(window->m_monitor.lock());
        cursor = cursors.erase(cursor);
    }
    for (auto awake = awakeWindows.begin(); awake != awakeWindows.end();) {
        const auto marker = awake->first.rfind("@lease-");
        if (marker != std::string::npos && std::string_view{awake->first}.substr(marker + 7) == id)
            awake = awakeWindows.erase(awake);
        else ++awake;
    }
}
static std::string applicationJsonString(std::string_view value) {
    std::string escaped{"\""};
    for (unsigned char character : value) {
        if (character == '"' || character == '\\') { escaped += '\\'; escaped += character; }
        else if (character < 32) escaped += std::format("\\u{:04x}", character);
        else escaped += character;
    }
    return escaped + '"';
}
static std::string applicationInfo(const std::string& id) {
    if (!std::regex_match(id, std::regex{"[0-9a-f]{32}"}))
        throw std::runtime_error("invalid application lease identity");
    const auto found = applicationLeases.find(id);
    if (found == applicationLeases.end())
        return std::format("{{\"schema\":1,\"status\":\"unavailable\",\"lease_id\":\"{}\",\"scope\":\"entire-wayland-client\",\"windows\":[],\"failure\":\"\",\"claim_failure\":\"\"}}", id);
    const auto& lease = *found->second;
    std::string windows{"["};
    bool first = true;
    for (const auto& [stable, retained] : lease.windows) {
        auto window = retained.window.lock();
        auto surface = window ? window->resource() : SP<CWLSurfaceResource>{};
        if (!window || !window->mapped() || window->metadata().stableID() != stable || !surface || surface->client() != lease.client) continue;
        if (!first) windows += ',';
        first = false;
        windows += std::format("{{\"address\":\"0x{:x}\",\"stable\":\"{:x}\",\"target\":\"0x{:x}@{:x}@lease-{}\"}}",
            reinterpret_cast<uintptr_t>(window.get()), stable, reinterpret_cast<uintptr_t>(window.get()), stable, id);
    }
    windows += ']';
    size_t excludedWindows = 0;
    for (const auto& window : Desktop::windowState()->windows()) {
        auto resource = window ? window->resource() : SP<CWLSurfaceResource>{};
        if (window && window->mapped() && resource && resource->client() == lease.client &&
            !lease.windows.contains(window->metadata().stableID())) ++excludedWindows;
    }
    return std::format("{{\"schema\":1,\"status\":\"{}\",\"ownerInput\":{},\"lease_id\":\"{}\",\"scope\":\"entire-wayland-client\",\"windowEnrollment\":\"{}\",\"excludedWindows\":{},\"windows\":{},\"failure\":{},\"claim_failure\":{}}}",
        lease.paused ? "paused" : "active", ownerInputActive(lease) ? "true" : "false", id, lease.windowBound ? "selected-dialog-family" : "client-windows", excludedWindows,
        windows, applicationJsonString(lease.failure.data()), applicationJsonString(lease.claimFailure.data()));
}
static std::string claimApplication(const std::string& address, const std::string& stable, const std::string& id, const std::string& ownerToken = "") {
    if (admissionPaused)
        throw std::runtime_error("native admission is paused");
    if (!std::regex_match(address, std::regex{"0x[0-9a-f]{1,16}"}) ||
        !std::regex_match(stable, std::regex{"[0-9a-f]{1,16}"}))
        throw std::runtime_error("existing application needs an exact window identity");
    PHLWINDOW selected;
    for (const auto& window : Desktop::windowState()->windows())
        if (std::format("0x{:x}", reinterpret_cast<uintptr_t>(window.get())) == address &&
            std::format("{:x}", window->metadata().stableID()) == stable)
            selected = window;
    auto surface = selected ? selected->resource() : SP<CWLSurfaceResource>{};
    if (!selected || !selected->mapped() || !selected->m_workspace || !surface || selected->backend().isX11())
        throw std::runtime_error("existing application target is unavailable or unsupported");
    auto client = surface->client();
    if (!client || !g_pSeatManager || !PROTO::data || !PROTO::primarySelection)
        throw std::runtime_error("application handoff requires a live client and selection protocols");
    // Seat focus and hover never block a claim: agent input is client-local and
    // never moves the seat. Physical input to the client pauses the lease instead.
    clientHasDataControlDevice(PROTO::data, client);
    clientHasDataControlDevice(PROTO::primarySelection, client);
    if (g_pSeatManager->m_seatGrab || PROTO::data->dndActive())
        throw std::runtime_error("handoff is unsupported during a grab or drag");
    if (auto holder = applicationLeaseForClient(client)) {
        // The refusal names the holder so a caller can tell a live task from an orphan.
        const bool known = holder->owner.pid > 0;
        throw std::runtime_error(std::format("application lease already exists or lease bound reached lease={} owner_pid={} owner_alive={}",
            holder->id, holder->owner.pid, known ? (lease_owner::alive(holder->owner) ? "yes" : "no") : "unknown"));
    }
    if (applicationLeases.size() >= 16 || retiredApplicationLeases.size() >= 1024)
        throw std::runtime_error("application lease already exists or lease bound reached");
    auto retained = std::make_unique<SApplicationLease>();
    retained->client = client;
    retained->id = id;
    if (!ownerToken.empty() && !lease_owner::parse(ownerToken, retained->owner))
        throw std::runtime_error("invalid lease owner token");
    const auto parent = selected->backend().parent();
    const auto parentResource = parent ? parent->resource() : SP<CWLSurfaceResource>{};
    retained->windowBound = parentResource && parentResource->client() != client;
    retained->windowRoot = selected;
    for (const auto& window : Desktop::windowState()->windows())
        retained->baselineWindows.insert(window->metadata().stableID());
    retained->homeWorkspace = selected->m_workspace->addressableName();
    retained->homeWorkspaceRule = retained->homeWorkspace + " silent";
    const auto selectedSize = selected->size(Desktop::View::IGeometric::GEOMETRIC_GOAL);
    if (selected->isFloating() && std::isfinite(selectedSize.x) && std::isfinite(selectedSize.y) &&
        selectedSize.x >= 320 && selectedSize.x <= 3840 && selectedSize.y >= 240 && selectedSize.y <= 2160)
        retained->newWindowSize = Math::SExpressionVec2{std::to_string(std::lround(selectedSize.x)), std::to_string(std::lround(selectedSize.y))};
    for (const auto& window : Desktop::windowState()->windows()) {
        auto resource = window->resource();
        if (window->mapped() && resource && resource->client() == client && applicationWindowAllowed(*retained, window)) {
            if (window->backend().isX11() || !windowXdg(window) || retained->windows.size() >= 64)
                throw std::runtime_error("client includes unsupported targets");
            retainApplicationWindow(*retained, window);
        }
    }
    if (!std::regex_match(id, std::regex{"[0-9a-fA-F]{32}"}) || retiredApplicationLeases.contains(id))
        throw std::runtime_error("cannot mint application lease identity");
    auto success = std::format("{{\"schema\":1,\"status\":\"claimed\",\"lease_id\":\"{}\",\"scope\":\"entire-wayland-client\",\"windowEnrollment\":\"{}\",\"windows\":{}}}",
        id, retained->windowBound ? "selected-dialog-family" : "client-windows", retained->windows.size());
    auto recoverableFailure = std::format("{{\"schema\":1,\"status\":\"recovery_required\",\"lease_id\":\"{}\",\"error\":\"claim_failed_handback_incomplete\"}}", id);
    for (auto& [otherId, other] : applicationLeases)
        restoreRelatedWindows(*other, client, retained.get());
    retiredApplicationLeases.insert(id);
    auto [entry, inserted] = applicationLeases.emplace(id, std::move(retained));
    auto& lease = *entry->second;
    lease.destroy.notify = [](wl_listener* listener, void* destroyed) {
        retireKeyboardClient(static_cast<wl_client*>(destroyed));
        wl_list_remove(&listener->link);
        for (auto entry = applicationLeases.begin(); entry != applicationLeases.end(); ++entry)
            if (entry->second->client == destroyed) {
                restoreRelatedWindows(*entry->second);
                clearApplicationCursors(entry->first); applicationLeases.erase(entry); return;
            }
    };
    wl_client_add_destroy_listener(client, &lease.destroy);
    try {
        for (const auto& [stable, retainedWindow] : lease.windows)
            if (auto window = retainedWindow.window.lock()) applyApplicationWindow(window);
        guardPrimarySelection(client); guardClipboard(client);
        sendSharedSelection(client, false); sendSharedSelection(client, true);
    } catch (...) {
        try { throw; }
        catch (const std::exception& error) { std::snprintf(lease.claimFailure.data(), lease.claimFailure.size(), "%s", error.what()); }
        catch (...) { std::snprintf(lease.claimFailure.data(), lease.claimFailure.size(), "%s", "claim setup failed"); }
        try { handbackApplication(id); }
        catch (const std::exception& error) { recordApplicationFailure(client, error.what()); return recoverableFailure; }
        catch (...) { recordApplicationFailure(client, "claim rollback failed"); return recoverableFailure; }
        throw;
    }
    return success;
}

static CFunctionHook* keyboardFocusHook = nullptr;
static CFunctionHook* keyboardKeyHook = nullptr;
static CFunctionHook* pointerButtonHook = nullptr;
static CFunctionHook* pointerAxisHook = nullptr;
static CFunctionHook* popupGrabHook = nullptr;
static CFunctionHook* popupMapHook = nullptr;
static CFunctionHook* simulatedMotionHook = nullptr;
static unsigned privatePopupMapDepth = 0;
static CFunctionHook* staticRulesHook = nullptr;
static CFunctionHook* staticRecheckHook = nullptr;
static CFunctionHook* clipboardSelectionHook = nullptr;
static CFunctionHook* primarySelectionHook = nullptr;

#if !defined(__linux__) || !defined(__x86_64__)
#error "Native lifecycle detours require the verified Linux x86_64 ABI"
#endif
// Real key, button and axis delivery is the only owner activity that pauses a
// lease. Agent input writes to the client's own wl_keyboard and wl_pointer
// resources and never calls these seat functions, so every call seen here is
// physical. Focus and hover never end, block or pause a lease.
static void restoreAgentKeyboards(wl_client* client) {
    auto seat = client ? g_pSeatManager->seatResourceForClient(client) : SP<CWLSeatResource>{};
    if (!seat) return;
    for (const auto& weak : seat->m_keyboards)
        if (auto keyboard = weak.lock(); keyboard && agentKeyboards.contains(keyboard.get())) {
            returnClientKeyboard(keyboard, client);
            agentKeyboards.erase(keyboard.get());
        }
}
static void restoreAgentPointers(wl_client* client) {
    auto seat = client ? g_pSeatManager->seatResourceForClient(client) : SP<CWLSeatResource>{};
    if (!seat) return;
    for (const auto& weak : seat->m_pointers)
        if (auto pointer = weak.lock(); pointer && scrollPointers.contains(pointer.get())) {
            returnClientPointer(pointer, client);
            scrollPointers.erase(pointer.get());
        }
}
static void noteOwnerInput(wl_client* client, bool keyboard) {
    auto lease = client ? applicationLeaseForClient(client) : nullptr;
    if (!lease) return;
    const bool wasActive = ownerInputActive(*lease);
    lease->ownerInputUntil = std::chrono::steady_clock::now() + ownerIdleResume;
    cancelKeyboardClient(client);
    if (keyboard) {
        restoreAgentKeyboards(client);
        // Owner typing ends an agent drag too: release held buttons, keep hover.
        auto seat = g_pSeatManager->seatResourceForClient(client);
        if (seat)
            for (const auto& weak : seat->m_pointers)
                if (auto pointer = weak.lock())
                    if (auto hold = pointerHolds.find(pointer.get()); hold != pointerHolds.end() && !hold->second.buttons.empty())
                        returnClientPointer(pointer, client), scrollPointers.erase(pointer.get());
    } else restoreAgentPointers(client);
    if (wasActive) return;
    for (const auto& [stable, retained] : lease->windows)
        if (auto window = retained.window.lock())
            if (auto monitor = window->m_monitor.lock()) g_pHyprRenderer->damageMonitor(monitor);
}
static wl_client* seatFocusClient(const WP<CWLSeatResource>& resource) {
    auto locked = resource.lock();
    return locked ? locked->client() : nullptr;
}
// These detours bridge the pinned x86_64 nontrivial-argument ABI. The caller owns
// the supplied shared-pointer objects and can cache their control blocks for
// destruction. Borrow their storage without moving or destroying them here.
// Forwarding through new owning temporaries would release the same ownership
// again when the optimized original caller performs its cached cleanup.
static void beforeKeyboardFocus(CSeatManager* manager, SP<CWLSurfaceResource>& surface) {
    // The seat sends no keymap on enter, so retire the agent keymap first.
    if (surface) restoreAgentKeyboards(surface->client());
    using Original = void (*)(CSeatManager*, SP<CWLSurfaceResource>&);
    reinterpret_cast<Original>(keyboardFocusHook->m_original)(manager, surface);
}
static void ownerKeyboardKey(CSeatManager* manager, uint32_t timeMs, uint32_t key, wl_keyboard_key_state state) {
    noteOwnerInput(seatFocusClient(manager->m_state.keyboardFocusResource), true);
    using Original = void (*)(CSeatManager*, uint32_t, uint32_t, wl_keyboard_key_state);
    reinterpret_cast<Original>(keyboardKeyHook->m_original)(manager, timeMs, key, state);
}
static void ownerPointerButton(CSeatManager* manager, uint32_t timeMs, uint32_t key, wl_pointer_button_state state) {
    noteOwnerInput(seatFocusClient(manager->m_state.pointerFocusResource), false);
    using Original = void (*)(CSeatManager*, uint32_t, uint32_t, wl_pointer_button_state);
    reinterpret_cast<Original>(pointerButtonHook->m_original)(manager, timeMs, key, state);
}
static void ownerPointerAxis(CSeatManager* manager, uint32_t timeMs, wl_pointer_axis axis, double value, int32_t discrete,
                             int32_t value120, wl_pointer_axis_source source, wl_pointer_axis_relative_direction relative) {
    noteOwnerInput(seatFocusClient(manager->m_state.pointerFocusResource), false);
    using Original = void (*)(CSeatManager*, uint32_t, wl_pointer_axis, double, int32_t, int32_t, wl_pointer_axis_source,
                              wl_pointer_axis_relative_direction);
    reinterpret_cast<Original>(pointerAxisHook->m_original)(manager, timeMs, axis, value, discrete, value120, source, relative);
}
static void privatePopupGrab(CXDGShellProtocol* protocol, SP<CXDGPopupResource>& popup) {
    auto xdg = popup ? popup->m_surface.lock() : SP<CXDGSurfaceResource>{};
    auto surface = xdg ? xdg->m_surface.lock() : SP<CWLSurfaceResource>{};
    if (surface && applicationLeaseForClient(surface->client()))
        return; // Client-local actor input never acquires the person's shared grab.
    using Original = void (*)(CXDGShellProtocol*, SP<CXDGPopupResource>&);
    reinterpret_cast<Original>(popupGrabHook->m_original)(protocol, popup);
}

static void privatePopupMap(Desktop::View::CPopup* popup) {
    auto owner = popup->getT1Owner();
    auto surface = owner ? owner->resource() : SP<CWLSurfaceResource>{};
    const bool isolated = surface && applicationLeaseForClient(surface->client());
    // The compositor maps popup geometry normally. Only its synchronous shared
    // pointer refocus is suppressed for the leased client, never physical input.
    struct Scope {
        bool active;
        explicit Scope(bool value) : active(value) { if (active) ++privatePopupMapDepth; }
        ~Scope() { if (active) --privatePopupMapDepth; }
    } scope{isolated};
    using Original = void (*)(Desktop::View::CPopup*);
    reinterpret_cast<Original>(popupMapHook->m_original)(popup);
}

class CInputManager;
static void privateSimulatedMotion(CInputManager* manager) {
    if (privatePopupMapDepth) return;
    using Original = void (*)(CInputManager*);
    reinterpret_cast<Original>(simulatedMotionHook->m_original)(manager);
}

static void applyNewApplicationGeometry(Desktop::Rule::CWindowRuleApplicator* rules, const SApplicationLease& lease) {
    if (!lease.newWindowSize) return;
    rules->static_.floating = true;
    rules->static_.center = true;
    rules->static_.size = lease.newWindowSize;
}

static SApplicationLease* relatedApplicationLease(PHLWINDOW window) {
    std::set<uint64_t> visited;
    auto parent = window ? window->backend().parent() : PHLWINDOW{};
    for (int depth = 0; parent && depth < 16; ++depth, parent = parent->backend().parent()) {
        if (!visited.insert(parent->metadata().stableID()).second) return nullptr;
        auto surface = parent->resource();
        auto lease = surface ? applicationLeaseForClient(surface->client()) : nullptr;
        if (lease && !lease->paused && parent->mapped() && parent->m_workspace &&
            parent->m_workspace->addressableName() == lease->homeWorkspace && lease->windows.contains(parent->metadata().stableID()) &&
            !lease->baselineWindows.contains(window->metadata().stableID())) return lease;
    }
    return nullptr;
}

static void routeRelatedApplicationWindow(Desktop::Rule::CWindowRuleApplicator* rules, PHLWINDOW window) {
    auto lease = relatedApplicationLease(window);
    if (!lease) return;
    std::erase_if(lease->relatedWindows, [](const auto& entry) { return !entry.second.window.lock(); });
    if (!lease->relatedWindows.contains(window->metadata().stableID())) {
        if (lease->relatedWindows.size() >= 64) return;
        SLeasedWindow saved;
        saved.window = window; saved.createdWhileLeased = true;
        saved.noInitialFocus = rules->static_.noInitialFocus;
        saved.originalWorkspace = rules->static_.workspace;
        saved.originalFloating = rules->static_.floating; saved.originalCenter = rules->static_.center;
        saved.originalSize = rules->static_.size;
        lease->relatedWindows.emplace(window->metadata().stableID(), std::move(saved));
    }
    rules->static_.workspace = lease->homeWorkspaceRule;
    rules->static_.noInitialFocus = true;
    applyNewApplicationGeometry(rules, *lease);
}

static void enforceApplicationRules(Desktop::Rule::CWindowRuleApplicator* rules) {
    auto window = rules->m_window.lock();
    auto surface = window ? window->resource() : SP<CWLSurfaceResource>{};
    auto lease = surface ? applicationLeaseForClient(surface->client()) : nullptr;
    if (!lease || !applicationWindowAllowed(*lease, window)) { routeRelatedApplicationWindow(rules, window); return; }
    const auto existing = lease->windows.find(window->metadata().stableID());
    const bool newlyObserved = existing == lease->windows.end();
    const bool clampWorkspace = newlyObserved || existing->second.createdWhileLeased;
    const auto originalFloating = rules->static_.floating, originalCenter = rules->static_.center;
    const auto originalSize = rules->static_.size;
    std::string originalWorkspace;
    if (newlyObserved) originalWorkspace = std::move(rules->static_.workspace);
    try {
        // Place new same-client windows before bounded enrollment can refuse them.
        // Existing windows keep their original workspace throughout the lease.
        if (clampWorkspace) {
            rules->static_.workspace = lease->homeWorkspaceRule;
            applyNewApplicationGeometry(rules, *lease);
        }
        retainApplicationWindow(*lease, window, true);
        if (newlyObserved) {
            auto& saved = lease->windows.at(window->metadata().stableID());
            saved.originalWorkspace = std::move(originalWorkspace);
            saved.originalFloating = originalFloating; saved.originalCenter = originalCenter; saved.originalSize = originalSize;
        }
        applyApplicationWindow(window);
    } catch (const std::exception& error) { recordApplicationFailure(surface->client(), error.what()); }
    catch (...) { recordApplicationFailure(surface->client(), "new application window enrollment failed"); }
    rules->static_.noInitialFocus = true;
}
static bool privateStaticRules(Desktop::Rule::CWindowRuleApplicator* rules, bool preRead) {
    using Original = bool (*)(Desktop::Rule::CWindowRuleApplicator*, bool);
    const auto result = reinterpret_cast<Original>(staticRulesHook->m_original)(rules, preRead);
    enforceApplicationRules(rules);
    return result;
}
static void privateStaticRecheck(Desktop::Rule::CWindowRuleApplicator* rules) {
    using Original = void (*)(Desktop::Rule::CWindowRuleApplicator*);
    reinterpret_cast<Original>(staticRecheckHook->m_original)(rules);
    enforceApplicationRules(rules);
}
static void sharedClipboardSelection(CSeatManager* manager, SP<IDataSource>& source) {
    using Original = void (*)(CSeatManager*, SP<IDataSource>&);
    reinterpret_cast<Original>(clipboardSelectionHook->m_original)(manager, source);
    broadcastSharedSelection(false);
}
static void sharedPrimarySelection(CSeatManager* manager, SP<IDataSource>& source) {
    using Original = void (*)(CSeatManager*, SP<IDataSource>&);
    reinterpret_cast<Original>(primarySelectionHook->m_original)(manager, source);
    broadcastSharedSelection(true);
}
// Hyprland 0.57 computes main-surface UVs with the XDG client geometry itself, so the
// 0.56 correction hook was removed: keeping it cropped leased windows a second time.
static CFunctionHook* applicationHook(const std::string& qualified, void* replacement) {
    const auto matches = HyprlandAPI::findFunctionsByName(PHANDLE, qualified.substr(qualified.rfind("::") + 2));
    void* address = nullptr;
    for (const auto& match : matches) {
        if (!match.demangled.starts_with(qualified + "(")) continue;
        if (address) throw std::runtime_error("ambiguous application lifecycle ABI: " + qualified);
        address = match.address;
    }
    if (!address) throw std::runtime_error("missing application lifecycle ABI: " + qualified);
    auto hook = HyprlandAPI::createFunctionHook(PHANDLE, address, replacement);
    if (!hook || !hook->hook()) throw std::runtime_error("cannot install application lifecycle hook: " + qualified);
    return hook;
}
static void installApplicationHooks() {
    keyboardFocusHook = applicationHook("CSeatManager::setKeyboardFocus", reinterpret_cast<void*>(beforeKeyboardFocus));
    keyboardKeyHook = applicationHook("CSeatManager::sendKeyboardKey", reinterpret_cast<void*>(ownerKeyboardKey));
    pointerButtonHook = applicationHook("CSeatManager::sendPointerButton", reinterpret_cast<void*>(ownerPointerButton));
    pointerAxisHook = applicationHook("CSeatManager::sendPointerAxis", reinterpret_cast<void*>(ownerPointerAxis));
    popupGrabHook = applicationHook("CXDGShellProtocol::addOrStartGrab", reinterpret_cast<void*>(privatePopupGrab));
    popupMapHook = applicationHook("Desktop::View::CPopup::onMap", reinterpret_cast<void*>(privatePopupMap));
    simulatedMotionHook = applicationHook("CInputManager::simulateMouseMovement", reinterpret_cast<void*>(privateSimulatedMotion));
    staticRulesHook = applicationHook("Desktop::Rule::CWindowRuleApplicator::readStaticRules", reinterpret_cast<void*>(privateStaticRules));
    staticRecheckHook = applicationHook("Desktop::Rule::CWindowRuleApplicator::recheckStaticRules", reinterpret_cast<void*>(privateStaticRecheck));
    clipboardSelectionHook = applicationHook("CSeatManager::setCurrentSelection", reinterpret_cast<void*>(sharedClipboardSelection));
    primarySelectionHook = applicationHook("CSeatManager::setCurrentPrimarySelection", reinterpret_cast<void*>(sharedPrimarySelection));
}
static void removeApplicationHooks() {
    for (auto slot : {&keyboardFocusHook, &keyboardKeyHook, &pointerButtonHook, &pointerAxisHook, &popupGrabHook, &popupMapHook, &simulatedMotionHook,
                      &staticRulesHook, &staticRecheckHook, &clipboardSelectionHook, &primarySelectionHook}) {
        if (!*slot) continue;
        if (!HyprlandAPI::removeFunctionHook(PHANDLE, *slot))
            throw std::runtime_error("cannot remove application lifecycle hook");
        *slot = nullptr;
    }
}
// Only pre-mutation readiness failures may be retried without inspecting a changed display.
struct PresentationNotReady : std::runtime_error { using std::runtime_error::runtime_error; };

// Render-only geometry has no Wayland surface or input region.
static void presentWorkspace(PHLWORKSPACE workspace, PHLMONITOR monitor) {
    if (!workspace || !monitor || workspaceNumber(workspace).value_or(0) <= 0)
        throw PresentationNotReady("numbered workspace and connected monitor required");
    if (monitor->m_activeWorkspace == workspace) return;
    const auto focus = Desktop::focusState();
    if (focus->monitor() == monitor || monitor->m_activeSpecialWorkspace)
        throw PresentationNotReady("presentation preserves the owner's active monitor and special workspace");
    const auto source = workspace->m_monitor.lock();
    if (source && source->m_activeWorkspace == workspace)
        throw PresentationNotReady("workspace is already displayed on another monitor");
    const auto ownerWindow = focus->window();
    const auto ownerMonitor = focus->monitor();
    const auto ownerKeyboard = g_pSeatManager->m_state.keyboardFocus.lock();
    const auto ownerPointer = g_pSeatManager->m_state.pointerFocus.lock();
    const auto position = Pointer::mgr()->position();
    State::workspacePlacementController()->moveWorkspaceToMonitor(workspace, monitor, true);
    // Internal presentation avoids input release, focus, simulated motion and
    // workspace-switch dispatchers. Recalculate only the selected output.
    const auto previous = monitor->m_activeWorkspace;
    monitor->changeWorkspace(workspace, true, true, true);
    if (previous) Animation::Workspace::startAnimation(previous, Animation::Workspace::ANIMATION_TYPE_OUT, true, true);
    Animation::Workspace::startAnimation(workspace, Animation::Workspace::ANIMATION_TYPE_IN, true, true);
    g_layoutManager->recalculateMonitor(monitor);
    if (focus->window() != ownerWindow || focus->monitor() != ownerMonitor ||
        g_pSeatManager->m_state.keyboardFocus.lock() != ownerKeyboard ||
        g_pSeatManager->m_state.pointerFocus.lock() != ownerPointer || Pointer::mgr()->position() != position)
        throw std::runtime_error("workspace presented but a compositor callback changed owner focus; inspect before continuing");
}

static std::array<CBox, 4> screenFrame(Vector2D extent, double scale) {
    const double thickness = std::min(120 * scale, std::min(extent.x, extent.y) / 2);
    return {{{0, 0, extent.x, thickness}, {0, extent.y - thickness, extent.x, thickness},
             {0, 0, thickness, extent.y}, {extent.x - thickness, 0, thickness, extent.y}}};
}

static double indicatorOpacity(double seconds) {
    // Match the original panel's 2600ms ease-in-out breathing, .62 to 1.
    const double phase = std::fmod(std::max(0.0, seconds), 2.6) / 1.3;
    const double x = phase <= 1 ? phase : 2 - phase;
    double low = 0, high = 1;
    for (int step = 0; step < 24; ++step) {
        const double t = (low + high) / 2;
        const double sample = 3 * .42 * (1 - t) * (1 - t) * t + 3 * .58 * (1 - t) * t * t + t * t * t;
        if (sample < x) low = t; else high = t;
    }
    const double t = (low + high) / 2;
    return .62 + .38 * (3 * t * t - 2 * t * t * t);
}

static double clickProgress(std::chrono::steady_clock::time_point clicked,
                            std::chrono::steady_clock::time_point now) {
    if (clicked == std::chrono::steady_clock::time_point{}) return -1;
    const double elapsed = std::chrono::duration<double>(now - clicked).count();
    return elapsed >= 0 && elapsed < 0.65 ? elapsed / 0.65 : -1;
}

static void drawCursors(Event::SRenderStageEvent event) {
    if (event.stage != RENDER_LAST_MOMENT || !event.context)
        return;
    auto& ctx = event.context->get();
    auto mon = event.monitor;
    if (!mon)
        return;
    if (indicatorStyleDirty) {
        for (auto& texture : frameTextures) texture.reset();
        for (auto& texture : cursorTextures) texture.reset();
        clickTexture.reset();
        indicatorStyleDirty = false;
    }
    uint64_t latest = 0;
    for (const auto& [address, cursor] : cursors) {
        auto window = cursor.window.lock();
        auto resource = window ? window->resource() : SP<CWLSurfaceResource>{};
        auto lease = resource ? applicationLeaseForClient(resource->client()) : nullptr;
        if (window && window->mapped() && window->m_workspace && leasedWindow(window) &&
            window->m_monitor.lock() == mon && window->m_workspace->isVisibleNotCovered() &&
            (!lease || !lease->paused)) latest = std::max(latest, cursor.sequence);
    }
    bool framed = false;
    for (auto it = cursors.begin(); it != cursors.end();) {
        auto w = it->second.window.lock();
        if (!w || !w->mapped() || !w->m_workspace || !leasedWindow(w)) {
            it = cursors.erase(it);
            continue;
        }
        if (w->m_monitor.lock() != mon || !w->m_workspace->isVisibleNotCovered()) {
            ++it;
            continue;
        }
        auto resource = w->resource();
        auto lease = resource ? applicationLeaseForClient(resource->client()) : nullptr;
        if (lease && lease->paused) { ++it; continue; }
        if (it->second.sequence != latest) { ++it; continue; }
        auto box = w->surfaceLogicalBox();
        if (!box) {
            ++it;
            continue;
        }
        const auto goal = w->size(Desktop::View::IGeometric::GEOMETRIC_GOAL);
        if (goal.x <= 0 || goal.y <= 0) { ++it; continue; }
        const auto animationScale = w->size(Desktop::View::IGeometric::GEOMETRIC_CURRENT) / goal;
        const double motionNow = std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
        const auto shownPoint = cursor_motion::position(it->second.motion, motionNow);
        const Vector2D shown{shownPoint.x, shownPoint.y};
        const Vector2D pos = (w->position(Desktop::View::IGeometric::GEOMETRIC_CURRENT) + shown * animationScale - mon->m_position) * mon->m_scale;
        {
            // Keep frames coming while the drawing travels or drifts, damaging only
            // the previous and the new cursor box (logical coordinates).
            const Vector2D logical = w->position(Desktop::View::IGeometric::GEOMETRIC_CURRENT) + shown * animationScale;
            const CBox box{logical.x - 12, logical.y - 10, 56, 64};
            if (it->second.lastDamage.w > 0) g_pHyprRenderer->damageBox(it->second.lastDamage);
            g_pHyprRenderer->damageBox(box);
            it->second.lastDamage = box;
        }
        const int variant = (reinterpret_cast<uintptr_t>(w.get()) >> 4) & 1;
        if (!framed) {
            framed = true;
            if (indicatorFrame) {
                const auto edges = screenFrame(mon->m_size * mon->m_scale, mon->m_scale);
                const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
                for (size_t edge = 0; edge < edges.size(); ++edge) {
                    if (!frameTextures[edge]) {
                        const int width = edge < 2 ? 1 : 480, height = edge < 2 ? 480 : 1;
                        auto surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, width, height);
                        auto cr = cairo_create(surface);
                        auto gradient = cairo_pattern_create_linear(edge == 3 ? width : 0, edge == 1 ? height : 0,
                                                                    edge == 2 ? width : 0, edge == 0 ? height : 0);
                        // These are the original desktop/panel.py working-glow stops.
                        for (const auto& stop : std::array<std::pair<double, double>, 5>{{{0, .80}, {.18, .45}, {.40, .20}, {.68, .07}, {1, 0}}})
                            cairo_pattern_add_color_stop_rgba(gradient, stop.first, indicatorColor[0], indicatorColor[1], indicatorColor[2], stop.second);
                        cairo_set_source(cr, gradient); cairo_paint(cr);
                        cairo_pattern_destroy(gradient); cairo_destroy(cr); cairo_surface_flush(surface);
                        frameTextures[edge] = g_pHyprRenderer->createTexture(surface); cairo_surface_destroy(surface);
                    }
                    CTexPassElement::SRenderData glow;
                    glow.tex = frameTextures[edge]; glow.box = edges[edge];
                    glow.a = indicatorPulse ? indicatorOpacity(seconds) : 1;
                    glow.damage = CRegion{glow.box};
                    Render::IHyprRenderer::addPassElement(ctx, makeUnique<CTexPassElement>(std::move(glow)));
                    if (indicatorPulse) {
                        const auto& area = screenFrame(mon->m_size, 1)[edge];
                        g_pHyprRenderer->damageBox(CBox{mon->m_position + Vector2D{area.x, area.y}, {area.w, area.h}});
                    }
                }
            }
            const auto workspace = workspaceNumber(w->m_workspace).value_or(0);
            if (!workspaceLabels.contains(workspace)) {
                if (workspaceLabels.size() >= 64) workspaceLabels.clear();
                auto surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, 520, 64);
                auto cr = cairo_create(surface);
                cairo_set_source_rgba(cr, 0.04, 0.09, 0.10, 0.94); cairo_paint(cr);
                cairo_select_font_face(cr, "Sans", CAIRO_FONT_SLANT_NORMAL, CAIRO_FONT_WEIGHT_BOLD);
                cairo_set_font_size(cr, 26); cairo_set_source_rgb(cr, 0.95, 0.97, 1);
                cairo_move_to(cr, 20, 42);
                cairo_show_text(cr, std::format("Orbit  |  Desktop {}", workspace).c_str());
                cairo_destroy(cr); cairo_surface_flush(surface);
                workspaceLabels[workspace] = g_pHyprRenderer->createTexture(surface);
                cairo_surface_destroy(surface);
            }
            CTexPassElement::SRenderData label;
            label.tex = workspaceLabels.at(workspace);
            label.box = CBox{(mon->m_size.x - 300) * mon->m_scale / 2, 40 * mon->m_scale, 300 * mon->m_scale, 38 * mon->m_scale};
            label.damage = CRegion{label.box};
            Render::IHyprRenderer::addPassElement(ctx, makeUnique<CTexPassElement>(std::move(label)));
        }
        const auto progress = clickProgress(it->second.clicked, std::chrono::steady_clock::now());
        if (progress >= 0) {
            if (!clickTexture) {
                auto surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, 128, 128);
                auto cr = cairo_create(surface);
                cairo_arc(cr, 64, 64, 52, 0, 2 * M_PI);
                cairo_set_source_rgba(cr, indicatorColor[0], indicatorColor[1], indicatorColor[2], 0.18); cairo_fill_preserve(cr);
                cairo_set_source_rgb(cr, 0.86, 1, 0.96); cairo_set_line_width(cr, 6); cairo_stroke(cr);
                cairo_destroy(cr); cairo_surface_flush(surface);
                clickTexture = g_pHyprRenderer->createTexture(surface); cairo_surface_destroy(surface);
            }
            const auto click = (w->position(Desktop::View::IGeometric::GEOMETRIC_CURRENT) + it->second.clickLocal * animationScale - mon->m_position) * mon->m_scale;
            const double diameter = (28 + 30 * progress) * mon->m_scale;
            CTexPassElement::SRenderData pulse;
            pulse.tex = clickTexture; pulse.a = 1 - progress;
            pulse.box = CBox{click.x - diameter / 2, click.y - diameter / 2, diameter, diameter};
            pulse.damage = CRegion{pulse.box};
            Render::IHyprRenderer::addPassElement(ctx, makeUnique<CTexPassElement>(std::move(pulse)));
            // Keep frames coming through expiry so no final pulse is left on screen.
            g_pHyprRenderer->damageMonitor(mon);
        }
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
            cairo_set_source_rgb(cr, indicatorColor[0], indicatorColor[1], indicatorColor[2]);
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
        const double pointerScale = 4.0 / 3.0;
        data.box = CBox{pos.x - 4 * pointerScale * mon->m_scale, pos.y - 3 * pointerScale * mon->m_scale,
                       40 * mon->m_scale, 48 * mon->m_scale};
        data.damage = CRegion{data.box};
        Render::IHyprRenderer::addPassElement(ctx, makeUnique<CTexPassElement>(std::move(data)));
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
    if (!g_pSeatManager || !PROTO::data || !PROTO::primarySelection) {
        t.error = "refused: native input requires seat and selection protocols";
        return t;
    }
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
            (!std::regex_match(unit, std::regex{"orbit-native-[0-9a-f]{32}\\.scope"}) &&
             !std::regex_match(unit, std::regex{"lease-[0-9a-fA-F]{32}"}))) {
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
    if (!stable.empty() && std::format("{:x}", t.window->metadata().stableID()) != stable) {
        t.error = "refused: native window stable identity changed";
        return t;
    }
    const bool applicationTarget = unit.starts_with("lease-");
    if (!t.window->mapped() || !t.window->m_workspace ||
        !applicationTarget) {
        t.error = "refused: an explicit owner application lease is required";
        t.window.reset();
        return t;
    }
    t.surface = t.window->resource();
    if (!t.surface || !t.surface->client()) {
        t.error = "window has no live surface client";
        return t;
    }
    if (applicationLeaseForClient(t.surface->client()) && !applicationTarget) {
        t.error = "refused: application client requires its guarded lease identity";
        return t;
    }
    if (applicationTarget) {
        const auto lease = applicationLeases.find(unit.substr(6));
        if (lease == applicationLeases.end() || lease->second->paused ||
            lease->second->client != t.surface->client() || !leasedWindow(t.window)) {
            t.error = "refused: application lease is unavailable, paused or target changed";
            return t;
        }
        if (ownerInputActive(*lease->second)) {
            t.error = "refused: application lease is paused while the owner is typing or clicking; it resumes after a short idle";
            return t;
        }
    } else if (!unit.empty()) {
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
    // Application leases are the exception: agent input is client-local and
    // physical input to the client pauses the lease instead.
    if (!applicationTarget && ((keyboardFocus && keyboardFocus->client() == t.surface->client()) ||
        (pointerFocus && pointerFocus->client() == t.surface->client()))) {
        t.error = "refused: target client holds the seat focus";
        return t;
    }
    t.seat = g_pSeatManager->seatResourceForClient(t.surface->client());
    if (!t.seat)
        t.error = "client has no seat";
    else if (wake) {
      try {
        clientHasDataControlDevice(PROTO::data, t.surface->client());
        guardPrimarySelection(t.surface->client());
        // Background rendering requires the client to keep processing paint events.
        auto xdg = windowXdg(t.window);
        if (xdg && xdg->m_toplevel &&
            std::ranges::find(xdg->m_toplevel->m_pendingApply.states, XDG_TOPLEVEL_STATE_SUSPENDED) !=
                xdg->m_toplevel->m_pendingApply.states.end())
            awakeWindows[address] = t.window;
        t.window->setSuspended(false);
      } catch (const std::exception& error) { t.error = std::string{"refused: native selection admission: "} + error.what(); }
      catch (...) { t.error = "refused: native selection admission failed"; }
    }
    return t;
}

// One keystroke: keycode in evdev numbering (xkb keycode minus 8).
struct SStroke {
    uint32_t evdev;
    uint32_t mods;
    uint32_t group;
};

struct SKeyboardPreparation {
    wl_client* client = nullptr;
    std::string token;
    PHLWINDOWREF window;
    WP<CWLSurfaceResource> surface;
    WP<CXDGSurfaceResource> xdg;
    WP<CWLSeatResource> seat;
    std::vector<WP<CWLKeyboardResource>> keyboards;
    CHyprSignalListener ack, unmap, destroy, seatDestroy, popup;
    std::chrono::steady_clock::time_point expires;
    uint32_t serial = 0;
    bool acknowledged = false;
    bool invalid = false;
    bool arming = false;
};
static std::map<std::string, std::unique_ptr<SKeyboardPreparation>> keyboardPreparations;
// One high-water counter per producer, live client and scope, not per key.
static std::map<std::pair<wl_client*, std::string>, std::map<std::string, uint64_t>> keyboardSequences;


static void cancelKeyboardClient(wl_client* client) {
    std::erase_if(keyboardPreparations, [client](const auto& entry) {
        if (entry.second->client != client) return false;
        entry.second->invalid = true;
        return !entry.second->arming;
    });
}

static void retireKeyboardClient(wl_client* client) {
    cancelKeyboardClient(client);
    std::erase_if(keyboardSequences, [client](const auto& entry) { return entry.first.first == client; });
}

static void retireKeyboardLease(const std::string& id) {
    std::erase_if(keyboardSequences, [&id](const auto& entry) { return entry.first.second == "lease-" + id; });
}

static void pruneKeyboardPreparations() {
    const auto now = std::chrono::steady_clock::now();
    std::erase_if(keyboardPreparations, [now](const auto& entry) {
        const auto& value = *entry.second;
        return !value.arming && (value.invalid || now >= value.expires || !value.window.lock() ||
               !value.surface.lock() || !value.xdg.lock() || !value.seat.lock());
    });
}

static void keyboardProtocolTransition(wl_protocol_logger_type direction, const wl_protocol_logger_message* message) {
    if (!message || !message->resource || !message->message || direction != WL_PROTOCOL_LOGGER_EVENT ||
        std::strcmp(wl_resource_get_class(message->resource), "wl_keyboard") != 0) return;
    const auto name = message->message->name;
    if (std::strcmp(name, "enter") && std::strcmp(name, "leave") && std::strcmp(name, "keymap")) return;
    const auto client = wl_resource_get_client(message->resource);
    for (auto& [handle, value] : keyboardPreparations)
        if (value->client == client && !value->arming) value->invalid = true;
}

static std::vector<SP<CWLKeyboardResource>> targetKeyboards(const STarget& target) {
    std::vector<SP<CWLKeyboardResource>> result;
    for (const auto& weak : target.seat->m_keyboards)
        if (auto keyboard = weak.lock(); keyboard && keyboard->good() && keyboard->m_owner.lock() == target.seat)
            result.push_back(keyboard);
    return result;
}

static void prepareKeyboardResource(const SP<CWLKeyboardResource>& keyboard, const STarget& target, wl_array* keys) {
    const auto previous = agentKeyboards.find(keyboard.get());
    const bool enrolled = previous != agentKeyboards.end() && previous->second.lock() == keyboard;
    if (!enrolled) keyboard->sendKeymap(agentKeyboard);
    // Re-entering the same surface for every shortcut can reset toolkit focus
    // and selection state. Retain the client's own keyboard focus between actions.
    if (!enrolled || keyboard->m_currentSurface.lock() != target.surface)
        keyboard->sendEnter(target.surface, keys);
    keyboard->sendMods(0, 0, 0, 0);
    agentKeyboards[keyboard.get()] = keyboard;
}

static bool preparationMatches(const SKeyboardPreparation& value, const STarget& target) {
    if (value.invalid || std::chrono::steady_clock::now() >= value.expires ||
        value.window.lock() != target.window || value.surface.lock() != target.surface ||
        value.xdg.lock() != windowXdg(target.window) || value.seat.lock() != target.seat ||
        value.client != target.surface->client()) return false;
    const auto keyboards = targetKeyboards(target);
    if (keyboards.empty() || keyboards.size() != value.keyboards.size()) return false;
    for (size_t index = 0; index < keyboards.size(); ++index)
        if (value.keyboards[index].lock() != keyboards[index] || keyboards[index]->m_currentSurface.lock() != target.surface)
            return false;
    return true;
}

static std::string keyboardPreparationReply(const SKeyboardPreparation& value) {
    return std::format("{{\"schema\":1,\"status\":\"{}\",\"token\":\"{}\",\"serial\":{}}}",
                       value.acknowledged ? "ready" : "pending", value.token, value.serial);
}

static std::string cmdKeyboardPreparation(eHyprCtlOutputFormat, std::string request) {
    pruneKeyboardPreparations();
    std::istringstream input(request);
    std::string command, handle, token, extra;
    if (!(input >> command >> handle >> token) || (input >> extra) || handle.find('@') == std::string::npos ||
        !std::regex_match(token, std::regex{"[0-9a-f]{48}"}))
        return "refused: guarded target and operation identity required";
    auto existing = keyboardPreparations.find(handle);
    if (command == "ghost-keyboard-cancel") {
        if (existing == keyboardPreparations.end()) return "ok";
        if (existing->second->token != token) return "refused: keyboard operation identity changed";
        keyboardPreparations.erase(existing);
        return "ok";
    }
    auto target = resolve(handle);
    if (!target.error.empty()) return target.error;
    if (existing != keyboardPreparations.end()) {
        if (existing->second->token != token) return "refused: another keyboard operation is pending";
        if (!preparationMatches(*existing->second, target)) {
            keyboardPreparations.erase(existing);
            return "refused: keyboard preparation target changed";
        }
        return keyboardPreparationReply(*existing->second);
    }
    const auto producer = token.substr(0, 32);
    const auto sequence = std::stoull(token.substr(32), nullptr, 16);
    if (!sequence) return "refused: invalid keyboard operation sequence";
    if (!agentClient(target.surface->client())) return "refused: keyboard client is unavailable";
    auto& producers = keyboardSequences[{target.surface->client(), handle.substr(handle.rfind('@') + 1)}];
    const auto previous = producers.find(producer);
    if ((previous != producers.end() && sequence <= previous->second) ||
        (previous == producers.end() && producers.size() >= 64))
        return "refused: replayed or excessive keyboard producer";
    const auto xdg = windowXdg(target.window);
    const auto keyboards = targetKeyboards(target);
    if (!xdg || !xdg->m_toplevel || keyboards.empty()) return "refused: native keyboard preparation unavailable";
    if (keyboardPreparations.size() >= 64) return "refused: too many pending keyboard operations";
    auto value = std::make_unique<SKeyboardPreparation>();
    value->client = target.surface->client(); value->token = token; value->window = target.window;
    value->surface = target.surface; value->xdg = xdg; value->seat = target.seat;
    value->expires = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    for (const auto& keyboard : keyboards) value->keyboards.emplace_back(keyboard);
    auto raw = value.get();
    value->ack = xdg->m_events.ack.listen([raw](uint32_t serial) {
        if (serial == raw->serial) raw->acknowledged = true;
        // Later size or decoration configure acknowledgements do not revoke
        // keyboard focus. Surface, resource and focus transitions are checked separately.
    });
    value->unmap = xdg->m_events.unmap.listen([raw] { raw->invalid = true; });
    value->destroy = xdg->m_events.destroy.listen([raw] { raw->invalid = true; });
    value->seatDestroy = target.seat->m_events.destroy.listen([raw] { raw->invalid = true; });
    value->popup = xdg->m_events.newPopup.listen([raw](SP<CXDGPopupResource>) { raw->invalid = true; });
    keyboardPreparations.emplace(handle, std::move(value));
    producers[producer] = sequence;
    raw->arming = true;
    wl_array keys;
    wl_array_init(&keys);
    for (const auto& keyboard : keyboards) prepareKeyboardResource(keyboard, target, &keys);
    wl_array_release(&keys);
    raw->arming = false;
    raw->serial = xdg->scheduleConfigure();
    return keyboardPreparationReply(*raw);
}

static bool consumeKeyboardPreparation(const STarget& target, const std::string& handle, const std::string& token) {
    pruneKeyboardPreparations();
    const auto found = keyboardPreparations.find(handle);
    if (found == keyboardPreparations.end() || found->second->token != token) return false;
    const bool ready = found->second->acknowledged && preparationMatches(*found->second, target);
    keyboardPreparations.erase(found);
    return ready;
}

static bool sendStrokes(const STarget& target, const std::vector<SStroke>& strokes) {
    const auto keyboards = targetKeyboards(target);
    if (keyboards.empty()) return false;
    for (const auto& keyboard : keyboards) {
        for (const auto& stroke : strokes) {
            keyboard->sendMods(stroke.mods, 0, 0, stroke.group);
            keyboard->sendKey(nowMs(), stroke.evdev, WL_KEYBOARD_KEY_STATE_PRESSED);
            keyboard->sendKey(nowMs(), stroke.evdev, WL_KEYBOARD_KEY_STATE_RELEASED);
        }
        keyboard->sendMods(0, 0, 0, 0);
    }
    return true;
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
    std::string        cmd, address, token;
    in >> cmd >> address;
    if (cmd != "ghost-texthex-prepared") return "refused: keyboard preparation required";
    if (!(in >> token)) return "refused: keyboard operation identity required";
    auto t = resolve(address, false);
    if (!t.error.empty()) return t.error;
    // A matching commit consumes its identity even when payload validation fails.
    if (!consumeKeyboardPreparation(t, address, token)) return "refused: keyboard preparation is unavailable or stale";
    std::string text;
    std::getline(in, text);
    if (!text.empty() && text[0] == ' ')
        text.erase(0, 1);
    if (cmd == "ghost-texthex-prepared") {
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
    std::string        cmd, address, token, combo, extra;
    in >> cmd >> address;
    if (cmd != "ghost-key-prepared") return "refused: keyboard preparation required";
    if (!(in >> token >> combo) || (in >> extra)) return "refused: one prepared key combination required";
    auto t = resolve(address, false);
    if (!t.error.empty())
        return t.error;
    if (!consumeKeyboardPreparation(t, address, token)) return "refused: keyboard preparation is unavailable or stale";
    auto km = seatKeymap();
    if (!km)
        return "no seat keymap";
    uint32_t    mods = 0;
    std::string key  = combo;
    size_t      plus;
    while ((plus = key.find('+')) != std::string::npos && plus + 1 < key.size()) {
        std::string m = key.substr(0, plus);
        key           = key.substr(plus + 1);
        std::transform(m.begin(), m.end(), m.begin(), [](unsigned char c) { return std::tolower(c); });
        const char* name = m == "ctrl" || m == "control" || m == "control_l" || m == "control_r" ? XKB_MOD_NAME_CTRL :
            m == "shift" || m == "shift_l" || m == "shift_r" ? XKB_MOD_NAME_SHIFT :
            m == "alt" || m == "alt_l" || m == "alt_r" ? XKB_MOD_NAME_ALT :
            m == "super" || m == "super_l" || m == "super_r" ? XKB_MOD_NAME_LOGO : nullptr;
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

// Public native coordinates describe the captured window content. Wayland
// pointer events describe its root surface, including client decoration offsets.
static std::optional<Vector2D> surfaceInputPoint(Vector2D goal, Vector2D surfaceSize, CBox geometry, Vector2D point) {
    if (!std::isfinite(goal.x) || !std::isfinite(goal.y) || goal.x <= 0 || goal.y <= 0 ||
        !std::isfinite(point.x) || !std::isfinite(point.y) || point.x < 0 || point.y < 0 || point.x >= goal.x || point.y >= goal.y)
        return std::nullopt;
    if (geometry.w <= 0 || geometry.h <= 0) geometry = CBox{0, 0, surfaceSize.x, surfaceSize.y};
    const Vector2D local{geometry.x + point.x * geometry.w / goal.x, geometry.y + point.y * geometry.h / goal.y};
    if (!std::isfinite(local.x) || !std::isfinite(local.y) || std::abs(local.x) > 8388607 || std::abs(local.y) > 8388607)
        return std::nullopt;
    return local;
}

// BEGIN pointer-hold
static double motionClock() {
    return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

static void armHoldTimer() {
    if (!holdTimer) return;
    std::optional<std::chrono::steady_clock::time_point> next;
    for (const auto& [pointer, hold] : pointerHolds)
        if (!next || hold.expires < *next) next = hold.expires;
    if (!next) { holdTimer->updateTimeout(std::nullopt); return; }
    const auto wait = std::max(std::chrono::steady_clock::duration(std::chrono::milliseconds(1)),
                               *next - std::chrono::steady_clock::now());
    holdTimer->updateTimeout(wait);
    g_pEventLoopManager->scheduleRecalc();
}

// Hover and held buttons last a bounded time after the last pointer action. At expiry the
// client gets its pointer back and any held button is released first.
static void sweepPointerHolds() {
    const auto now = std::chrono::steady_clock::now();
    for (auto it = scrollPointers.begin(); it != scrollPointers.end();) {
        auto pointer = it->second.lock();
        const auto hold = pointerHolds.find(it->first);
        if (pointer && hold != pointerHolds.end() && hold->second.expires > now) { ++it; continue; }
        if (pointer && pointer->m_owner) returnClientPointer(pointer, pointer->m_owner->client());
        pointerHolds.erase(it->first);
        it = scrollPointers.erase(it);
    }
    armHoldTimer();
}

static bool buttonsHeld(const SP<CWLSeatResource>& seat) {
    for (const auto& weak : seat->m_pointers)
        if (auto pointer = weak.lock())
            if (const auto hold = pointerHolds.find(pointer.get()); hold != pointerHolds.end() && !hold->second.buttons.empty())
                return true;
    return false;
}

// Pointer motion along the drawn path while a button is held, so the application sees
// a real drag and not one jump. Ticks run on the compositor loop, never on a caller.
struct SPointerPump {
    PHLWINDOWREF window;
    WP<CWLSurfaceResource> surface;
    WP<CWLSeatResource> seat;
    bool approach = false;
    cursor_motion::Vec dragFrom, dragTo;
    uint64_t seed = 0;
    // A silent pump sends no motion: it only waits until notBefore, then runs done.
    bool silent = false;
    double notBefore = 0;
    std::function<void(bool)> done;
};
static std::map<std::string, SPointerPump> pumps;
static SP<CEventLoopTimer> pumpTimer;
static void armPumpTimer() {
    if (!pumpTimer || pumps.empty()) return;
    pumpTimer->updateTimeout(std::chrono::milliseconds(8));
    g_pEventLoopManager->scheduleRecalc();
}

// Returns false when no held pointer is left, which means the hold ended and the pump is void.
static bool pumpSend(SPointerPump& pump, cursor_motion::Vec point) {
    auto window = pump.window.lock();
    auto surface = pump.surface.lock();
    auto seat = pump.seat.lock();
    if (!window || !surface || !seat) return false;
    const auto xdg = windowXdg(window);
    const auto local = surfaceInputPoint(window->size(Desktop::View::IGeometric::GEOMETRIC_GOAL), surface->m_current.size,
        xdg ? xdg->m_current.geometry : CBox{}, Vector2D{point.x, point.y});
    bool sent = false;
    for (const auto& weak : seat->m_pointers) {
        auto pointer = weak.lock();
        if (!pointer || !scrollPointers.contains(pointer.get())) continue;
        sent = true;
        if (!local) continue;
        pointer->sendMotion(nowMs(), *local);
        pointer->sendFrame();
        if (auto hold = pointerHolds.find(pointer.get()); hold != pointerHolds.end() && !hold->second.buttons.empty())
            hold->second.expires = std::chrono::steady_clock::now() + buttonHold;
    }
    return sent;
}

static void pumpTick() {
    const double now = motionClock();
    for (auto it = pumps.begin(); it != pumps.end();) {
        auto cursor = cursors.find(it->first);
        if (cursor == cursors.end()) { it = pumps.erase(it); continue; }
        auto& pump = it->second;
        auto& motion = cursor->second.motion;
        if (now < pump.notBefore) { ++it; continue; }
        if (pump.silent) {
            auto done = std::move(pump.done);
            it = pumps.erase(it);
            if (done) done(false);
            continue;
        }
        if (pump.approach) {
            if (cursor_motion::traveling(motion, now)) { ++it; continue; }
            motion = cursor_motion::plan(pump.dragFrom, pump.dragTo, pump.seed, now, false, false);
            pump.approach = false;
        }
        const bool finished = !cursor_motion::traveling(motion, now);
        const auto point = finished ? motion.to : cursor_motion::position(motion, now);
        if (!pumpSend(pump, point)) { it = pumps.erase(it); continue; }
        if (finished) {
            auto done = std::move(pump.done);
            it = pumps.erase(it);
            if (done) done(false);
        } else ++it;
    }
    armPumpTimer();
}

// Finish a pump at once: motion to its final point, then its completion action.
static void flushPump(const std::string& address) {
    const auto it = pumps.find(address);
    if (it == pumps.end()) return;
    auto pump = std::move(it->second);
    pumps.erase(it);
    const auto cursor = cursors.find(address);
    const auto end = pump.approach ? pump.dragTo : (cursor != cursors.end() ? cursor->second.motion.to : pump.dragTo);
    if (pump.silent) { if (pump.done) pump.done(true); return; }
    if (pumpSend(pump, end) && pump.done) pump.done(true);
}

static double pumpRemainingSeconds(const std::string& address) {
    const auto it = pumps.find(address);
    const auto cursor = cursors.find(address);
    if (it == pumps.end() || cursor == cursors.end()) return 0;
    const double now = motionClock(), left = std::max(0.0, cursor->second.motion.start + cursor->second.motion.total() - now);
    if (!it->second.approach) return left;
    const double dx = it->second.dragTo.x - it->second.dragFrom.x, dy = it->second.dragTo.y - it->second.dragFrom.y;
    return left + cursor_motion::travelSeconds(std::hypot(dx, dy));
}

// Release one agent button on the client's pointers and put the drawing back to a
// resting, drifting cursor. Safe to call when the hold is already gone.
static void releaseAgentButton(const WP<CWLSeatResource>& weakSeat, uint32_t button, const std::string& address, bool drift) {
    if (auto seat = weakSeat.lock()) {
        for (const auto& weak : seat->m_pointers) {
            auto pointer = weak.lock();
            if (!pointer) continue;
            auto hold = pointerHolds.find(pointer.get());
            if (hold == pointerHolds.end() || !hold->second.buttons.erase(button)) continue;
            pointer->sendButton(nowMs(), button, WL_POINTER_BUTTON_STATE_RELEASED);
            pointer->sendFrame();
            hold->second.expires = std::chrono::steady_clock::now() + hoverHold;
        }
        armHoldTimer();
    }
    if (drift)
        if (auto cursor = cursors.find(address); cursor != cursors.end() && !cursor_motion::traveling(cursor->second.motion, motionClock())) {
            const auto at = cursor->second.motion.to;
            cursor->second.motion = cursor_motion::plan(at, at, cursorSequence * 0x9e3779b97f4a7c15ULL + 1, motionClock(), true);
        }
}

// Press or release one agent button on every pointer the agent holds on this seat.
static void sendAgentButton(const WP<CWLSeatResource>& weakSeat, uint32_t button, bool press) {
    auto seat = weakSeat.lock();
    if (!seat) return;
    for (const auto& weak : seat->m_pointers) {
        auto pointer = weak.lock();
        if (!pointer || !scrollPointers.contains(pointer.get())) continue;
        auto& hold = pointerHolds[pointer.get()];
        if (press) hold.buttons.insert(button); else hold.buttons.erase(button);
        pointer->sendButton(nowMs(), button, press ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED);
        pointer->sendFrame();
        hold.expires = std::chrono::steady_clock::now() + (hold.buttons.empty() ? hoverHold : buttonHold);
    }
    armHoldTimer();
}

// A person's click is motion, a short pause, a press and a release a few tens of
// milliseconds later. Pages that decide a link click from the pointer position the
// content process has seen need that spacing, so the press and release are timed.
static void scheduleClick(const std::string& address, const STarget& t, uint32_t button) {
    const WP<CWLSeatResource> seat = t.seat;
    SPointerPump press;
    press.window = t.window; press.surface = t.surface; press.seat = t.seat;
    press.silent = true;
    press.notBefore = motionClock() + 0.045;
    press.done = [seat, button, address](bool flushed) {
        sendAgentButton(seat, button, true);
        if (flushed) { sendAgentButton(seat, button, false); return; }
        SPointerPump release;
        release.seat = seat;
        release.silent = true;
        release.notBefore = motionClock() + 0.06;
        release.done = [seat, button](bool) { sendAgentButton(seat, button, false); };
        pumps[address] = std::move(release);
        armPumpTimer();
    };
    pumps[address] = std::move(press);
    if (!pumpTimer) {
        pumpTimer = makeShared<CEventLoopTimer>(std::nullopt, [](SP<CEventLoopTimer>, void*) { pumpTick(); }, nullptr);
        g_pEventLoopManager->addTimer(pumpTimer);
    }
    armPumpTimer();
}

static uint32_t buttonCode(double extra) {
    return extra == 2 ? 0x111 /* BTN_RIGHT */ : extra == 3 ? 0x112 /* BTN_MIDDLE */ : 0x110 /* BTN_LEFT */;
}

// kind: 0 move, 1 click, 2 scroll, 3 cursor only, 4 button down, 5 button up.
// The synthetic pointer stays on the target surface after every input kind, so hover
// works, until the next action, ghost-release, owner input or the hold timeout.
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
    const Vector2D point{x, y};
    const auto xdg = windowXdg(t.window);
    const auto local = surfaceInputPoint(t.window->size(Desktop::View::IGeometric::GEOMETRIC_GOAL),
        t.surface->m_current.size, xdg ? xdg->m_current.geometry : CBox{}, point);
    if (!std::isfinite(extra) || !local)
        return "refused: coordinates outside target window";
    if (kind == 2 && (extra == 0 || std::abs(extra) > 10000 || std::trunc(extra) != extra))
        return "refused: scroll steps must be a nonzero integer within 10000";
    const uint32_t button = buttonCode(extra);
    // A held button is per client. Check before anything is drawn or sent.
    bool holding = false, thisHeld = false;
    for (const auto& pw : t.seat->m_pointers)
        if (auto p = pw.lock())
            if (const auto hold = pointerHolds.find(p.get()); hold != pointerHolds.end() && !hold->second.buttons.empty()) {
                holding = true;
                thisHeld = thisHeld || hold->second.buttons.contains(button);
            }
    if (kind == 4 && thisHeld) return "refused: that button is already held";
    if (kind == 5 && !thisHeld) return "refused: that button is not held";
    flushPump(address);
    // One pointer per actor client. Retire stale pointers from sibling windows.
    for (auto it = cursors.begin(); it != cursors.end();) {
        auto window = it->second.window.lock();
        auto resource = window ? window->resource() : SP<CWLSurfaceResource>{};
        if (it->first != address && resource && resource->client() == t.surface->client()) {
            g_pHyprRenderer->damageMonitor(window->m_monitor.lock());
            pumps.erase(it->first);
            it = cursors.erase(it);
        } else ++it;
    }
    auto& cursor = cursors[address];
    // While a button is held there is no drift and no overshoot, so the application never
    // sees the pointer beyond where the agent aimed.
    const bool heldAfter = kind == 4 || (holding && kind != 5);
    {
        const auto stamp = std::chrono::steady_clock::now();
        const double now = std::chrono::duration<double>(stamp.time_since_epoch()).count();
        const bool known = cursor.sequence != 0;
        // Begin from where the cursor is drawn now (travel or drift), so the next
        // action cancels drift without a jump. A new window starts at the target.
        const auto shown = known ? cursor_motion::position(cursor.motion, now)
                                 : cursor_motion::Vec{point.x, point.y};
        const uint64_t seed = static_cast<uint64_t>(stamp.time_since_epoch().count()) ^ (cursorSequence * 0x9e3779b97f4a7c15ULL);
        cursor.motion = cursor_motion::plan(shown, {point.x, point.y}, seed, now, !heldAfter, !(holding || heldAfter));
        cursor.held = heldAfter;
        cursor.window = t.window; cursor.local = point; cursor.sequence = ++cursorSequence;
        if (kind == 1) {
            cursor.clickLocal = point;
            cursor.clicked = stamp + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                std::chrono::duration<double>(cursor.motion.total()));
        }
    }
    g_pHyprRenderer->damageMonitor(t.window->m_monitor.lock());
    if (kind == 3)
        return "ok";
    // With a button held a move, and a release, travel along the drawn path.
    const bool animated = holding && (kind == 0 || kind == 5) && cursor.motion.total() > 0;
    if (animated) {
        SPointerPump pump;
        pump.window = t.window; pump.surface = t.surface; pump.seat = t.seat;
        if (kind == 5) {
            const WP<CWLSeatResource> seat = t.seat;
            pump.done = [seat, button, address](bool) { releaseAgentButton(seat, button, address, true); };
        }
        pumps[address] = std::move(pump);
        if (!pumpTimer) {
            pumpTimer = makeShared<CEventLoopTimer>(std::nullopt, [](SP<CEventLoopTimer>, void*) { pumpTick(); }, nullptr);
            g_pEventLoopManager->addTimer(pumpTimer);
        }
        armPumpTimer();
    }
    int sent = 0;
    for (auto const& pw : t.seat->m_pointers) {
        auto p = pw.lock();
        if (!p)
            continue;
        ++sent;
        p->sendEnter(t.surface, *local);
        if (!animated) {
            p->sendMotion(nowMs(), *local);
            p->sendFrame();
        }
        if (kind == 1) {
            // Pressed and released later by scheduleClick, after the pointer is registered below.
        } else if (kind == 4) {
            p->sendButton(nowMs(), button, WL_POINTER_BUTTON_STATE_PRESSED);
            p->sendFrame();
            pointerHolds[p.get()].buttons.insert(button);
        } else if (kind == 5 && !animated) {
            p->sendButton(nowMs(), button, WL_POINTER_BUTTON_STATE_RELEASED);
            p->sendFrame();
            pointerHolds[p.get()].buttons.erase(button);
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
        // Keep this client's synthetic pointer on the surface (hover, a Qt wheel frame,
        // a held button) until a later pointer action, ghost-release, owner input or timeout.
        scrollPointers[p.get()] = p;
        auto& hold = pointerHolds[p.get()];
        hold.expires = std::chrono::steady_clock::now() + (hold.buttons.empty() ? hoverHold : buttonHold);
    }
    std::erase_if(scrollPointers, [](const auto& entry) { return !entry.second.lock(); });
    armHoldTimer();
    if (kind == 1 && sent) scheduleClick(address, t, button);
    return sent ? "ok" : "target has no pointer resource";
}

// ghost-drag <address> x1 y1 x2 y2 [button]: press at the first point, move along a curved
// path with no overshoot, release at the second point. The command returns at once; the
// motion and the release run on the compositor loop and ghost-state reports motion_active.
static std::string dragCmd(std::string req) {
    std::istringstream in(req);
    std::string        cmd, address;
    double             x1 = 0, y1 = 0, x2 = 0, y2 = 0, extra = 0;
    if (!(in >> cmd >> address >> x1 >> y1 >> x2 >> y2))
        return "expected window address and two x y points";
    in >> extra;
    auto t = resolve(address);
    if (!t.error.empty())
        return t.error;
    const auto xdg = windowXdg(t.window);
    const auto goal = t.window->size(Desktop::View::IGeometric::GEOMETRIC_GOAL);
    const auto start = surfaceInputPoint(goal, t.surface->m_current.size, xdg ? xdg->m_current.geometry : CBox{}, {x1, y1});
    const auto end = surfaceInputPoint(goal, t.surface->m_current.size, xdg ? xdg->m_current.geometry : CBox{}, {x2, y2});
    if (!std::isfinite(extra) || !start || !end)
        return "refused: coordinates outside target window";
    if (buttonsHeld(t.seat))
        return "refused: a button is already held";
    flushPump(address);
    for (auto it = cursors.begin(); it != cursors.end();) {
        auto window = it->second.window.lock();
        auto resource = window ? window->resource() : SP<CWLSurfaceResource>{};
        if (it->first != address && resource && resource->client() == t.surface->client()) {
            g_pHyprRenderer->damageMonitor(window->m_monitor.lock());
            pumps.erase(it->first);
            it = cursors.erase(it);
        } else ++it;
    }
    auto& cursor = cursors[address];
    const auto stamp = std::chrono::steady_clock::now();
    const double now = std::chrono::duration<double>(stamp.time_since_epoch()).count();
    const auto shown = cursor.sequence != 0 ? cursor_motion::position(cursor.motion, now) : cursor_motion::Vec{x1, y1};
    const uint64_t seed = static_cast<uint64_t>(stamp.time_since_epoch().count()) ^ (cursorSequence * 0x9e3779b97f4a7c15ULL);
    cursor.motion = cursor_motion::plan(shown, {x1, y1}, seed, now, false, false);
    cursor.held = true;
    cursor.window = t.window; cursor.local = {x2, y2}; cursor.sequence = ++cursorSequence;
    g_pHyprRenderer->damageMonitor(t.window->m_monitor.lock());
    const uint32_t button = buttonCode(extra);
    int sent = 0;
    for (auto const& pw : t.seat->m_pointers) {
        auto p = pw.lock();
        if (!p) continue;
        ++sent;
        p->sendEnter(t.surface, *start);
        p->sendMotion(nowMs(), *start);
        p->sendFrame();
        p->sendButton(nowMs(), button, WL_POINTER_BUTTON_STATE_PRESSED);
        p->sendFrame();
        scrollPointers[p.get()] = p;
        auto& hold = pointerHolds[p.get()];
        hold.buttons.insert(button);
        hold.expires = std::chrono::steady_clock::now() + buttonHold;
    }
    if (!sent) return "target has no pointer resource";
    SPointerPump pump;
    pump.window = t.window; pump.surface = t.surface; pump.seat = t.seat;
    pump.approach = true;
    pump.dragFrom = {x1, y1}; pump.dragTo = {x2, y2}; pump.seed = seed + 7;
    const WP<CWLSeatResource> seat = t.seat;
    pump.done = [seat, button, address](bool) { releaseAgentButton(seat, button, address, true); };
    pumps[address] = std::move(pump);
    if (!pumpTimer) {
        pumpTimer = makeShared<CEventLoopTimer>(std::nullopt, [](SP<CEventLoopTimer>, void*) { pumpTick(); }, nullptr);
        g_pEventLoopManager->addTimer(pumpTimer);
    }
    armPumpTimer();
    armHoldTimer();
    return "ok";
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
    if (!g_pSeatManager || !g_pHyprRenderer || !PROTO::data || !PROTO::primarySelection)
        throw std::runtime_error("[ghostinput] mandatory native protocols are unavailable");
    agentKeyboard = makeShared<CAgentKeyboard>();
    const auto context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    const xkb_rule_names names{.rules = "evdev", .model = "pc105", .layout = "us,ara", .variant = "", .options = ""};
    agentKeyboard->m_xkbKeymap = xkb_keymap_new_from_names(context, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
    xkb_context_unref(context);
    if (!agentKeyboard->m_xkbKeymap)
        throw std::runtime_error("[ghostinput] cannot build agent keymap");
    agentKeyboard->updateKeymapFD();
    installApplicationHooks();
#ifdef ORBIT_PLUGIN_SOURCE_SHA256
    registerCtl(SHyprCtlCommand{"ghost-build-info", false,
        [sourceStamp, HASH](eHyprCtlOutputFormat, std::string request) {
            if (request != "ghost-build-info")
                return std::string{"refused: build-info takes no arguments"};
            size_t roots;
            try {
                roots = liveRootCount();
            } catch (const std::exception&) {
                return std::string{"refused: registered root liveness unavailable"};
            }
            return std::string{"{\"schema\":1,\"source_sha256\":\""} + sourceStamp +
                "\",\"abi_hash\":\"" + HASH + "\",\"live_roots\":" + std::to_string(roots) + "}";
        }});
#endif
    registerCtl(SHyprCtlCommand{"ghost-application-claim", false,
        [](eHyprCtlOutputFormat, std::string request) {
            std::istringstream input(request);
            std::string command, address, stable, id, owner, extra;
            if (!(input >> command >> address >> stable >> id) || ((input >> owner) && (input >> extra)))
                return std::string{"refused: exact selected window address and stable identity required"};
            try { return claimApplication(address, stable, id, owner); }
            catch (const std::exception& error) { return std::string{"refused: "} + error.what(); }
        }});

    registerCtl(SHyprCtlCommand{"ghost-application-info", false,
        [](eHyprCtlOutputFormat, std::string request) {
            std::istringstream input(request); std::string command, id, extra;
            if (!(input >> command >> id) || (input >> extra)) return std::string{"refused: application lease identity required"};
            try { return applicationInfo(id); }
            catch (const std::exception& error) { return std::string{"refused: "} + error.what(); }
        }});
    registerCtl(SHyprCtlCommand{"ghost-application-list", false,
        [](eHyprCtlOutputFormat, std::string) {
            std::string out{"{\"schema\":1,\"leases\":["};
            bool first = true;
            const auto now = std::chrono::steady_clock::now();
            for (const auto& [id, lease] : applicationLeases) {
                if (!first) out += ',';
                first = false;
                pid_t clientPid = 0;
                if (lease->client) wl_client_get_credentials(lease->client, &clientPid, nullptr, nullptr);
                const bool known = lease->owner.pid > 0;
                out += std::format("{{\"lease_id\":\"{}\",\"paused\":{},\"windows\":{},\"client_pid\":{},\"owner_pid\":{},\"owner_start\":{},\"owner_alive\":{},\"age_seconds\":{}}}",
                    id, lease->paused ? "true" : "false", lease->windows.size(), static_cast<long>(clientPid), lease->owner.pid, lease->owner.start,
                    known ? (lease_owner::alive(lease->owner) ? "\"yes\"" : "\"no\"") : "\"unknown\"",
                    std::chrono::duration_cast<std::chrono::seconds>(now - lease->claimedAt).count());
            }
            return out + "]}";
        }});
    registerCtl(SHyprCtlCommand{"ghost-application-reap", false,
        [](eHyprCtlOutputFormat, std::string request) {
            std::istringstream input(request); std::string command, id, extra;
            if (!(input >> command >> id) || (input >> extra) || !std::regex_match(id, std::regex{"[0-9a-f]{32}"}))
                return std::string{"refused: exact application lease identity required"};
            if (applicationLeases.contains(id)) return std::string{"refused: active application lease must be handed back first"};
            try {
                return std::string{"ok"};
            } catch (const std::exception& error) { return std::string{"refused: "} + error.what(); }
        }});
    registerCtl(SHyprCtlCommand{"ghost-application-control", false,
        [](eHyprCtlOutputFormat, std::string request) {
            std::istringstream input(request);
            std::string command, id, operation, extra;
            if (!(input >> command >> id >> operation) || (input >> extra))
                return std::string{"refused: application lease identity and operation required"};
            const auto found = applicationLeases.find(id);
            if (found == applicationLeases.end()) return std::string{operation == "handback" && retiredApplicationLeases.contains(id) ? "ok" : "refused: application lease unavailable"};
            try {
                if (operation == "pause") { cancelKeyboardClient(found->second->client); found->second->paused = true; }
                else if (operation == "resume") {
                    cancelKeyboardClient(found->second->client);
                    if (found->second->failure.front()) return std::string{"refused: failed application lease requires handback"};
                    sendSharedSelection(found->second->client, false);
                    sendSharedSelection(found->second->client, true);
                    found->second->paused = false;
                }
                else if (operation == "handback") handbackApplication(id);
                else return std::string{"refused: unknown application lease operation"};
                if (operation == "pause" || operation == "resume")
                    for (const auto& [stable, retained] : found->second->windows)
                        if (auto window = retained.window.lock())
                            if (auto monitor = window->m_monitor.lock()) g_pHyprRenderer->damageMonitor(monitor);
                return std::string{"ok"};
            } catch (const std::exception& error) { return std::string{"refused: "} + error.what(); }
        }});
    registerCtl(SHyprCtlCommand{"ghost-indicator-style", false,
        [](eHyprCtlOutputFormat, std::string request) {
            std::istringstream input(request);
            std::string command, hex, pulse, frame, extra;
            if (!(input >> command >> hex >> pulse >> frame) || (input >> extra) ||
                !std::regex_match(hex, std::regex{"[0-9a-fA-F]{6}"}) ||
                (pulse != "0" && pulse != "1") || (frame != "0" && frame != "1"))
                return std::string{"refused: six hex colour digits and binary pulse/frame flags required"};
            const auto rgb = std::stoul(hex, nullptr, 16);
            const std::array<double, 3> color{((rgb >> 16) & 255) / 255.0, ((rgb >> 8) & 255) / 255.0, (rgb & 255) / 255.0};
            if (color != indicatorColor || (pulse == "1") != indicatorPulse || (frame == "1") != indicatorFrame) {
                indicatorColor = color; indicatorPulse = pulse == "1"; indicatorFrame = frame == "1";
                indicatorStyleDirty = true;
                for (const auto& monitor : State::monitorState()->monitors()) g_pHyprRenderer->damageMonitor(monitor);
            }
            return std::string{"ok"};
        }});
    registerCtl(SHyprCtlCommand{"ghost-workspace-present", false,
        [](eHyprCtlOutputFormat, std::string request) {
            std::istringstream input(request);
            std::string command, name, extra;
            int64_t id = 0;
            if (!(input >> command >> id >> name) || (input >> extra) || id <= 0)
                return std::string{"refused: numbered workspace and exact monitor name required"};
            try {
                presentWorkspace(findNumberedWorkspace(id), State::monitorState()->query().name(name).run());
                return std::string{"ok"};
            } catch (const PresentationNotReady& error) { return std::string{"not-ready: "} + error.what(); }
            catch (const std::exception& error) { return std::string{"refused: "} + error.what(); }
        }});
    registerCtl(SHyprCtlCommand{"ghost-admission", false,
        [](eHyprCtlOutputFormat, std::string request) {
            if (request == "ghost-admission pause")
                admissionPaused = true;
            else if (request == "ghost-admission resume")
                admissionPaused = false;
            else
                return std::string{"refused: admission requires pause or resume"};
            return std::string{admissionPaused ? "ok paused" : "ok running"};
        }});
    registerCtl(SHyprCtlCommand{"ghost-opening", false,
        [](eHyprCtlOutputFormat, std::string request) {
            std::istringstream input(request);
            std::string command, operation, token, extra;
            if (!(input >> command >> operation >> token) || (input >> extra))
                return std::string{"refused: opening requires an operation and exact token"};
            try { return openingRequest(operation, token); }
            catch (const std::exception& error) { return std::string{"refused: "} + error.what(); }
        }});
    registerCtl(SHyprCtlCommand{"ghost-unload-info", false,
        [](eHyprCtlOutputFormat, std::string request) {
            if (request != "ghost-unload-info")
                return std::string{"refused: unload-info takes no arguments"};
            try {
                const auto roots = liveRootCount();
                bool empty = true;
                for (const auto& [unit, scope] : retainedScopes)
                    if (!scope->empty())
                        empty = false;
                const bool ready = admissionPaused && roots == 0 && empty && !legacyEnrollmentOccurred &&
                    applicationLeases.empty();
                return std::format("{{\"schema\":1,\"admission_paused\":{},\"live_roots\":{},\"tracked_scopes\":{},\"scopes_empty\":{},\"legacy_enrollment\":{},\"ready\":{}}}",
                                   admissionPaused, roots, retainedScopes.size(), empty, legacyEnrollmentOccurred, ready);
            } catch (const std::exception& error) {
                return std::string{"refused: unload readiness unavailable: "} + error.what();
            }
        }});
    registerCtl(SHyprCtlCommand{"ghost-register-scope-process", false,
        [](eHyprCtlOutputFormat, std::string request) {
            if (admissionPaused)
                return std::string{"refused: native admission is paused"};
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
                auto scope = std::make_unique<RetainedScope>(unit);
                if (const auto old = retainedScopes.find(unit); old != retainedScopes.end()) {
                    if (!old->second->sameAs(*scope))
                        throw std::runtime_error("retained native scope was replaced");
                } else {
                    if (retainedScopes.size() >= 128)
                        throw std::runtime_error("retained native scope limit reached");
                    retainedScopes.emplace(unit, std::move(scope));
                }
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
    registerCtl(SHyprCtlCommand{"ghost-register-process", false,
        [](eHyprCtlOutputFormat, std::string request) {
            if (admissionPaused)
                return std::string{"refused: native admission is paused"};
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
            legacyEnrollmentOccurred = true;
            return std::string{"ok"};
        }});
    registerCtl(SHyprCtlCommand{"ghost-selection-diagnostic", false,
        [](eHyprCtlOutputFormat, std::string) { return std::string{"shared owner clipboard and primary selection"}; }});
    registerCtl(SHyprCtlCommand{"ghost-target-check", false, [](eHyprCtlOutputFormat, std::string r) {
        std::istringstream in(r);
        std::string command, address, extra;
        if (!(in >> command >> address) || (in >> extra) || address.find('@') == std::string::npos)
            return std::string{"refused: guarded target required"};
        const auto target = resolve(address, false);
        return target.error.empty() ? std::string{"ok"} : target.error;
    }});
    registerCtl(SHyprCtlCommand{"ghost-window-close", false, [](eHyprCtlOutputFormat, std::string request) {
        std::istringstream input(request);
        std::string command, handle, extra;
        if (!(input >> command >> handle) || (input >> extra) || handle.find('@') == std::string::npos)
            return std::string{"refused: exact guarded window target required"};
        auto target = resolve(handle, false);
        if (!target.error.empty()) return target.error;
        auto xdg = windowXdg(target.window);
        if (!xdg || !xdg->m_toplevel) return std::string{"target has no native close request"};
        // Ask this exact toplevel to close normally. The application owns its
        // unsaved-content prompt and can decline. Never terminate its process.
        xdg->m_toplevel->close();
        return std::string{"ok"};
    }});
    registerCtl(SHyprCtlCommand{"ghost-state", false, [](eHyprCtlOutputFormat, std::string r) {
        std::istringstream in(r);
        std::string cmd, address;
        in >> cmd >> address;
        auto target = resolve(address, false);
        if (!target.error.empty())
            return target.error;
        auto xdg = windowXdg(target.window);
        if (!xdg || !xdg->m_toplevel)
            return std::string{"state unavailable: target is not an XDG toplevel"};
        const auto& states = xdg->m_toplevel->m_pendingApply.states;
        const bool suspended = std::ranges::find(states, XDG_TOPLEVEL_STATE_SUSPENDED) != states.end();
        const auto geometry = xdg->m_current.geometry;
        const auto goal = target.window->size(Desktop::View::IGeometric::GEOMETRIC_GOAL);
        const auto surface = target.surface->m_current.size;
        return std::format("{{\"suspended\":{},\"render_unfocused\":{},\"window\":[{},{}],\"surface\":[{},{}],\"geometry\":[{},{},{},{}],\"motion_active\":{},\"motion_ms\":{}}}",
            suspended ? "true" : "false",
            target.window->m_ruleApplicator->renderUnfocused().valueOrDefault() ? "true" : "false",
            goal.x, goal.y, surface.x, surface.y, geometry.x, geometry.y, geometry.w, geometry.h,
            pumps.contains(address) ? "true" : "false", static_cast<int>(pumpRemainingSeconds(address) * 1000));
    }});
    registerCtl(SHyprCtlCommand{"ghost-keyboard-prepare", false, cmdKeyboardPreparation});
    registerCtl(SHyprCtlCommand{"ghost-keyboard-cancel", false, cmdKeyboardPreparation});
    registerCtl(SHyprCtlCommand{"ghost-key-prepared", false, cmdKey});
    registerCtl(SHyprCtlCommand{"ghost-texthex-prepared", false, cmdType});
    registerCtl(SHyprCtlCommand{"ghost-type", false, cmdType});
    registerCtl(SHyprCtlCommand{"ghost-texthex", false, cmdType});
    registerCtl(SHyprCtlCommand{"ghost-key", false, cmdKey});
    registerCtl(SHyprCtlCommand{"ghost-click", false, [](eHyprCtlOutputFormat, std::string r) { return pointerCmd(r, 1); }});
    holdTimer = makeShared<CEventLoopTimer>(std::nullopt, [](SP<CEventLoopTimer>, void*) { sweepPointerHolds(); }, nullptr);
    g_pEventLoopManager->addTimer(holdTimer);
    leaseReapTimer = makeShared<CEventLoopTimer>(std::chrono::seconds(5), [](SP<CEventLoopTimer> self, void*) {
        reapDeadOwnerLeases();
        self->updateTimeout(std::chrono::seconds(5));
        g_pEventLoopManager->scheduleRecalc();
    }, nullptr);
    g_pEventLoopManager->addTimer(leaseReapTimer);
    registerCtl(SHyprCtlCommand{"ghost-move", false, [](eHyprCtlOutputFormat, std::string r) { return pointerCmd(r, 0); }});
    registerCtl(SHyprCtlCommand{"ghost-mouse-down", false, [](eHyprCtlOutputFormat, std::string r) { return pointerCmd(r, 4); }});
    registerCtl(SHyprCtlCommand{"ghost-mouse-up", false, [](eHyprCtlOutputFormat, std::string r) { return pointerCmd(r, 5); }});
    registerCtl(SHyprCtlCommand{"ghost-drag", false, [](eHyprCtlOutputFormat, std::string r) { return dragCmd(r); }});
    registerCtl(SHyprCtlCommand{"ghost-scroll", false, [](eHyprCtlOutputFormat, std::string r) { return pointerCmd(r, 2); }});
    registerCtl(SHyprCtlCommand{"ghost-release", false, [](eHyprCtlOutputFormat, std::string r) {
        std::istringstream in(r);
        std::string cmd, address;
        in >> cmd >> address;
        auto target = resolve(address);
        if (!target.error.empty())
            return target.error;
        cancelKeyboardClient(target.surface->client());
        for (const auto& weak : target.seat->m_pointers) {
            if (auto pointer = weak.lock()) {
                if (!scrollPointers.contains(pointer.get()))
                    continue;
                returnClientPointer(pointer, target.surface->client());
                scrollPointers.erase(pointer.get());
            }
        }
        for (const auto& weak : target.seat->m_keyboards) {
            if (auto keyboard = weak.lock()) {
                if (!agentKeyboards.contains(keyboard.get()))
                    continue;
                returnClientKeyboard(keyboard, target.surface->client());
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
    registerCtl(SHyprCtlCommand{"ghost-cursor", false, [](eHyprCtlOutputFormat, std::string r) { return pointerCmd(r, 3); }});
    registerCtl(SHyprCtlCommand{"ghost-hide-cursor", false, [](eHyprCtlOutputFormat, std::string r) {
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
    if (!applicationLeases.empty())
        throw std::runtime_error("active application leases must be handed back before unload");
    if (!g_pSeatManager || !g_pHyprRenderer || !PROTO::data || !PROTO::primarySelection)
        throw std::runtime_error("native cleanup protocols are unavailable; cleanup remains incomplete");
    keyboardPreparations.clear();
    keyboardSequences.clear();
    removeApplicationHooks();
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
        if (!pointer) continue;
        if (const auto held = pointerHolds.find(pointer.get()); held != pointerHolds.end())
            for (const uint32_t button : held->second.buttons) {
                pointer->sendButton(nowMs(), button, WL_POINTER_BUTTON_STATE_RELEASED);
                pointer->sendFrame();
            }
        auto focus = g_pSeatManager->m_state.pointerFocus.lock();
        if (!pointer->m_owner ||
            (focus && focus->client() == pointer->m_owner->client()))
            continue;
        pointer->sendLeave();
        pointer->sendFrame();
    }
    scrollPointers.clear();
    pointerHolds.clear();
    if (holdTimer) g_pEventLoopManager->removeTimer(holdTimer);
    holdTimer.reset();
    if (leaseReapTimer) g_pEventLoopManager->removeTimer(leaseReapTimer);
    leaseReapTimer.reset();
    if (pumpTimer) g_pEventLoopManager->removeTimer(pumpTimer);
    pumpTimer.reset();
    pumps.clear();
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
    clickTexture.reset();
    for (auto& texture : frameTextures) texture.reset();
    workspaceLabels.clear();
    agentKeyboard.reset();
    for (const auto& [pid, fd] : registeredProcesses)
        close(fd);
    registeredProcesses.clear();
    scopedProcesses.clear();
    retainedScopes.clear();
    admissionPaused = false;
    legacyEnrollmentOccurred = false;
}
