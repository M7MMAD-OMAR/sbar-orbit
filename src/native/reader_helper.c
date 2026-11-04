/* SPDX-License-Identifier: Apache-2.0
 * Original Orbit one-frame Wayland client. Dormant, not a security boundary.
 * Fixed input fd 3, receipt fd 4. The owner must authenticate this executable,
 * binding and nonblocking exclusive pipes. Nonce/digest are echoed setup data,
 * not cryptographic proof. Deadlines around OS/libwayland calls are cooperative.
 * READY is one frame copy, never
 * GPU/compositor quiescence. Memory reservations must charge up to 4,915,200
 * bytes SHM, 1,048,576 encoded bytes, 3,840 row bytes plus libpng/Wayland
 * allocations and process overhead separately. No total memory cap is claimed.
 * Sync before teardown samples queued target closure, not continuous liveness.
 * The parent must independently revalidate target binding before delivery.
 * READY receipt describes frame terminal/teardown/sync independently of PNG
 * success; the parent must separately validate PNG, exit, scope and binding.
 * Constraint updates are refused; no resize/retry/fallback is attempted. A
 * full-frame damage rectangle is required, so valid split damage is refused.
 * List destruction without stop/finished is legal cleanup but does not claim
 * list-finished acknowledgment. Frame/session/source/buffer destructor requests
 * are ordered before sync; wl_shm and registry destruction are local proxies,
 * not evidence that all compositor objects were destroyed.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <endian.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <png.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include "ext-foreign-toplevel-list-v1-client-protocol.h"
#include "ext-image-capture-source-v1-client-protocol.h"
#include "ext-image-copy-capture-v1-client-protocol.h"

#define LIMIT (1024u * 1024u)
#define MAX_TOPLEVELS 256u

struct window {
    struct ext_foreign_toplevel_handle_v1 *handle;
    char identifier[33];
    bool done, closed, identifier_seen, invalid;
};
struct state {
    struct wl_display *display;
    struct wl_registry *registry;
    struct wl_shm *shm;
    struct ext_foreign_toplevel_list_v1 *list;
    struct ext_foreign_toplevel_image_capture_source_manager_v1 *source_manager;
    struct ext_image_copy_capture_manager_v1 *copy_manager;
    struct ext_image_capture_source_v1 *source;
    struct ext_image_copy_capture_session_v1 *session;
    struct ext_image_copy_capture_frame_v1 *frame;
    struct wl_buffer *buffer;
    struct window windows[MAX_TOPLEVELS];
    unsigned count;
    bool error, synced, constraints, size_seen, format_seen, shm_format_seen;
    bool ready, failed, terminal, transform_seen, damage_seen, time_seen;
    uint32_t width, height;
    char target[33];
    uint8_t nonce[32], target_digest[32];
    void *pixels;
    size_t pixel_size;
    int64_t deadline;
    struct window *selected;
    bool post_ready_error;
};

static void wayland_log(const char *format, va_list args) { (void)format; (void)args; }

static int64_t now_ms(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) return -1;
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static int wait_fd(int fd, short events, int64_t deadline) {
    for (;;) {
        int64_t left = deadline - now_ms();
        if (left <= 0 || left > 3000) return -1;
        struct pollfd p = { .fd = fd, .events = events };
        int n = poll(&p, 1, (int)left);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0 || p.revents & (POLLERR | POLLNVAL)) return -1;
        if (p.revents & (events | POLLHUP)) return 0;
    }
}
static int read_setup(uint8_t *out, int64_t deadline) {
    size_t count = 0;
    int flags = fcntl(3, F_GETFL);
    if (flags < 0 || !(flags & O_NONBLOCK)) return -1;
    while (count < 121) {
        if (wait_fd(3, POLLIN, deadline)) return -1;
        ssize_t n = read(3, out + count, 121 - count);
        if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
        if (n < 0) return -1;
        if (!n) return count == 120 ? 0 : -1;
        count += (size_t)n;
    }
    return -1;
}
static uint32_t word(const uint8_t *p) {
    uint32_t v;
    memcpy(&v, p, 4);
    return ntohl(v);
}
static void putword(uint8_t *p, uint32_t v) {
    v = htonl(v);
    memcpy(p, &v, 4);
}
static int setup(struct state *s) {
    uint8_t data[121];
    struct stat a, b, c;
    if (fstat(3, &a) || fstat(4, &b) || fstat(1, &c) ||
        !S_ISFIFO(a.st_mode) || !S_ISFIFO(b.st_mode) || !S_ISFIFO(c.st_mode) ||
        (a.st_dev == b.st_dev && a.st_ino == b.st_ino) ||
        (c.st_dev == b.st_dev && c.st_ino == b.st_ino) ||
        (a.st_dev == c.st_dev && a.st_ino == c.st_ino) ||
        (fcntl(3, F_GETFL) & O_ACCMODE) != O_RDONLY ||
        (fcntl(4, F_GETFL) & O_ACCMODE) != O_WRONLY ||
        (fcntl(1, F_GETFL) & O_ACCMODE) != O_WRONLY ||
        !(fcntl(3, F_GETFL) & O_NONBLOCK) || !(fcntl(4, F_GETFL) & O_NONBLOCK) ||
        !(fcntl(1, F_GETFL) & O_NONBLOCK)) return -1;
    if (read_setup(data, s->deadline) || memcmp(data, "ORBSET01", 8) || word(data + 8) != 1) return -1;
    s->width = word(data + 12); s->height = word(data + 16);
    uint32_t length = word(data + 20);
    if (!s->width || s->width > 1280 || !s->height || s->height > 960 || !length || length > 16) return -1;
    for (uint32_t i = 0; i < 32; ++i) {
        uint8_t ch = data[24 + i];
        if (i < length) {
            if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return -1;
            s->target[i] = (char)ch;
        } else if (ch) return -1;
    }
    s->target[length] = 0;
    memcpy(s->nonce, data + 56, 32);
    memcpy(s->target_digest, data + 88, 32);
    return 0;
}
static void sync_done(void *data, struct wl_callback *callback, uint32_t serial) {
    (void)serial;
    struct state *s = data;
    s->synced = true;
    wl_callback_destroy(callback);
}
static const struct wl_callback_listener sync_listener = { .done = sync_done };
static int pump(struct state *s, const bool *done) {
    int fd = wl_display_get_fd(s->display);
    while (!*done && !s->error) {
        int64_t current = now_ms();
        if (current < 0 || current >= s->deadline) return -1;
        while (wl_display_prepare_read(s->display) != 0) {
            if (wl_display_dispatch_pending(s->display) < 0) return -1;
            if (*done || s->error) break;
        }
        if (*done || s->error) break;
        int sent = wl_display_flush(s->display);
        if (sent < 0 && errno != EAGAIN) { wl_display_cancel_read(s->display); return -1; }
        short ev = POLLIN | (sent < 0 ? POLLOUT : 0);
        if (wait_fd(fd, ev, s->deadline)) { wl_display_cancel_read(s->display); return -1; }
        struct pollfd p = { .fd = fd, .events = POLLIN };
        if (poll(&p, 1, 0) > 0 && (p.revents & POLLIN)) {
            if (wl_display_read_events(s->display) < 0) return -1;
        } else wl_display_cancel_read(s->display);
        if (wl_display_dispatch_pending(s->display) < 0) return -1;
    }
    return s->error ? -1 : 0;
}
static int sync_round(struct state *s) {
    s->synced = false;
    struct wl_callback *cb = wl_display_sync(s->display);
    if (!cb) return -1;
    wl_callback_add_listener(cb, &sync_listener, s);
    return pump(s, &s->synced);
}
static void global_shm_format(void *data, struct wl_shm *shm, uint32_t format) {
    (void)shm; if (format == WL_SHM_FORMAT_XRGB8888) ((struct state *)data)->shm_format_seen = true;
}
static const struct wl_shm_listener shm_listener = { .format = global_shm_format };
static void global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
    struct state *s = data;
    if (version < 1) return;
    if (!strcmp(iface, wl_shm_interface.name)) {
        if (s->shm) s->error = true;
        else {
            s->shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
            if (s->shm) wl_shm_add_listener(s->shm, &shm_listener, s);
        }
    } else if (!strcmp(iface, ext_foreign_toplevel_list_v1_interface.name)) {
        if (s->list) s->error = true;
        else s->list = wl_registry_bind(reg, name, &ext_foreign_toplevel_list_v1_interface, 1);
    } else if (!strcmp(iface, ext_foreign_toplevel_image_capture_source_manager_v1_interface.name)) {
        if (s->source_manager) s->error = true;
        else s->source_manager = wl_registry_bind(reg, name, &ext_foreign_toplevel_image_capture_source_manager_v1_interface, 1);
    } else if (!strcmp(iface, ext_image_copy_capture_manager_v1_interface.name)) {
        if (s->copy_manager) s->error = true;
        else s->copy_manager = wl_registry_bind(reg, name, &ext_image_copy_capture_manager_v1_interface, 1);
    }
}
static void global_remove(void *data, struct wl_registry *r, uint32_t name) {
    (void)r; (void)name; ((struct state *)data)->error = true;
}
static const struct wl_registry_listener registry_listener = { .global = global, .global_remove = global_remove };
static void handle_closed(void *data, struct ext_foreign_toplevel_handle_v1 *h) { (void)h; ((struct window *)data)->closed = true; }
static void handle_done(void *data, struct ext_foreign_toplevel_handle_v1 *h) { (void)h; ((struct window *)data)->done = true; }
static void handle_title(void *d, struct ext_foreign_toplevel_handle_v1 *h, const char *v) { (void)d; (void)h; (void)v; }
static void handle_app(void *d, struct ext_foreign_toplevel_handle_v1 *h, const char *v) { (void)d; (void)h; (void)v; }
static void handle_id(void *data, struct ext_foreign_toplevel_handle_v1 *h, const char *value) {
    (void)h; struct window *w = data;
    if (w->identifier_seen || !value) { w->invalid = true; return; }
    size_t length = strnlen(value, 33);
    if (!length || length > 32) { w->invalid = true; return; }
    w->identifier_seen = true; memcpy(w->identifier, value, length + 1);
}
static const struct ext_foreign_toplevel_handle_v1_listener handle_listener = {
    .closed = handle_closed, .done = handle_done, .title = handle_title, .app_id = handle_app, .identifier = handle_id
};
static void toplevel(void *data, struct ext_foreign_toplevel_list_v1 *list, struct ext_foreign_toplevel_handle_v1 *h) {
    (void)list; struct state *s = data;
    if (s->count >= MAX_TOPLEVELS) { s->error = true; ext_foreign_toplevel_handle_v1_destroy(h); return; }
    struct window *w = &s->windows[s->count++]; w->handle = h;
    ext_foreign_toplevel_handle_v1_add_listener(h, &handle_listener, w);
}
static void list_finished(void *data, struct ext_foreign_toplevel_list_v1 *list) { (void)list; ((struct state *)data)->error = true; }
static const struct ext_foreign_toplevel_list_v1_listener list_listener = { .toplevel = toplevel, .finished = list_finished };
static void buffer_size(void *data, struct ext_image_copy_capture_session_v1 *session, uint32_t w, uint32_t h) {
    (void)session; struct state *s = data;
    if (s->constraints || s->size_seen || w != s->width || h != s->height) s->error = true;
    s->size_seen = true;
}
static void shm_format(void *data, struct ext_image_copy_capture_session_v1 *session, uint32_t format) {
    (void)session; struct state *s = data;
    if (s->constraints) s->error = true;
    if (format == WL_SHM_FORMAT_XRGB8888) s->format_seen = true;
}
static void dmabuf_device(void *d, struct ext_image_copy_capture_session_v1 *s, struct wl_array *a) {
    (void)s; (void)a; if (((struct state *)d)->constraints) ((struct state *)d)->error = true;
}
static void dmabuf_format(void *d, struct ext_image_copy_capture_session_v1 *s, uint32_t f, struct wl_array *a) {
    (void)s; (void)f; (void)a; if (((struct state *)d)->constraints) ((struct state *)d)->error = true;
}
static void constraints_done(void *data, struct ext_image_copy_capture_session_v1 *session) {
    (void)session; struct state *s = data;
    if (s->constraints || !s->size_seen || !s->format_seen) s->error = true;
    s->constraints = true;
}
static void session_stopped(void *data, struct ext_image_copy_capture_session_v1 *session) { (void)session; ((struct state *)data)->error = true; }
static const struct ext_image_copy_capture_session_v1_listener session_listener = {
    .buffer_size = buffer_size, .shm_format = shm_format, .dmabuf_device = dmabuf_device,
    .dmabuf_format = dmabuf_format, .done = constraints_done, .stopped = session_stopped
};
static void frame_transform(void *data, struct ext_image_copy_capture_frame_v1 *f, uint32_t transform) {
    (void)f; struct state *s = data;
    if (s->transform_seen || transform != WL_OUTPUT_TRANSFORM_NORMAL) s->error = true;
    s->transform_seen = true;
}
static void frame_damage(void *data, struct ext_image_copy_capture_frame_v1 *f, int32_t x, int32_t y, int32_t w, int32_t h) {
    (void)f; struct state *s = data;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || (uint64_t)x + w > s->width || (uint64_t)y + h > s->height) s->error = true;
    if (x == 0 && y == 0 && w == (int32_t)s->width && h == (int32_t)s->height)
        s->damage_seen = true;
}
static void frame_time(void *data, struct ext_image_copy_capture_frame_v1 *f, uint32_t hi, uint32_t lo, uint32_t ns) {
    (void)f; (void)hi; (void)lo; struct state *s = data;
    if (s->time_seen || ns >= 1000000000u) s->error = true;
    s->time_seen = true;
}
static void frame_ready(void *data, struct ext_image_copy_capture_frame_v1 *f) {
    (void)f; struct state *s = data;
    if (s->ready || s->failed || !s->transform_seen || !s->damage_seen || !s->time_seen) s->error = true;
    s->ready = true; s->terminal = true;
}
static void frame_failed(void *data, struct ext_image_copy_capture_frame_v1 *f, uint32_t reason) {
    (void)f; (void)reason; struct state *s = data;
    if (s->ready || s->failed) s->error = true;
    s->failed = true; s->terminal = true;
}
static const struct ext_image_copy_capture_frame_v1_listener frame_listener = {
    .transform = frame_transform, .damage = frame_damage, .presentation_time = frame_time,
    .ready = frame_ready, .failed = frame_failed
};
static int allocate(struct state *s) {
    size_t stride = (size_t)s->width * 4;
    s->pixel_size = stride * s->height;
    if (s->pixel_size > 1280u * 960u * 4u || s->pixel_size > INT32_MAX) return -1;
    int fd = memfd_create("orbit-reader", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (fd < 0) return -1;
    if (ftruncate(fd, (off_t)s->pixel_size) || fcntl(fd, F_ADD_SEALS, F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL)) { close(fd); return -1; }
    s->pixels = mmap(NULL, s->pixel_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (s->pixels == MAP_FAILED) { s->pixels = NULL; close(fd); return -1; }
    struct wl_shm_pool *pool = wl_shm_create_pool(s->shm, fd, (int32_t)s->pixel_size);
    if (close(fd)) { if (pool) wl_shm_pool_destroy(pool); return -1; }
    if (!pool) return -1;
    s->buffer = wl_shm_pool_create_buffer(pool, 0, (int32_t)s->width, (int32_t)s->height, (int32_t)stride, WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool);
    return s->buffer ? 0 : -1;
}
struct png_output { uint8_t *bytes; size_t size; };
static void png_write(png_structp png, png_bytep data, png_size_t size) {
    struct png_output *out = png_get_io_ptr(png);
    if (size > LIMIT - out->size) png_error(png, "limit");
    memcpy(out->bytes + out->size, data, size); out->size += size;
}
static void png_flush(png_structp png) { (void)png; }
static void png_fail(png_structp png, png_const_charp message) { (void)message; png_longjmp(png, 1); }
static void png_warn(png_structp png, png_const_charp message) { (void)png; (void)message; }
static int encode(struct state *s, struct png_output *out) {
    png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, NULL, png_fail, png_warn);
    if (!png) return -1;
    png_infop info = png_create_info_struct(png);
    if (!info) { png_destroy_write_struct(&png, NULL); return -1; }
    uint8_t *row = malloc((size_t)s->width * 3);
    volatile int result = -1;
    out->bytes = malloc(LIMIT);
    if (!row || !out->bytes) { free(row); free(out->bytes); out->bytes = NULL; png_destroy_write_struct(&png, &info); return -1; }
    if (!setjmp(png_jmpbuf(png))) {
        png_set_write_fn(png, out, png_write, png_flush);
        png_set_IHDR(png, info, s->width, s->height, 8, PNG_COLOR_TYPE_RGB,
                     PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
        png_write_info(png, info);
        for (uint32_t y = 0; y < s->height; ++y) {
            int64_t current = now_ms();
            if (current < 0 || current >= s->deadline) png_error(png, "deadline");
            const uint8_t *src = (const uint8_t *)s->pixels + (size_t)y * s->width * 4;
            for (uint32_t x = 0; x < s->width; ++x) {
                row[3*x] = src[4*x+2]; row[3*x+1] = src[4*x+1]; row[3*x+2] = src[4*x];
            }
            png_write_row(png, row);
        }
        png_write_end(png, info); result = 0;
    }
    free(row); png_destroy_write_struct(&png, &info);
    if (result) { free(out->bytes); out->bytes = NULL; out->size = 0; }
    return result;
}
static int write_all(int fd, const uint8_t *data, size_t length, int64_t deadline) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || !(flags & O_NONBLOCK)) return -1;
    while (length) {
        if (wait_fd(fd, POLLOUT, deadline)) return -1;
        ssize_t n = write(fd, data, length);
        if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
        if (n <= 0) return -1;
        data += n; length -= (size_t)n;
    }
    return 0;
}
static bool unique_target(struct state *s, struct window *selected) {
    unsigned matches = 0;
    for (unsigned i = 0; i < s->count; ++i) {
        struct window *w = &s->windows[i];
        /* Partial properties leave the identity set unknown, not unique. */
        if (!w->closed && (w->invalid || !w->done || !w->identifier_seen)) return false;
        if (!w->closed && !strcmp(w->identifier, s->target)) {
            if (w != selected) return false;
            ++matches;
        }
    }
    return matches == 1 && selected && !selected->closed;
}
static int capture(struct state *s) {
    /* No diagnostic text is emitted: libwayland debug may contain titles. */
    wl_log_set_handler_client(wayland_log);
    s->display = wl_display_connect(NULL);
    if (!s->display) return -1;
    s->registry = wl_display_get_registry(s->display);
    if (!s->registry) return -1;
    wl_registry_add_listener(s->registry, &registry_listener, s);
    if (sync_round(s) || !s->shm || !s->list || !s->source_manager || !s->copy_manager) return -1;
    ext_foreign_toplevel_list_v1_add_listener(s->list, &list_listener, s);
    if (sync_round(s) || !s->shm_format_seen) return -1;
    struct window *target = NULL;
    for (unsigned i = 0; i < s->count; ++i) {
        struct window *w = &s->windows[i];
        if (!w->closed && w->done && w->identifier_seen && !strcmp(w->identifier, s->target)) {
            if (target) return -1;
            target = w;
        }
    }
    if (!target || !unique_target(s, target)) return -1;
    s->selected = target;
    s->source = ext_foreign_toplevel_image_capture_source_manager_v1_create_source(s->source_manager, target->handle);
    if (!s->source) return -1;
    s->session = ext_image_copy_capture_manager_v1_create_session(s->copy_manager, s->source, 0);
    if (!s->session) return -1;
    ext_image_copy_capture_session_v1_add_listener(s->session, &session_listener, s);
    if (pump(s, &s->constraints) || !unique_target(s, target) || allocate(s)) return -1;
    s->frame = ext_image_copy_capture_session_v1_create_frame(s->session);
    if (!s->frame) return -1;
    ext_image_copy_capture_frame_v1_add_listener(s->frame, &frame_listener, s);
    ext_image_copy_capture_frame_v1_attach_buffer(s->frame, s->buffer);
    ext_image_copy_capture_frame_v1_damage_buffer(s->frame, 0, 0, (int32_t)s->width, (int32_t)s->height);
    ext_image_copy_capture_frame_v1_capture(s->frame);
    if (pump(s, &s->terminal)) return -1;
    if (!unique_target(s, target)) s->post_ready_error = true;
    return s->error ? -1 : 0;
}
static void destroy_objects(struct state *s) {
    if (s->frame) ext_image_copy_capture_frame_v1_destroy(s->frame);
    if (s->session) ext_image_copy_capture_session_v1_destroy(s->session);
    if (s->source) ext_image_capture_source_v1_destroy(s->source);
    if (s->buffer) wl_buffer_destroy(s->buffer);
    for (unsigned i = 0; i < s->count; ++i) if (s->windows[i].handle) ext_foreign_toplevel_handle_v1_destroy(s->windows[i].handle);
    if (s->list) ext_foreign_toplevel_list_v1_destroy(s->list);
    if (s->source_manager) ext_foreign_toplevel_image_capture_source_manager_v1_destroy(s->source_manager);
    if (s->copy_manager) ext_image_copy_capture_manager_v1_destroy(s->copy_manager);
    if (s->shm) wl_shm_destroy(s->shm);
    if (s->registry) wl_registry_destroy(s->registry);
}
int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1 || getenv("WAYLAND_SOCKET") || getenv("WAYLAND_DEBUG")) return 70;
#if __BYTE_ORDER != __LITTLE_ENDIAN
    return 70;
#endif
    struct state s = {0};
    s.deadline = now_ms() + 3000;
    if (s.deadline < 3000) return 70;
    signal(SIGPIPE, SIG_IGN);
#ifdef SYS_close_range
    if (syscall(SYS_close_range, 5u, ~0u, 0u)) return 70;
#else
    return 70;
#endif
    if (setup(&s)) return 70;
    if (close(3)) return 70;
    int status = capture(&s);
    struct png_output output = {0};
    bool terminal_observed = !status && (s.ready || s.failed);
    if (s.display) {
        /* Sample queued events while target and session listeners still exist. */
        if (terminal_observed && sync_round(&s)) terminal_observed = false;
        if (!s.selected || !unique_target(&s, s.selected)) terminal_observed = false;
        destroy_objects(&s);
        if (terminal_observed && sync_round(&s) == 0) {
            if (s.ready && (s.post_ready_error || encode(&s, &output))) status = -1;
            uint8_t receipt[84] = {0};
            memcpy(receipt, "ORBRCP01", 8); receipt[8] = 1; receipt[9] = s.ready ? 1 : 2; receipt[10] = 3;
            memcpy(receipt + 12, s.nonce, 32); memcpy(receipt + 44, s.target_digest, 32);
            putword(receipt + 76, s.width); putword(receipt + 80, s.height);
            if (!status && s.ready && write_all(1, output.bytes, output.size, s.deadline)) status = -1;
            /* Frame terminal evidence is independent of PNG encode/output. */
            if (!s.post_ready_error && write_all(4, receipt, sizeof(receipt), s.deadline)) status = -1;
        } else status = -1;
        wl_display_disconnect(s.display);
    }
    free(output.bytes);
    if (s.pixels && munmap(s.pixels, s.pixel_size)) status = -1;
    if (close(4)) status = -1;
    return status || s.failed ? 70 : 0;
}
