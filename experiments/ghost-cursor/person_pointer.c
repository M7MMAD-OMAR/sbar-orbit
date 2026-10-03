// The simulated person's pointer, exclusively inside the isolated lab.
// This is a Wayland client, not a kernel input device or the agent input path.
#include <wayland-client.h>
#include "virtual-pointer-client.h"
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <limits.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static struct zwlr_virtual_pointer_manager_v1 *manager;

static void global(void *data, struct wl_registry *registry, uint32_t name,
                   const char *interface, uint32_t version) {
    (void)data;
    (void)version;
    if (!strcmp(interface, "zwlr_virtual_pointer_manager_v1"))
        manager = wl_registry_bind(registry, name,
                                   &zwlr_virtual_pointer_manager_v1_interface, 1);
}

static void removed(void *data, struct wl_registry *registry, uint32_t name) {
    (void)data;
    (void)registry;
    (void)name;
}

static uint32_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

int main(int argc, char **argv) {
    const char *runtime = getenv("XDG_RUNTIME_DIR");
    const char *socket = getenv("WAYLAND_DISPLAY");
    char canonical[PATH_MAX], path[PATH_MAX];
    struct stat st;
    if (!runtime || !socket || strchr(socket, '/') || !realpath(runtime, canonical) ||
        strncmp(canonical, "/tmp/gl-", 8) || getenv("DISPLAY")) {
        fprintf(stderr, "Refused: pointer simulation requires a private ghost lab\n");
        return 1;
    }
    if (strlen(canonical) + strlen(socket) + 2 > sizeof(path))
        return 1;
    strcpy(path, canonical);
    strcat(path, "/");
    strcat(path, socket);
    if (lstat(path, &st) || !S_ISSOCK(st.st_mode) || (argc != 5 && argc != 6)) {
        fprintf(stderr, "Expected a lab socket and x y width height\n");
        return 1;
    }
    unsigned values[4];
    for (int i = 0; i < 4; ++i) {
        char *end;
        unsigned long value = strtoul(argv[i + 1], &end, 10);
        if (*end || argv[i + 1][0] == '-' || value > UINT32_MAX)
            return 1;
        values[i] = (unsigned)value;
    }
    if (!values[2] || !values[3] || values[0] >= values[2] || values[1] >= values[3])
        return 1;
    struct wl_display *display = wl_display_connect(NULL);
    if (!display)
        return 1;
    struct wl_registry *registry = wl_display_get_registry(display);
    const struct wl_registry_listener listener = {global, removed};
    wl_registry_add_listener(registry, &listener, NULL);
    if (wl_display_roundtrip(display) < 0 || !manager)
        return 1;
    struct zwlr_virtual_pointer_v1 *pointer =
        zwlr_virtual_pointer_manager_v1_create_virtual_pointer(manager, NULL);
    wl_display_roundtrip(display);
    const struct timespec settle = {.tv_sec = 0, .tv_nsec = 300000000};
    nanosleep(&settle, NULL);
    zwlr_virtual_pointer_v1_motion_absolute(pointer, now_ms(), values[0], values[1], values[2], values[3]);
    zwlr_virtual_pointer_v1_frame(pointer);
    if (wl_display_roundtrip(display) < 0)
        return 1;
    nanosleep(&settle, NULL);
    if (argc == 6) {
        if (!strcmp(argv[5], "hold")) {
            printf("Pointer device ready\n");
            fflush(stdout);
            for (;;)
                pause();
        }
        char *end;
        long seconds = strtol(argv[5], &end, 10);
        if (*end || seconds < 0 || seconds > 300)
            return 1;
        printf("Pointer device ready\n");
        fflush(stdout);
        const struct timespec hold = {.tv_sec = seconds, .tv_nsec = 0};
        nanosleep(&hold, NULL);
    }
    if (argc == 5) {
    zwlr_virtual_pointer_v1_button(pointer, now_ms(), 0x110, WL_POINTER_BUTTON_STATE_PRESSED);
    zwlr_virtual_pointer_v1_frame(pointer);
    if (wl_display_roundtrip(display) < 0)
        return 1;
    zwlr_virtual_pointer_v1_button(pointer, now_ms(), 0x110, WL_POINTER_BUTTON_STATE_RELEASED);
    zwlr_virtual_pointer_v1_frame(pointer);
    if (wl_display_roundtrip(display) < 0)
        return 1;
    nanosleep(&settle, NULL);
    }
    zwlr_virtual_pointer_v1_destroy(pointer);
    zwlr_virtual_pointer_manager_v1_destroy(manager);
    wl_registry_destroy(registry);
    wl_display_roundtrip(display);
    wl_display_disconnect(display);
    return 0;
}
