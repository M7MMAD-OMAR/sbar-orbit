#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

__attribute__((constructor)) static void orbit_no_core(void) {
    if (prctl(PR_SET_DUMPABLE, 0) != 0 || prctl(PR_GET_DUMPABLE) != 0)
        _exit(125);

    const char *directory = getenv("ORBIT_NO_CORE_PROOFS");
    if (directory == NULL)
        directory = "/orbit/zen/runtime/no-core-proofs";
    if (directory == NULL || directory[0] != '/')
        _exit(125);
    int parent = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent < 0)
        _exit(125);

    pid_t pid = getpid();
    char name[64];
    char temporary[96];
    char executable[512];
    char contents[640];
    struct timespec now;
    ssize_t executable_size = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (executable_size <= 0 || (size_t)executable_size >= sizeof(executable) - 1 ||
        clock_gettime(CLOCK_MONOTONIC, &now) != 0)
        _exit(125);
    executable[executable_size] = '\0';
    if (strchr(executable, '\n') != NULL)
        _exit(125);
    int name_size = snprintf(name, sizeof(name), "pid-%ld", (long)pid);
    int temporary_size = snprintf(temporary, sizeof(temporary), "pid-%ld.tmp-%lld-%ld",
        (long)pid, (long long)now.tv_sec, now.tv_nsec);
    int content_size = snprintf(contents, sizeof(contents), "pid=%ld\ndumpable=0\nexe=%s\n",
        (long)pid, executable);
    if (name_size <= 0 || (size_t)name_size >= sizeof(name) ||
        temporary_size <= 0 || (size_t)temporary_size >= sizeof(temporary) ||
        content_size <= 0 || (size_t)content_size >= sizeof(contents))
        _exit(125);

    int marker = openat(parent, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (marker < 0)
        _exit(125);
    if (write(marker, contents, (size_t)content_size) != content_size)
        _exit(125);
    if (close(marker) != 0 || renameat(parent, temporary, parent, name) != 0 || close(parent) != 0)
        _exit(125);
}
