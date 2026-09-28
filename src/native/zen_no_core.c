#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

__attribute__((constructor)) static void orbit_no_core(void) {
    if (prctl(PR_SET_DUMPABLE, 0) != 0 || prctl(PR_GET_DUMPABLE) != 0)
        _exit(125);

    const char *directory = getenv("ORBIT_NO_CORE_PROOFS");
    if (directory == NULL || directory[0] != '/')
        _exit(125);
    int parent = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent < 0)
        _exit(125);

    pid_t pid = getpid();
    char name[64];
    char contents[96];
    int name_size = snprintf(name, sizeof(name), "pid-%ld", (long)pid);
    int content_size = snprintf(contents, sizeof(contents), "pid=%ld\ndumpable=0\n", (long)pid);
    if (name_size <= 0 || (size_t)name_size >= sizeof(name) ||
        content_size <= 0 || (size_t)content_size >= sizeof(contents))
        _exit(125);

    int marker = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (marker < 0)
        _exit(125);
    if (write(marker, contents, (size_t)content_size) != content_size)
        _exit(125);
    if (close(marker) != 0 || close(parent) != 0)
        _exit(125);
}
