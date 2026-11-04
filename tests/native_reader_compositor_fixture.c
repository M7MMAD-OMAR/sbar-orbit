/* SPDX-License-Identifier: Apache-2.0
 * Synthetic test-only Wayland server. Never opens a real desktop display.
 */
#define _GNU_SOURCE
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wayland-server.h>
#include "ext-foreign-toplevel-list-v1-server-protocol.h"
#include "ext-image-capture-source-v1-server-protocol.h"
#include "ext-image-copy-capture-v1-server-protocol.h"

struct fixture {
    struct wl_display *display;
    const char *mode;
    struct wl_resource *buffer, *list, *selected;
    bool frame_destroy, session_destroy, source_destroy, captured, bad, attached, damaged;
    unsigned sync_after_destroy, clients_created, clients_gone;
    struct wl_listener client_created, client_destroyed;
};
static struct fixture *F(struct wl_resource *r) { return wl_resource_get_user_data(r); }
static void destroy(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static void handle_destroy(struct wl_client *c, struct wl_resource *r) { destroy(c, r); }
static const struct ext_foreign_toplevel_handle_v1_interface handle_impl = { .destroy = handle_destroy };
static void list_stop(struct wl_client *c, struct wl_resource *r) {
    (void)c; ext_foreign_toplevel_list_v1_send_finished(r);
}
static const struct ext_foreign_toplevel_list_v1_interface list_impl = { .stop = list_stop, .destroy = destroy };
static void bind_list(struct wl_client *client, void *data, uint32_t version, uint32_t id) {
    (void)version;
    struct fixture *f = data;
    struct wl_resource *list = wl_resource_create(client, &ext_foreign_toplevel_list_v1_interface, 1, id);
    if (!list) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(list, &list_impl, f, NULL);
    f->list = list;
    unsigned count = !strcmp(f->mode, "duplicate") ? 2 : 1;
    for (unsigned i = 0; i < count; ++i) {
        struct wl_resource *h = wl_resource_create(client, &ext_foreign_toplevel_handle_v1_interface, 1, 0);
        if (!h) { wl_client_post_no_memory(client); return; }
        wl_resource_set_implementation(h, &handle_impl, f, NULL);
        if (i == 0) f->selected = h;
        ext_foreign_toplevel_list_v1_send_toplevel(list, h);
        ext_foreign_toplevel_handle_v1_send_identifier(h, "a");
        ext_foreign_toplevel_handle_v1_send_title(h, "fixture");
        ext_foreign_toplevel_handle_v1_send_app_id(h, "fixture");
        ext_foreign_toplevel_handle_v1_send_done(h);
    }
}
static void source_destroy(struct wl_client *c, struct wl_resource *r) {
    F(r)->source_destroy = true; destroy(c, r);
}
static const struct ext_image_capture_source_v1_interface source_impl = { .destroy = source_destroy };
static void create_source(struct wl_client *c, struct wl_resource *manager, uint32_t id, struct wl_resource *handle) {
    if (!handle || handle != F(manager)->selected) { F(manager)->bad = true; return; }
    struct wl_resource *r = wl_resource_create(c, &ext_image_capture_source_v1_interface, 1, id);
    if (!r) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(r, &source_impl, F(manager), NULL);
}
static const struct ext_foreign_toplevel_image_capture_source_manager_v1_interface source_manager_impl = {
    .create_source = create_source, .destroy = destroy
};
static void bind_source(struct wl_client *c, void *data, uint32_t version, uint32_t id) {
    (void)version; struct wl_resource *r = wl_resource_create(c, &ext_foreign_toplevel_image_capture_source_manager_v1_interface, 1, id);
    if (!r) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(r, &source_manager_impl, data, NULL);
}
static void frame_destroy(struct wl_client *c, struct wl_resource *r) {
    F(r)->frame_destroy = true; destroy(c, r);
}
static void attach(struct wl_client *c, struct wl_resource *r, struct wl_resource *buffer) {
    (void)c; struct fixture *f = F(r);
    if (f->attached || f->damaged || f->captured || !buffer) f->bad = true;
    f->attached = true; f->buffer = buffer;
}
static void damage(struct wl_client *c, struct wl_resource *r, int32_t x, int32_t y, int32_t w, int32_t h) {
    (void)c; struct fixture *f = F(r);
    int expected = !strcmp(f->mode, "small-damage") ? 2 : 1;
    if (!f->attached || f->damaged || f->captured || x || y || w != expected || h != expected) f->bad = true;
    f->damaged = true;
}
static void drop_idle(void *data) {
    /* Destroy only after libwayland finishes dispatching the capture request. */
    wl_client_destroy(data);
}
static void capture(struct wl_client *c, struct wl_resource *r) {
    struct fixture *f = F(r);
    if (!f->attached || !f->damaged || f->captured) f->bad = true;
    f->captured = true;
    if (!strcmp(f->mode, "drop")) {
        if (!wl_event_loop_add_idle(wl_display_get_event_loop(f->display), drop_idle, c)) {
            f->bad = true; wl_client_post_no_memory(c);
        }
        return;
    }
    if (!strcmp(f->mode, "timeout")) return;
    struct wl_shm_buffer *shm = f->buffer ? wl_shm_buffer_get(f->buffer) : NULL;
    int expected = !strcmp(f->mode, "small-damage") ? 2 : 1;
    if (!shm || wl_shm_buffer_get_width(shm) != expected || wl_shm_buffer_get_height(shm) != expected ||
        wl_shm_buffer_get_stride(shm) != expected * 4 || wl_shm_buffer_get_format(shm) != WL_SHM_FORMAT_XRGB8888) {
        f->bad = true; wl_client_post_implementation_error(c, "invalid fixture buffer"); return;
    }
    if (!strcmp(f->mode, "failed")) {
        ext_image_copy_capture_frame_v1_send_failed(r, EXT_IMAGE_COPY_CAPTURE_FRAME_V1_FAILURE_REASON_UNKNOWN);
        return;
    }
    wl_shm_buffer_begin_access(shm);
    uint8_t *p = wl_shm_buffer_get_data(shm);
    for (int i = 0; i < expected * expected; ++i) {
        p[4*i] = 3; p[4*i+1] = 2; p[4*i+2] = 1; p[4*i+3] = 0;
    }
    wl_shm_buffer_end_access(shm);
    ext_image_copy_capture_frame_v1_send_transform(r, WL_OUTPUT_TRANSFORM_NORMAL);
    ext_image_copy_capture_frame_v1_send_damage(r, 0, 0, 1, 1);
    ext_image_copy_capture_frame_v1_send_presentation_time(r, 0, 1, 0);
    ext_image_copy_capture_frame_v1_send_ready(r);
    if (!strcmp(f->mode, "late-duplicate") || !strcmp(f->mode, "late-malformed")) {
        struct wl_resource *h = wl_resource_create(c, &ext_foreign_toplevel_handle_v1_interface, 1, 0);
        if (!h) { wl_client_post_no_memory(c); return; }
        wl_resource_set_implementation(h, &handle_impl, f, NULL);
        ext_foreign_toplevel_list_v1_send_toplevel(f->list, h);
        ext_foreign_toplevel_handle_v1_send_identifier(h, "a");
        if (!strcmp(f->mode, "late-malformed"))
            ext_foreign_toplevel_handle_v1_send_identifier(h, "a");
        ext_foreign_toplevel_handle_v1_send_done(h);
    }
}
static const struct ext_image_copy_capture_frame_v1_interface frame_impl = {
    .destroy = frame_destroy, .attach_buffer = attach, .damage_buffer = damage, .capture = capture
};
static void create_frame(struct wl_client *c, struct wl_resource *session, uint32_t id) {
    struct wl_resource *r = wl_resource_create(c, &ext_image_copy_capture_frame_v1_interface, 1, id);
    if (!r) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(r, &frame_impl, F(session), NULL);
}
static void session_destroy(struct wl_client *c, struct wl_resource *r) {
    F(r)->session_destroy = true; destroy(c, r);
}
static const struct ext_image_copy_capture_session_v1_interface session_impl = {
    .create_frame = create_frame, .destroy = session_destroy
};
static void create_session(struct wl_client *c, struct wl_resource *manager, uint32_t id, struct wl_resource *source, uint32_t options) {
    struct fixture *f = F(manager);
    if (!source || options) { f->bad = true; return; }
    struct wl_resource *r = wl_resource_create(c, &ext_image_copy_capture_session_v1_interface, 1, id);
    if (!r) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(r, &session_impl, f, NULL);
    int size = !strcmp(f->mode, "small-damage") ? 2 : 1;
    ext_image_copy_capture_session_v1_send_buffer_size(r, !strcmp(f->mode, "bad-size") ? 2 : size, size);
    ext_image_copy_capture_session_v1_send_shm_format(r, WL_SHM_FORMAT_XRGB8888);
    ext_image_copy_capture_session_v1_send_done(r);
}
static void cursor_session(struct wl_client *c, struct wl_resource *r, uint32_t id, struct wl_resource *s, struct wl_resource *p) {
    (void)id; (void)s; (void)p; F(r)->bad = true; wl_client_post_implementation_error(c, "unexpected cursor");
}
static const struct ext_image_copy_capture_manager_v1_interface copy_manager_impl = {
    .create_session = create_session, .create_pointer_cursor_session = cursor_session, .destroy = destroy
};
static void bind_copy(struct wl_client *c, void *data, uint32_t version, uint32_t id) {
    (void)version; struct wl_resource *r = wl_resource_create(c, &ext_image_copy_capture_manager_v1_interface, 1, id);
    if (!r) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(r, &copy_manager_impl, data, NULL);
}
static void log_protocol(void *data, enum wl_protocol_logger_type direction, const struct wl_protocol_logger_message *m) {
    struct fixture *f = data;
    if (direction == WL_PROTOCOL_LOGGER_REQUEST && m && m->resource && m->message &&
        !strcmp(wl_resource_get_class(m->resource), "wl_display") && !strcmp(m->message->name, "sync") &&
        f->frame_destroy && f->session_destroy && f->source_destroy) f->sync_after_destroy++;
}
static void client_destroyed(struct wl_listener *listener, void *data) {
    (void)data; struct fixture *f = wl_container_of(listener, f, client_destroyed);
    f->clients_gone++;
}
static void client_created(struct wl_listener *listener, void *data) {
    struct fixture *f = wl_container_of(listener, f, client_created);
    f->clients_created++;
    if (f->clients_created != 1) { f->bad = true; return; }
    f->client_destroyed.notify = client_destroyed;
    wl_client_add_destroy_listener(data, &f->client_destroyed);
}
int main(int argc, char **argv) {
    if (argc != 2 || (strcmp(argv[1], "ready") && strcmp(argv[1], "failed") &&
        strcmp(argv[1], "duplicate") && strcmp(argv[1], "bad-size") && strcmp(argv[1], "drop") &&
        strcmp(argv[1], "timeout") && strcmp(argv[1], "withhold-sync") &&
        strcmp(argv[1], "late-duplicate") && strcmp(argv[1], "late-malformed") &&
        strcmp(argv[1], "small-damage"))) return 2;
    struct fixture f = { .mode = argv[1] };
    f.display = wl_display_create();
    if (!f.display || wl_display_init_shm(f.display) || wl_display_add_socket(f.display, "orbit-fixture")) return 2;
    if (!wl_global_create(f.display, &ext_foreign_toplevel_list_v1_interface, 1, &f, bind_list) ||
        !wl_global_create(f.display, &ext_foreign_toplevel_image_capture_source_manager_v1_interface, 1, &f, bind_source) ||
        !wl_global_create(f.display, &ext_image_copy_capture_manager_v1_interface, 1, &f, bind_copy)) return 2;
    f.client_created.notify = client_created;
    wl_display_add_client_created_listener(f.display, &f.client_created);
    struct wl_protocol_logger *logger = wl_display_add_protocol_logger(f.display, log_protocol, &f);
    if (!logger) return 2;
    if (write(1, "R", 1) != 1) return 2;
    struct wl_event_loop *loop = wl_display_get_event_loop(f.display);
    for (unsigned i = 0; i < 500; ++i) {
        if (wl_event_loop_dispatch(loop, 10) < 0) break;
        /* Core handles sync internally. Its reply is queued in this dispatch;
         * withholding all later flushes prevents it reaching the helper. */
        if (!strcmp(f.mode, "withhold-sync") && f.sync_after_destroy) break;
        wl_display_flush_clients(f.display);
        if (f.clients_gone) break;
    }
    char report[5] = { f.captured ? '1' : '0', f.frame_destroy ? '1' : '0', f.session_destroy ? '1' : '0',
                       f.source_destroy ? '1' : '0', f.sync_after_destroy ? '1' : '0' };
    if (write(1, report, sizeof(report)) != sizeof(report)) f.bad = true;
    if (!strcmp(f.mode, "withhold-sync") && f.sync_after_destroy) {
        /* Keep connection open past helper deadline without dispatch or flush. */
        usleep(3500000);
    }
    wl_protocol_logger_destroy(logger);
    wl_display_destroy_clients(f.display);
    wl_display_destroy(f.display);
    return f.bad ? 2 : 0;
}
