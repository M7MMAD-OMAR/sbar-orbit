/* Log pathname UNIX socket calls inside a disposable HOME fixture only. */

#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <unistd.h>

static void record(const char *call, const struct sockaddr *address, socklen_t length,
                   int result, int saved_errno) {
    if (!address || address->sa_family != AF_UNIX ||
        length <= offsetof(struct sockaddr_un, sun_path)) return;
    const struct sockaddr_un *unix_address = (const struct sockaddr_un *)address;
    if (!unix_address->sun_path[0]) return;
    size_t path_length = strnlen(unix_address->sun_path, sizeof(unix_address->sun_path));
    if (path_length == sizeof(unix_address->sun_path)) return;
    const char *home = getenv("HOME");
    const char *log_path = getenv("ORBIT_SOCKET_TRACE");
    if (!home || !log_path) return;
    size_t home_length = strlen(home);
    if (strncmp(unix_address->sun_path, home, home_length) ||
        unix_address->sun_path[home_length] != '/') return;
    int fd = syscall(SYS_openat, AT_FDCWD, log_path, O_WRONLY | O_APPEND | O_CLOEXEC, 0);
    if (fd < 0) return;
    char line[512];
    int size = snprintf(line, sizeof(line), "%s result=%d errno=%d path=%.*s\n",
                        call, result, saved_errno, (int)path_length, unix_address->sun_path);
    if (size > 0) syscall(SYS_write, fd, line, size < (int)sizeof(line) ? size : (int)sizeof(line));
    syscall(SYS_close, fd);
}

int connect(int fd, const struct sockaddr *address, socklen_t length) {
    static int (*real_connect)(int, const struct sockaddr *, socklen_t);
    if (!real_connect) real_connect = dlsym(RTLD_NEXT, "connect");
    int result = real_connect(fd, address, length);
    int saved_errno = errno;
    record("connect", address, length, result, saved_errno);
    errno = saved_errno;
    return result;
}

int bind(int fd, const struct sockaddr *address, socklen_t length) {
    static int (*real_bind)(int, const struct sockaddr *, socklen_t);
    if (!real_bind) real_bind = dlsym(RTLD_NEXT, "bind");
    int result = real_bind(fd, address, length);
    int saved_errno = errno;
    record("bind", address, length, result, saved_errno);
    errno = saved_errno;
    return result;
}
