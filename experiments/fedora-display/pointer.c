/* Persistent input devices connected only to an explicit private socket. */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/mman.h>
#include <unistd.h>
#include <linux/input-event-codes.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
#include "virtual-pointer.h"
#include "virtual-keyboard.h"

static struct zwlr_virtual_pointer_manager_v1 *manager;
static struct zwp_virtual_keyboard_manager_v1 *keyboard_manager;
static struct wl_seat *seat;
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
    (void)data; (void)version;
    if (strcmp(interface, "zwlr_virtual_pointer_manager_v1") == 0)
        manager = wl_registry_bind(registry, name, &zwlr_virtual_pointer_manager_v1_interface, 1);
    else if (strcmp(interface, "zwp_virtual_keyboard_manager_v1") == 0)
        keyboard_manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
    else if (strcmp(interface, "wl_seat") == 0)
        seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
}
static void removed(void *data, struct wl_registry *registry, uint32_t name) { (void)data; (void)registry; (void)name; }
static uint32_t timestamp(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}
static const char *key_symbol_name(const char *name, char letter[2]) {
    static const struct { const char *input; const char *symbol; } aliases[] = {
        {"ArrowLeft", "Left"}, {"ArrowRight", "Right"}, {"ArrowUp", "Up"},
        {"ArrowDown", "Down"}, {"PageUp", "Prior"}, {"PageDown", "Next"},
        {"Space", "space"}, {"Minus", "minus"}, {"Equal", "equal"},
        {"Enter", "Return"},
    };
    for (size_t i = 0; i < sizeof(aliases) / sizeof(aliases[0]); i++)
        if (strcmp(name, aliases[i].input) == 0) return aliases[i].symbol;
    if (name[0] >= 'A' && name[0] <= 'Z' && name[1] == 0) {
        letter[0] = (char)(name[0] - 'A' + 'a'); letter[1] = 0; return letter;
    }
    if (name[0] >= '0' && name[0] <= '9' && name[1] == 0) return name;
    if (name[0] == 'F' && name[1] >= '1' && name[1] <= '9' && name[2] == 0) return name;
    if (name[0] == 'F' && name[1] == '1' && name[2] >= '0' && name[2] <= '2' && name[3] == 0) return name;
    if (strcmp(name, "Tab") == 0 || strcmp(name, "Escape") == 0 ||
        strcmp(name, "Backspace") == 0 ||
        strcmp(name, "Delete") == 0 || strcmp(name, "Home") == 0 ||
        strcmp(name, "End") == 0) return name;
    return NULL;
}
static int parse_key(struct xkb_keymap *keymap, const char *line, uint32_t *code, uint32_t *modifiers) {
    size_t length = strlen(line);
    if (length < 5 || length >= 64 || line[length - 1] != '\n') return 0;
    char copy[64];
    memcpy(copy, line + 4, length - 5);
    copy[length - 5] = 0;
    const char *name = copy;
    const struct { const char *prefix; const char *modifier; } prefixes[] = {
        {"Ctrl+", XKB_MOD_NAME_CTRL}, {"Alt+", XKB_MOD_NAME_ALT},
        {"Shift+", XKB_MOD_NAME_SHIFT},
    };
    *modifiers = 0;
    for (size_t i = 0; i < sizeof(prefixes) / sizeof(prefixes[0]); i++) {
        size_t prefix_length = strlen(prefixes[i].prefix);
        if (strncmp(name, prefixes[i].prefix, prefix_length) != 0) continue;
        xkb_mod_index_t index = xkb_keymap_mod_get_index(keymap, prefixes[i].modifier);
        if (index == XKB_MOD_INVALID || index >= 32) return 0;
        *modifiers |= 1u << index;
        name += prefix_length;
    }
    char letter[2];
    const char *symbol_name = key_symbol_name(name, letter);
    if (!symbol_name) return 0;
    xkb_keysym_t symbol = xkb_keysym_from_name(symbol_name, XKB_KEYSYM_NO_FLAGS);
    if (symbol == XKB_KEY_NoSymbol) return 0;
    for (xkb_keycode_t candidate = xkb_keymap_min_keycode(keymap);
         candidate <= xkb_keymap_max_keycode(keymap); candidate++) {
        for (xkb_level_index_t level = 0; level < 2; level++) {
            const xkb_keysym_t *symbols;
            int count = xkb_keymap_key_get_syms_by_level(keymap, candidate, 0, level, &symbols);
            if (count == 1 && symbols[0] == symbol && candidate >= 8) {
                *code = candidate - 8;
                return 1;
            }
        }
    }
    return 0;
}
int main(int argc, char **argv) {
    if (argc != 2 || strncmp(argv[1], "/tmp/orbit-native-", 18) != 0) {
        fprintf(stderr, "Explicit Orbit private Wayland socket required\n"); return 1;
    }
    struct wl_display *display = wl_display_connect(argv[1]);
    if (!display) return 2;
    struct wl_registry *registry = wl_display_get_registry(display);
    const struct wl_registry_listener listener = {global, removed};
    wl_registry_add_listener(registry, &listener, NULL);
    if (wl_display_roundtrip(display) < 0 || !manager || !keyboard_manager || !seat) return 3;
    struct zwlr_virtual_pointer_v1 *pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(manager, NULL);
    struct zwp_virtual_keyboard_v1 *keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(keyboard_manager, seat);
    struct xkb_context *context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    const struct xkb_rule_names names = {.rules = "evdev", .model = "pc105", .layout = "us"};
    struct xkb_keymap *keymap = xkb_keymap_new_from_names(context, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
    if (!keymap) return 8;
    char *mapping = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
    int fd = memfd_create("orbit-keymap", MFD_CLOEXEC);
    size_t length = strlen(mapping) + 1;
    if (fd < 0 || write(fd, mapping, length) != (ssize_t)length) return 9;
    zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, length);
    close(fd);
    free(mapping);
    if (wl_display_roundtrip(display) < 0) return 4;
    puts("ready"); fflush(stdout);
    unsigned x, y;
    char line[4096];
    while (fgets(line, sizeof(line), stdin)) {
        if (strncmp(line, "scroll ", 7) == 0) {
            int steps;
            char trailing;
            if (sscanf(line, "scroll %u %u %d %c", &x, &y, &steps, &trailing) != 3
                || x >= 1280 || y >= 800 || steps == 0 || steps < -20 || steps > 20) return 15;
            zwlr_virtual_pointer_v1_motion_absolute(pointer, timestamp(), x, y, 1280, 800);
            zwlr_virtual_pointer_v1_frame(pointer);
            if (wl_display_roundtrip(display) < 0) return 6;
            /* Establish an unchanged axis baseline before the requested wheel delta. */
            zwlr_virtual_pointer_v1_axis_source(pointer, WL_POINTER_AXIS_SOURCE_WHEEL);
            zwlr_virtual_pointer_v1_axis_discrete(pointer, timestamp(), WL_POINTER_AXIS_VERTICAL_SCROLL,
                wl_fixed_from_int(0), 0);
            zwlr_virtual_pointer_v1_frame(pointer);
            if (wl_display_roundtrip(display) < 0) return 7;
            zwlr_virtual_pointer_v1_axis_source(pointer, WL_POINTER_AXIS_SOURCE_WHEEL);
            zwlr_virtual_pointer_v1_axis_discrete(pointer, timestamp(), WL_POINTER_AXIS_VERTICAL_SCROLL,
                wl_fixed_from_int(steps * 10), steps);
            zwlr_virtual_pointer_v1_frame(pointer);
            if (wl_display_roundtrip(display) < 0) return 7;
            puts("ok"); fflush(stdout);
            continue;
        }
        if (strncmp(line, "key ", 4) == 0) {
            uint32_t code = 0, modifiers = 0;
            if (!parse_key(keymap, line, &code, &modifiers)) return 14;
            zwp_virtual_keyboard_v1_modifiers(keyboard, modifiers, 0, 0, 0);
            zwp_virtual_keyboard_v1_key(keyboard, timestamp(), code, WL_KEYBOARD_KEY_STATE_PRESSED);
            zwp_virtual_keyboard_v1_key(keyboard, timestamp(), code, WL_KEYBOARD_KEY_STATE_RELEASED);
            zwp_virtual_keyboard_v1_modifiers(keyboard, 0, 0, 0, 0);
            if (wl_display_roundtrip(display) < 0) return 12;
            puts("ok"); fflush(stdout);
            continue;
        }
        if (strcmp(line, "paste\n") == 0) {
            uint32_t control = 1u << xkb_keymap_mod_get_index(keymap, XKB_MOD_NAME_CTRL);
            zwp_virtual_keyboard_v1_modifiers(keyboard, control, 0, 0, 0);
            /* KEY_V is evdev 47 in the fixed US keymap. */
            zwp_virtual_keyboard_v1_key(keyboard, timestamp(), 47, WL_KEYBOARD_KEY_STATE_PRESSED);
            zwp_virtual_keyboard_v1_key(keyboard, timestamp(), 47, WL_KEYBOARD_KEY_STATE_RELEASED);
            zwp_virtual_keyboard_v1_modifiers(keyboard, 0, 0, 0, 0);
            if (wl_display_roundtrip(display) < 0) return 12;
            puts("ok"); fflush(stdout);
            continue;
        }
        if (strncmp(line, "text ", 5) == 0) {
            for (char *ch = line + 5; *ch && *ch != '\n'; ch++) {
                if ((unsigned char)*ch < 32 || (unsigned char)*ch > 126) return 10;
                xkb_keycode_t found = 0;
                uint32_t shift = 0;
                for (xkb_keycode_t code = xkb_keymap_min_keycode(keymap); code <= xkb_keymap_max_keycode(keymap) && !found; code++) {
                    for (xkb_level_index_t level = 0; level < 2; level++) {
                        const xkb_keysym_t *symbols;
                        int count = xkb_keymap_key_get_syms_by_level(keymap, code, 0, level, &symbols);
                        if (count == 1 && symbols[0] == (unsigned char)*ch) {
                            found = code;
                            shift = level ? 1u << xkb_keymap_mod_get_index(keymap, XKB_MOD_NAME_SHIFT) : 0;
                            break;
                        }
                    }
                }
                if (!found || found < 8) return 11;
                zwp_virtual_keyboard_v1_modifiers(keyboard, shift, 0, 0, 0);
                zwp_virtual_keyboard_v1_key(keyboard, timestamp(), found - 8, WL_KEYBOARD_KEY_STATE_PRESSED);
                zwp_virtual_keyboard_v1_key(keyboard, timestamp(), found - 8, WL_KEYBOARD_KEY_STATE_RELEASED);
                zwp_virtual_keyboard_v1_modifiers(keyboard, 0, 0, 0, 0);
                if (wl_display_roundtrip(display) < 0) return 12;
            }
            puts("ok"); fflush(stdout);
            continue;
        }
        if (sscanf(line, "%u %u", &x, &y) != 2) return 13;
        if (x >= 1280 || y >= 800) return 5;
        zwlr_virtual_pointer_v1_motion_absolute(pointer, timestamp(), x, y, 1280, 800);
        zwlr_virtual_pointer_v1_frame(pointer);
        if (wl_display_roundtrip(display) < 0) return 6;
        zwlr_virtual_pointer_v1_button(pointer, timestamp(), 272, WL_POINTER_BUTTON_STATE_PRESSED);
        zwlr_virtual_pointer_v1_frame(pointer);
        zwlr_virtual_pointer_v1_button(pointer, timestamp(), 272, WL_POINTER_BUTTON_STATE_RELEASED);
        zwlr_virtual_pointer_v1_frame(pointer);
        if (wl_display_roundtrip(display) < 0) return 7;
        puts("ok"); fflush(stdout);
    }
    zwlr_virtual_pointer_v1_destroy(pointer);
    zwp_virtual_keyboard_v1_destroy(keyboard);
    xkb_keymap_unref(keymap);
    xkb_context_unref(context);
    wl_seat_destroy(seat);
    zwlr_virtual_pointer_manager_v1_destroy(manager);
    wl_registry_destroy(registry);
    wl_display_disconnect(display);
    return 0;
}
