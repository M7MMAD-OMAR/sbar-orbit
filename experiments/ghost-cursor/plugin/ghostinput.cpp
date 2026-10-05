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
#include <chrono>
#include <sstream>
#include <hyprland/src/plugins/PluginAPI.hpp>
// Load generated request storage before other protocol headers include it.
#define private public
#include <hyprland/protocols/wayland.hpp>
#undef private
#include <hyprland/src/desktop/state/WindowState.hpp>
#define private public
#include <hyprland/src/desktop/rule/windowRule/WindowRuleApplicator.hpp>
#undef private
#include <hyprland/src/desktop/view/Window.hpp>
#include <hyprland/src/desktop/Workspace.hpp>
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
#include <hyprland/src/render/Renderer.hpp>
#undef protected
#include <hyprland/src/render/pass/TexPassElement.hpp>
#include <hyprland/src/render/Texture.hpp>
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
#include <cstring>
#include <fstream>
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
    decltype(std::declval<CWlDataDevice>().requests.startDrag) originalStartDrag;
    wl_listener destroy{};
};
static std::map<wl_resource*, SClipboardGuard> clipboardGuards;
static std::map<wl_client*, wl_listener> selectionClients;

template <typename Device>
struct SDataControlGuard {
    Device* device = nullptr;
    decltype(std::declval<Device>().requests.setSelection) original;
    decltype(std::declval<Device>().requests.setPrimarySelection) originalPrimary;
    wl_listener destroy{};
};
static std::map<wl_resource*, SDataControlGuard<CZwlrDataControlDeviceV1>> wlrGuards;
static std::map<wl_resource*, SDataControlGuard<CExtDataControlDeviceV1>> extGuards;
static wl_protocol_logger* selectionLogger = nullptr;
static std::string selectionDiagnostic;
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
};
struct SApplicationLease {
    wl_client* client = nullptr;
    wl_listener destroy{};
    bool paused = false;
    std::array<char, 256> failure{};
    std::array<char, 256> claimFailure{};
    std::map<uint64_t, SLeasedWindow> windows;
    std::string homeWorkspace;
    std::string homeWorkspaceRule;
    std::string id;
};
static std::map<std::string, std::unique_ptr<SApplicationLease>> applicationLeases;
static std::set<std::string> retiredApplicationLeases;
static SApplicationLease* applicationLeaseForClient(wl_client* client) {
    for (auto& [id, lease] : applicationLeases)
        if (lease->client == client)
            return lease.get();
    return nullptr;
}
static void recordApplicationFailure(wl_client* client, const char* reason) noexcept {
    if (auto lease = applicationLeaseForClient(client)) {
        lease->paused = true;
        std::snprintf(lease->failure.data(), lease->failure.size(), "%s", reason);
    }
}

static void retainApplicationWindow(SApplicationLease& lease, PHLWINDOW window, bool createdWhileLeased = false) {
    std::erase_if(lease.windows, [](const auto& entry) { return !entry.second.window.lock(); });
    if (lease.windows.contains(window->m_stableID)) return;
    if (lease.windows.size() >= 64) throw std::runtime_error("application window bound reached");
    using namespace Desktop::Types;
    auto saved = [](const COverridableVar<bool>& property) -> std::optional<bool> {
        return property.hasValue() && property.getPriority() == PRIORITY_SET_PROP ? std::optional<bool>{property.value()} : std::nullopt;
    };
    lease.windows.emplace(window->m_stableID, SLeasedWindow{window,
        saved(window->m_ruleApplicator->renderUnfocused()), saved(window->m_ruleApplicator->focusOnActivate()),
        std::ranges::find(g_pHyprRenderer->m_renderUnfocused, window) != g_pHyprRenderer->m_renderUnfocused.end(),
        createdWhileLeased, window->m_ruleApplicator->static_.noInitialFocus, window->m_ruleApplicator->static_.workspace});
}
static void applyApplicationWindow(PHLWINDOW window) {
    using namespace Desktop::Types;
    window->m_ruleApplicator->renderUnfocused().set(true, PRIORITY_SET_PROP);
    g_pHyprRenderer->addWindowToRenderUnfocused(window);
    window->m_ruleApplicator->focusOnActivate().set(false, PRIORITY_SET_PROP);
}

// The compositor's global offer invalidation must never visit agent offers.
// Fixed slots keep Wayland destroy-listener addresses stable without allocation.
template <typename Offer, size_t Capacity = 128>
class CPrivateOffers {
    struct SListener {
        wl_listener listener{};
        CPrivateOffers* owner = nullptr;
        size_t index = 0;
    };
    static_assert(std::is_standard_layout_v<SListener>);
    using DestroyHandler = decltype(std::declval<Offer>().m_resource->requests.destroy);
    struct SSlot {
        SP<Offer> offer;
        wl_client* client = nullptr;
        SListener destroy{};
        DestroyHandler originalDestroy;
        std::array<char, 33> leaseId{};
    };
    std::array<SSlot, Capacity> slots{};
  public:
    CPrivateOffers() {
        for (size_t index = 0; index < Capacity; ++index) {
            slots[index].destroy.owner = this;
            slots[index].destroy.index = index;
        }
    }
    CPrivateOffers(const CPrivateOffers&) = delete;
    CPrivateOffers& operator=(const CPrivateOffers&) = delete;
    size_t available() const {
        return std::ranges::count_if(slots, [](const auto& slot) { return !slot.offer; });
    }
    void invalidate(wl_client* client) noexcept {
        for (auto& slot : slots)
            if (slot.offer && slot.client == client)
                slot.offer->m_dead = true;
    }
    void retainLast(std::vector<SP<Offer>>& global, size_t before, wl_client* client, std::string_view leaseId = {}) {
        if (!leaseId.empty() && leaseId.size() != 32) throw std::runtime_error("invalid private offer lease identity");
        if (global.size() == before)
            return;
        if (global.size() != before + 1 || global.back()->m_resource->client() != client)
            throw std::runtime_error("private offer construction changed namespace");
        for (size_t index = 0; index < Capacity; ++index) {
            auto& slot = slots[index];
            if (slot.offer)
                continue;
            auto originalDestroy = global.back()->m_resource->requests.destroy;
            DestroyHandler privateDestroy = [this, index](auto* wrapper) {
                auto& retained = slots[index];
                if (!retained.offer || retained.offer->m_resource.get() != wrapper)
                    return;
                // Keep the executing callback alive until native destruction returns.
                auto resource = retained.offer->m_resource;
                if (auto native = resource->resource())
                    wl_resource_destroy(native);
            };
            slot.originalDestroy = std::move(originalDestroy);
            slot.offer = global.back();
            slot.client = client;
            std::copy(leaseId.begin(), leaseId.end(), slot.leaseId.begin());
            slot.leaseId[leaseId.size()] = 0;
            slot.offer->m_resource->requests.destroy = std::move(privateDestroy);
            slot.destroy.listener.notify = [](wl_listener* listener, void*) {
                auto* context = reinterpret_cast<SListener*>(listener);
                auto& retained = context->owner->slots[context->index];
                wl_list_remove(&listener->link);
                retained.client = nullptr;
                retained.originalDestroy = {};
                retained.offer.reset();
            };
            wl_resource_add_destroy_listener(slot.offer->m_resource->resource(), &slot.destroy.listener);
            global.pop_back();
            return;
        }
        throw std::runtime_error("private offer capacity exhausted");
    }
    void retire(wl_client* client, std::vector<SP<Offer>>& global, std::string_view leaseId = {}) {
        size_t count = 0;
        for (const auto& slot : slots)
            if (slot.offer && (!client || slot.client == client) && (leaseId.empty() || std::string_view{slot.leaseId.data()} == leaseId))
                ++count;
        global.reserve(global.size() + count);
        for (auto& slot : slots) {
            if (!slot.offer || (client && slot.client != client) || (!leaseId.empty() && std::string_view{slot.leaseId.data()} != leaseId))
                continue;
            slot.offer->m_dead = true;
            wl_list_remove(&slot.destroy.listener.link);
            slot.offer->m_resource->requests.destroy = std::move(slot.originalDestroy);
            global.push_back(slot.offer);
            slot.offer.reset();
            slot.client = nullptr;
        }
    }
};
static CPrivateOffers<CWLDataOfferResource> privateClipboardOffers;
static CPrivateOffers<CPrimarySelectionOffer> privatePrimaryOffers;

static void sendPrivateClipboardSelection(wl_client* client, SP<IDataSource> source) {
    const auto devices = std::ranges::count_if(PROTO::data->m_devices,
        [client](const auto& device) { return device->client() == client; });
    if (source && privateClipboardOffers.available() < static_cast<size_t>(devices))
        throw std::runtime_error("private clipboard offer limit reached");
    for (const auto& target : PROTO::data->m_devices) {
        if (target->client() != client)
            continue;
        const auto before = PROTO::data->m_offers.size();
        PROTO::data->sendSelectionToDevice(target, source);
        privateClipboardOffers.retainLast(PROTO::data->m_offers, before, client, applicationLeaseForClient(client)->id);
    }
}
static void sendPrivatePrimarySelection(wl_client* client, SP<IDataSource> source) {
    const auto devices = std::ranges::count_if(PROTO::primarySelection->m_devices,
        [client](const auto& device) { return device->client() == client; });
    if (source && privatePrimaryOffers.available() < static_cast<size_t>(devices))
        throw std::runtime_error("private primary offer limit reached");
    for (const auto& target : PROTO::primarySelection->m_devices) {
        if (target->client() != client)
            continue;
        const auto before = PROTO::primarySelection->m_offers.size();
        PROTO::primarySelection->sendSelectionToDevice(target, source);
        privatePrimaryOffers.retainLast(PROTO::primarySelection->m_offers, before, client, applicationLeaseForClient(client)->id);
    }
}
static size_t liveRootCount() {
    std::map<pid_t, bool> roots;
    for (const auto& [pid, identity] : scopedProcesses)
        if (identity->live())
            roots[pid] = true;
    for (const auto& [pid, descriptor] : registeredProcesses)
        if (ScopedProcess::descriptorLive(descriptor))
            roots[pid] = true;
    return roots.size();
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
    if (applicationLeaseForClient(client))
        return true;
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

static bool privateSelectionClient(wl_client* client) {
    if (selectionClients.contains(client))
        return true;
    if (!agentClient(client))
        return false;
    auto [it, inserted] = selectionClients.try_emplace(client);
    it->second.notify = [](wl_listener* listener, void* data) {
        wl_list_remove(&listener->link);
        selectionClients.erase(static_cast<wl_client*>(data));
    };
    wl_client_add_destroy_listener(client, &it->second);
    return true;
}

static void clearSelectionClients() {
    for (auto& [client, listener] : selectionClients)
        wl_list_remove(&listener.link);
    selectionClients.clear();
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

static void guardPrimarySelection(wl_client* client) {
    if (!privateSelectionClient(client))
        return;
    for (const auto& device : PROTO::primarySelection->m_devices) {
        if (device->client() != client)
            continue;
        installSelectionGuard(device->m_resource.get(), primaryGuards, [](wl_listener* listener, void* data) {
            wl_list_remove(&listener->link);
            primaryGuards.erase(static_cast<wl_resource*>(data));
        }, [](auto* raw, auto) {
          raw->setSetSelection([](CZwpPrimarySelectionDeviceV1* current, wl_resource* sourceR, uint32_t) {
            // Existing-application leases need a functioning private PRIMARY namespace.
            if (!applicationLeaseForClient(current->client()))
                return;
            auto source = sourceR ? CPrimarySelectionSource::fromResource(sourceR) : SP<CPrimarySelectionSource>{};
            try { sendPrivatePrimarySelection(current->client(), source); }
            catch (const std::exception& error) { recordApplicationFailure(current->client(), error.what()); }
            catch (...) { recordApplicationFailure(current->client(), "private PRIMARY offer failed"); }
          });
        });
    }
}

static void guardClipboard(wl_client* client) {
    if (!privateSelectionClient(client))
        return;
    for (const auto& device : PROTO::data->m_devices) {
        if (device->client() != client)
            continue;
        installSelectionGuard(device->m_resource.get(), clipboardGuards, [](wl_listener* listener, void* data) {
            wl_list_remove(&listener->link);
            clipboardGuards.erase(static_cast<wl_resource*>(data));
        }, [](auto* raw, auto) {
          const auto originalDrag = raw->requests.startDrag;
          raw->requests.startDrag = [originalDrag](CWlDataDevice* device, wl_resource* source, wl_resource* origin, wl_resource* icon, uint32_t serial) {
            if (applicationLeaseForClient(device->client())) {
                recordApplicationFailure(device->client(), "shared drag is unsupported during application handoff");
                return;
            }
            originalDrag(device, source, origin, icon, serial);
          };
          raw->setSetSelection([](CWlDataDevice* current, wl_resource* sourceR, uint32_t) {
            auto source = sourceR ? CWLDataSourceResource::fromResource(sourceR) : SP<CWLDataSourceResource>{};
            if (source)
                source->markUsed();
            // Offers are client-local. Do not change the seat selection or invalidate owner offers.
            if (auto lease = applicationLeaseForClient(current->client())) {
                try { sendPrivateClipboardSelection(current->client(), source); }
                catch (const std::exception& error) { recordApplicationFailure(current->client(), error.what()); }
                catch (...) { recordApplicationFailure(current->client(), "private clipboard offer failed"); }
            } else {
                for (const auto& target : PROTO::data->m_devices)
                    if (target->client() == current->client())
                        PROTO::data->sendSelectionToDevice(target, source);
            }
          });
        });
    }
}


template <typename Device, typename Guards>
static void guardDataControl(Device* raw, Guards& guards) {
    auto client = raw->client();
    if (!applicationLeaseForClient(client) || guards.contains(raw->resource())) return;
    auto original = raw->requests.setSelection;
    auto originalPrimary = raw->requests.setPrimarySelection;
    auto [entry, inserted] = guards.try_emplace(raw->resource());
    auto& retained = entry->second;
    retained.device = raw;
    retained.original = std::move(original);
    retained.originalPrimary = std::move(originalPrimary);
    retained.destroy.notify = [](wl_listener* listener, void* resource) {
        wl_list_remove(&listener->link);
        if constexpr (std::is_same_v<Device, CZwlrDataControlDeviceV1>)
            wlrGuards.erase(static_cast<wl_resource*>(resource));
        else extGuards.erase(static_cast<wl_resource*>(resource));
    };
    wl_resource_add_destroy_listener(raw->resource(), &retained.destroy);
    raw->requests.setSelection = [](Device* device, wl_resource*) {
        recordApplicationFailure(device->client(), "data-control is unsupported during application handoff");
    };
    raw->requests.setPrimarySelection = raw->requests.setSelection;
    recordApplicationFailure(client, "data-control is unsupported during application handoff");
}
template <typename Guards>
static void restoreDataControlGuards(Guards& guards, wl_client* client) {
    for (auto entry = guards.begin(); entry != guards.end();) {
        if (client && entry->second.device->client() != client) { ++entry; continue; }
        entry->second.device->requests.setSelection = std::move(entry->second.original);
        entry->second.device->requests.setPrimarySelection = std::move(entry->second.originalPrimary);
        wl_list_remove(&entry->second.destroy.link);
        entry = guards.erase(entry);
    }
}
static void selectionRequest(void*, wl_protocol_logger_type direction, const wl_protocol_logger_message* message) {
    if (direction != WL_PROTOCOL_LOGGER_REQUEST ||
        (std::strcmp(message->message->name, "set_selection") != 0 && std::strcmp(message->message->name, "set_primary_selection") != 0 && std::strcmp(message->message->name, "start_drag") != 0))
        return;
    auto client = wl_resource_get_client(message->resource);
    if (!privateSelectionClient(client)) {
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
    if (std::strcmp(interface, "zwlr_data_control_device_v1") == 0)
        guardDataControl(static_cast<CZwlrDataControlDeviceV1*>(wl_resource_get_user_data(message->resource)), wlrGuards);
    else if (std::strcmp(interface, "ext_data_control_device_v1") == 0)
        guardDataControl(static_cast<CExtDataControlDeviceV1*>(wl_resource_get_user_data(message->resource)), extGuards);
    else if (std::strcmp(interface, "zwp_primary_selection_device_v1") == 0)
        guardPrimarySelection(client);
    else if (std::strcmp(interface, "wl_data_device") == 0)
        guardClipboard(client);
}


static bool leasedWindow(PHLWINDOW window) {
    auto surface = window ? window->resource() : SP<CWLSurfaceResource>{};
    auto lease = surface ? applicationLeaseForClient(surface->client()) : nullptr;
    if (!lease)
        return false;
    const auto retained = lease->windows.find(window->m_stableID);
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

static void handbackApplication(const std::string& id) {
    const auto found = applicationLeases.find(id);
    if (found == applicationLeases.end())
        throw std::runtime_error("application lease is unavailable");
    auto& lease = *found->second;
    lease.paused = true;
    // Keep dead offer resources valid until the toolkit destroys them. Normal
    // compositor focus sends the person's current selections after handback.
    privateClipboardOffers.invalidate(lease.client);
    privatePrimaryOffers.invalidate(lease.client);
    auto seat = g_pSeatManager->seatResourceForClient(lease.client);
    if (seat) {
        for (const auto& weak : seat->m_pointers)
            if (auto pointer = weak.lock(); pointer && scrollPointers.contains(pointer.get())) {
                pointer->sendLeave(); pointer->sendFrame(); scrollPointers.erase(pointer.get());
            }
        for (const auto& weak : seat->m_keyboards)
            if (auto keyboard = weak.lock(); keyboard && agentKeyboards.contains(keyboard.get())) {
                keyboard->sendLeave();
                keyboard->sendKeymap(g_pSeatManager->m_keyboard.lock());
                agentKeyboards.erase(keyboard.get());
            }
    }
    restoreDataControlGuards(wlrGuards, lease.client);
    restoreDataControlGuards(extGuards, lease.client);
    restoreClientSelectionGuards(primaryGuards, lease.client);
    restoreClientSelectionGuards(clipboardGuards, lease.client);
    if (auto retained = selectionClients.find(lease.client); retained != selectionClients.end()) {
        wl_list_remove(&retained->second.link); selectionClients.erase(retained);
    }
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
        if (!window || window->m_stableID != stable) continue;
        using namespace Desktop::Types;
        window->m_ruleApplicator->renderUnfocused().matchOptional(retained.renderUnfocused, PRIORITY_SET_PROP);
        // Upstream only prunes false properties when another entry expires.
        // Restore exact membership so handback cannot leave a background timer running.
        if (!retained.backgroundRenderingRegistered)
            std::erase_if(g_pHyprRenderer->m_renderUnfocused, [&](const auto& entry) { return entry.lock() == window; });
        window->m_ruleApplicator->focusOnActivate().matchOptional(retained.focusOnActivate, PRIORITY_SET_PROP);
        window->m_ruleApplicator->static_.noInitialFocus = retained.noInitialFocus;
        window->m_ruleApplicator->static_.workspace = std::move(retained.originalWorkspace);
    }
    for (auto awake = awakeWindows.begin(); awake != awakeWindows.end();) {
        const auto marker = awake->first.rfind("@lease-");
        if (marker == std::string::npos || std::string_view{awake->first}.substr(marker + 7) != id) { ++awake; continue; }
        if (auto window = awake->second.lock(); window && window->m_isMapped && !g_pHyprRenderer->shouldRenderWindow(window))
            window->setSuspended(true);
        awake = awakeWindows.erase(awake);
    }
    wl_list_remove(&lease.destroy.link);
    applicationLeases.erase(found);
}

static bool sourceBelongsToClient(SP<IDataSource> source, wl_client* client) {
    if (!source) return false;
    if (const auto wayland = dynamic_cast<CWLDataSourceResource*>(source.get()))
        return wayland->m_resource->client() == client;
    if (const auto primary = dynamic_cast<CPrimarySelectionSource*>(source.get()))
        return primary->m_resource->client() == client;
    if (const auto wlr = dynamic_cast<CWLRDataSource*>(source.get()))
        return wlr->m_resource->client() == client;
    if (const auto ext = dynamic_cast<CExtDataSource*>(source.get()))
        return ext->m_resource->client() == client;
    return false;
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
        if (!window || !window->m_isMapped || window->m_stableID != stable || !surface || surface->client() != lease.client) continue;
        if (!first) windows += ',';
        first = false;
        windows += std::format("{{\"address\":\"0x{:x}\",\"stable\":\"{:x}\",\"target\":\"0x{:x}@{:x}@lease-{}\"}}",
            reinterpret_cast<uintptr_t>(window.get()), stable, reinterpret_cast<uintptr_t>(window.get()), stable, id);
    }
    windows += ']';
    return std::format("{{\"schema\":1,\"status\":\"{}\",\"lease_id\":\"{}\",\"scope\":\"entire-wayland-client\",\"windows\":{},\"failure\":{},\"claim_failure\":{}}}",
        lease.paused ? "paused" : "active", id, windows, applicationJsonString(lease.failure.data()), applicationJsonString(lease.claimFailure.data()));
}
static std::string claimApplication(const std::string& address, const std::string& stable, const std::string& id) {
    if (admissionPaused)
        throw std::runtime_error("native admission is paused");
    if (!std::regex_match(address, std::regex{"0x[0-9a-f]{1,16}"}) ||
        !std::regex_match(stable, std::regex{"[0-9a-f]{1,16}"}))
        throw std::runtime_error("existing application needs an exact window identity");
    PHLWINDOW selected;
    for (const auto& window : Desktop::windowState()->windows())
        if (std::format("0x{:x}", reinterpret_cast<uintptr_t>(window.get())) == address &&
            std::format("{:x}", window->m_stableID) == stable)
            selected = window;
    auto surface = selected ? selected->resource() : SP<CWLSurfaceResource>{};
    if (!selected || !selected->m_isMapped || !selected->m_workspace || !surface || selected->m_isX11)
        throw std::runtime_error("existing application target is unavailable or unsupported");
    auto client = surface->client();
    auto keyboard = g_pSeatManager->m_state.keyboardFocus.lock();
    auto pointer = g_pSeatManager->m_state.pointerFocus.lock();
    if ((keyboard && keyboard->client() == client) || (pointer && pointer->client() == client))
        throw std::runtime_error("switch to another application before handoff");
    if (g_pSeatManager->m_seatGrab || PROTO::data->dndActive())
        throw std::runtime_error("handoff is unsupported during a grab or drag");
    if ((PROTO::dataWlr && PROTO::dataWlr->dataDeviceForClient(client)) ||
        (PROTO::extDataDevice && PROTO::extDataDevice->dataDeviceForClient(client)))
        throw std::runtime_error("existing application uses unsupported data-control devices");
    if (sourceBelongsToClient(g_pSeatManager->m_selection.currentSelection.lock(), client) ||
        sourceBelongsToClient(g_pSeatManager->m_selection.currentPrimarySelection.lock(), client))
        throw std::runtime_error("handoff is unsupported while this client owns a global selection source");
    if (applicationLeaseForClient(client) || applicationLeases.size() >= 16 || retiredApplicationLeases.size() >= 1024)
        throw std::runtime_error("application lease already exists or lease bound reached");
    auto retained = std::make_unique<SApplicationLease>();
    retained->client = client;
    retained->id = id;
    retained->homeWorkspace = selected->m_workspace->m_name;
    retained->homeWorkspaceRule = retained->homeWorkspace + " silent";
    for (const auto& window : Desktop::windowState()->windows()) {
        auto resource = window->resource();
        if (window->m_isMapped && resource && resource->client() == client) {
            if (window->m_isX11 || !window->m_xdgSurface || retained->windows.size() >= 64)
                throw std::runtime_error("client includes unsupported targets");
            retainApplicationWindow(*retained, window);
        }
    }
    if (!std::regex_match(id, std::regex{"[0-9a-fA-F]{32}"}) || retiredApplicationLeases.contains(id))
        throw std::runtime_error("cannot mint application lease identity");
    auto success = std::format("{{\"schema\":1,\"status\":\"claimed\",\"lease_id\":\"{}\",\"scope\":\"entire-wayland-client\",\"windows\":{}}}", id, retained->windows.size());
    auto recoverableFailure = std::format("{{\"schema\":1,\"status\":\"recovery_required\",\"lease_id\":\"{}\",\"error\":\"claim_failed_handback_incomplete\"}}", id);
    retiredApplicationLeases.insert(id);
    auto [entry, inserted] = applicationLeases.emplace(id, std::move(retained));
    auto& lease = *entry->second;
    lease.destroy.notify = [](wl_listener* listener, void* destroyed) {
        wl_list_remove(&listener->link);
        for (auto entry = applicationLeases.begin(); entry != applicationLeases.end(); ++entry)
            if (entry->second->client == destroyed) { clearApplicationCursors(entry->first); applicationLeases.erase(entry); return; }
    };
    wl_client_add_destroy_listener(client, &lease.destroy);
    try {
        for (const auto& [stable, retainedWindow] : lease.windows)
            if (auto window = retainedWindow.window.lock()) applyApplicationWindow(window);
        guardPrimarySelection(client); guardClipboard(client);
        // Remove incoming person offers from this client's private context only.
        for (const auto& offer : PROTO::data->m_offers)
            if (offer->m_resource->client() == client) offer->m_dead = true;
        for (const auto& offer : PROTO::primarySelection->m_offers)
            if (offer->m_resource->client() == client) offer->m_dead = true;
        sendPrivateClipboardSelection(client, {}); sendPrivatePrimarySelection(client, {});
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
static CFunctionHook* pointerFocusHook = nullptr;
static CFunctionHook* popupGrabHook = nullptr;
static CFunctionHook* staticRulesHook = nullptr;
static CFunctionHook* staticRecheckHook = nullptr;
static CFunctionHook* wlrSelectionHook = nullptr;
static CFunctionHook* extSelectionHook = nullptr;

static void handbackFocusedApplication(SP<CWLSurfaceResource> surface) {
    if (!surface) return;
    for (const auto& [id, lease] : applicationLeases)
        if (lease->client == surface->client()) {
            handbackApplication(id);
            return;
        }
}
static void beforeKeyboardFocus(CSeatManager* manager, SP<CWLSurfaceResource> surface) {
    handbackFocusedApplication(surface);
    using Original = void (*)(CSeatManager*, SP<CWLSurfaceResource>);
    reinterpret_cast<Original>(keyboardFocusHook->m_original)(manager, std::move(surface));
}
static void beforePointerFocus(CSeatManager* manager, SP<CWLSurfaceResource> surface, const Vector2D& local) {
    handbackFocusedApplication(surface);
    using Original = void (*)(CSeatManager*, SP<CWLSurfaceResource>, const Vector2D&);
    reinterpret_cast<Original>(pointerFocusHook->m_original)(manager, std::move(surface), local);
}
static void privatePopupGrab(CXDGShellProtocol* protocol, SP<CXDGPopupResource> popup) {
    auto xdg = popup ? popup->m_surface.lock() : SP<CXDGSurfaceResource>{};
    auto surface = xdg ? xdg->m_surface.lock() : SP<CWLSurfaceResource>{};
    if (surface && applicationLeaseForClient(surface->client()))
        return; // Client-local actor input never acquires the person's shared grab.
    using Original = void (*)(CXDGShellProtocol*, SP<CXDGPopupResource>);
    reinterpret_cast<Original>(popupGrabHook->m_original)(protocol, std::move(popup));
}

static void enforceApplicationRules(Desktop::Rule::CWindowRuleApplicator* rules) {
    auto window = rules->m_window.lock();
    auto surface = window ? window->resource() : SP<CWLSurfaceResource>{};
    auto lease = surface ? applicationLeaseForClient(surface->client()) : nullptr;
    if (!lease) return;
    const auto existing = lease->windows.find(window->m_stableID);
    const bool newlyObserved = existing == lease->windows.end();
    const bool clampWorkspace = newlyObserved || existing->second.createdWhileLeased;
    std::string originalWorkspace;
    if (newlyObserved) originalWorkspace = std::move(rules->static_.workspace);
    try {
        // Place new same-client windows before bounded enrollment can refuse them.
        // Existing windows keep their original workspace throughout the lease.
        if (clampWorkspace) rules->static_.workspace = lease->homeWorkspaceRule;
        retainApplicationWindow(*lease, window, true);
        if (newlyObserved)
            lease->windows.at(window->m_stableID).originalWorkspace = std::move(originalWorkspace);
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
static void privateWlrSelection(CDataDeviceWLRProtocol* protocol, SP<CWLRDataDevice> device, SP<IDataSource> source, bool primary) {
    if (device && applicationLeaseForClient(device->client())) {
        recordApplicationFailure(device->client(), "data-control is unsupported during application handoff");
        return;
    }
    using Original = void (*)(CDataDeviceWLRProtocol*, SP<CWLRDataDevice>, SP<IDataSource>, bool);
    reinterpret_cast<Original>(wlrSelectionHook->m_original)(protocol, std::move(device), std::move(source), primary);
}
static void privateExtSelection(CExtDataDeviceProtocol* protocol, SP<CExtDataDevice> device, SP<IDataSource> source, bool primary) {
    if (device && applicationLeaseForClient(device->client())) {
        recordApplicationFailure(device->client(), "data-control is unsupported during application handoff");
        return;
    }
    using Original = void (*)(CExtDataDeviceProtocol*, SP<CExtDataDevice>, SP<IDataSource>, bool);
    reinterpret_cast<Original>(extSelectionHook->m_original)(protocol, std::move(device), std::move(source), primary);
}
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
    pointerFocusHook = applicationHook("CSeatManager::setPointerFocus", reinterpret_cast<void*>(beforePointerFocus));
    popupGrabHook = applicationHook("CXDGShellProtocol::addOrStartGrab", reinterpret_cast<void*>(privatePopupGrab));
    staticRulesHook = applicationHook("Desktop::Rule::CWindowRuleApplicator::readStaticRules", reinterpret_cast<void*>(privateStaticRules));
    staticRecheckHook = applicationHook("Desktop::Rule::CWindowRuleApplicator::recheckStaticRules", reinterpret_cast<void*>(privateStaticRecheck));
    wlrSelectionHook = applicationHook("CDataDeviceWLRProtocol::sendSelectionToDevice", reinterpret_cast<void*>(privateWlrSelection));
    extSelectionHook = applicationHook("CExtDataDeviceProtocol::sendSelectionToDevice", reinterpret_cast<void*>(privateExtSelection));
}
static void removeApplicationHooks() {
    for (auto slot : {&keyboardFocusHook, &pointerFocusHook, &popupGrabHook, &staticRulesHook, &staticRecheckHook, &wlrSelectionHook, &extSelectionHook}) {
        if (!*slot) continue;
        if (!HyprlandAPI::removeFunctionHook(PHANDLE, *slot))
            throw std::runtime_error("cannot remove application lifecycle hook");
        *slot = nullptr;
    }
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
        if (!w || !w->m_isMapped || !w->m_workspace || (w->m_workspace->m_name != AGENT_SPACE && !leasedWindow(w))) {
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
    if (!stable.empty() && std::format("{:x}", t.window->m_stableID) != stable) {
        t.error = "refused: native window stable identity changed";
        return t;
    }
    const bool applicationTarget = unit.starts_with("lease-");
    if (!t.window->m_isMapped || !t.window->m_workspace ||
        (!applicationTarget && t.window->m_workspace->m_name != AGENT_SPACE)) {
        t.error = "refused: window is not in " + AGENT_SPACE;
        t.window.reset();
        return t;
    }
    t.surface = t.window->resource();
    if (!t.surface) {
        t.error = "window has no surface";
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
    installApplicationHooks();
#ifdef ORBIT_PLUGIN_SOURCE_SHA256
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-build-info", false,
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
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-application-claim", false,
        [](eHyprCtlOutputFormat, std::string request) {
            std::istringstream input(request);
            std::string command, address, stable, id, extra;
            if (!(input >> command >> address >> stable >> id) || (input >> extra))
                return std::string{"refused: exact selected window address and stable identity required"};
            try { return claimApplication(address, stable, id); }
            catch (const std::exception& error) { return std::string{"refused: "} + error.what(); }
        }});

    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-application-info", false,
        [](eHyprCtlOutputFormat, std::string request) {
            std::istringstream input(request); std::string command, id, extra;
            if (!(input >> command >> id) || (input >> extra)) return std::string{"refused: application lease identity required"};
            try { return applicationInfo(id); }
            catch (const std::exception& error) { return std::string{"refused: "} + error.what(); }
        }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-application-reap", false,
        [](eHyprCtlOutputFormat, std::string request) {
            std::istringstream input(request); std::string command, id, extra;
            if (!(input >> command >> id) || (input >> extra) || !std::regex_match(id, std::regex{"[0-9a-f]{32}"}))
                return std::string{"refused: exact application lease identity required"};
            if (applicationLeases.contains(id)) return std::string{"refused: active application lease must be handed back first"};
            try {
                privateClipboardOffers.retire(nullptr, PROTO::data->m_offers, id);
                privatePrimaryOffers.retire(nullptr, PROTO::primarySelection->m_offers, id);
                return std::string{"ok"};
            } catch (const std::exception& error) { return std::string{"refused: "} + error.what(); }
        }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-application-control", false,
        [](eHyprCtlOutputFormat, std::string request) {
            std::istringstream input(request);
            std::string command, id, operation, extra;
            if (!(input >> command >> id >> operation) || (input >> extra))
                return std::string{"refused: application lease identity and operation required"};
            const auto found = applicationLeases.find(id);
            if (found == applicationLeases.end()) return std::string{operation == "handback" && retiredApplicationLeases.contains(id) ? "ok" : "refused: application lease unavailable"};
            try {
                if (operation == "pause") found->second->paused = true;
                else if (operation == "resume") {
                    if (found->second->failure.front()) return std::string{"refused: failed application lease requires handback"};
                    found->second->paused = false;
                }
                else if (operation == "handback") handbackApplication(id);
                else return std::string{"refused: unknown application lease operation"};
                return std::string{"ok"};
            } catch (const std::exception& error) { return std::string{"refused: "} + error.what(); }
        }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-admission", false,
        [](eHyprCtlOutputFormat, std::string request) {
            if (request == "ghost-admission pause")
                admissionPaused = true;
            else if (request == "ghost-admission resume")
                admissionPaused = false;
            else
                return std::string{"refused: admission requires pause or resume"};
            return std::string{admissionPaused ? "ok paused" : "ok running"};
        }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-unload-info", false,
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
                    applicationLeases.empty() && privateClipboardOffers.available() == 128 && privatePrimaryOffers.available() == 128;
                return std::format("{{\"schema\":1,\"admission_paused\":{},\"live_roots\":{},\"tracked_scopes\":{},\"scopes_empty\":{},\"legacy_enrollment\":{},\"ready\":{}}}",
                                   admissionPaused, roots, retainedScopes.size(), empty, legacyEnrollmentOccurred, ready);
            } catch (const std::exception& error) {
                return std::string{"refused: unload readiness unavailable: "} + error.what();
            }
        }});
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-register-scope-process", false,
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
    HyprlandAPI::registerHyprCtlCommand(PHANDLE, SHyprCtlCommand{"ghost-register-process", false,
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
    if (!applicationLeases.empty())
        throw std::runtime_error("active application leases must be handed back before unload");
    removeApplicationHooks();
    privateClipboardOffers.retire(nullptr, PROTO::data->m_offers);
    privatePrimaryOffers.retire(nullptr, PROTO::primarySelection->m_offers);
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
    restoreDataControlGuards(wlrGuards, nullptr);
    restoreDataControlGuards(extGuards, nullptr);
    restoreSelectionGuards(primaryGuards);
    restoreSelectionGuards(clipboardGuards);
    clearSelectionClients();
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
    retainedScopes.clear();
    admissionPaused = false;
    legacyEnrollmentOccurred = false;
}
