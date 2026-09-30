#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/audit.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define SELECTED_PATH "/tmp/orbit-probe/selected.sock"
#define ERR(x) do { perror(x); exit(1); } while (0)

static int send_fd(int channel, int fd) {
  char byte = 'F';
  struct iovec io = {&byte, 1};
  char control[CMSG_SPACE(sizeof(int))] = {0};
  struct msghdr msg = {.msg_iov = &io, .msg_iovlen = 1,
                       .msg_control = control, .msg_controllen = sizeof(control)};
  struct cmsghdr *item = CMSG_FIRSTHDR(&msg);
  item->cmsg_level = SOL_SOCKET;
  item->cmsg_type = SCM_RIGHTS;
  item->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(item), &fd, sizeof(fd));
  return sendmsg(channel, &msg, 0);
}

static int recv_fd(int channel) {
  char byte;
  struct iovec io = {&byte, 1};
  char control[CMSG_SPACE(sizeof(int))] = {0};
  struct msghdr msg = {.msg_iov = &io, .msg_iovlen = 1,
                       .msg_control = control, .msg_controllen = sizeof(control)};
  if (recvmsg(channel, &msg, 0) != 1) return -1;
  struct cmsghdr *item = CMSG_FIRSTHDR(&msg);
  if (!item || item->cmsg_level != SOL_SOCKET || item->cmsg_type != SCM_RIGHTS) return -1;
  int fd;
  memcpy(&fd, CMSG_DATA(item), sizeof(fd));
  return fd;
}

static int install_connect_filter(void) {
  struct sock_filter code[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_connect, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {.len = sizeof(code) / sizeof(code[0]), .filter = code};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return -1;
  return syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER,
                 SECCOMP_FILTER_FLAG_NEW_LISTENER, &program);
}

static int attempt(const char *name, const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) ERR("socket");
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  if (strlen(path) >= sizeof(addr.sun_path)) ERR("socket path too long");
  strcpy(addr.sun_path, path);
  errno = 0;
  int result = connect(fd, (struct sockaddr *)&addr, sizeof(addr));
  printf("%s_result=%d %s_errno=%d\n", name, result, name, errno);
  fflush(stdout);
  close(fd);
  return result == 0 ? 0 : errno;
}

static int send_datagram(const char *name, const char *path, int with_msg) {
  int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (fd < 0) ERR("datagram socket");
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  strcpy(addr.sun_path, path);
  char byte = 'x';
  int result;
  errno = 0;
  if (with_msg) {
    struct iovec io = {.iov_base = &byte, .iov_len = 1};
    struct msghdr msg = {.msg_name = &addr, .msg_namelen = sizeof(addr),
                         .msg_iov = &io, .msg_iovlen = 1};
    result = sendmsg(fd, &msg, 0);
  } else {
    result = sendto(fd, &byte, 1, 0, (struct sockaddr *)&addr, sizeof(addr));
  }
  printf("%s_result=%d %s_errno=%d\n", name, result, name, errno);
  fflush(stdout);
  close(fd);
  return result;
}

static int child_main(const char *self, int channel, const char *blocked_path,
                      const char *blocked_datagram) {
  int listener = install_connect_filter();
  if (listener < 0) ERR("seccomp listener");
  if (send_fd(channel, listener) != 1) ERR("send listener");
  close(listener);
  close(channel);
  printf("blocked_visible=%d\n", access(blocked_path, F_OK) == 0);
  fflush(stdout);
  int selected = attempt("selected", SELECTED_PATH);
  int blocked = attempt("blocked", blocked_path);
  int via_sendto = send_datagram("blocked_sendto", blocked_datagram, 0);
  int via_sendmsg = send_datagram("blocked_sendmsg", blocked_datagram, 1);
  pid_t nested = fork();
  if (nested < 0) ERR("fork nested");
  if (!nested) {
    char *args[] = {"/usr/bin/bwrap", "--bind", "/", "/", "--dev", "/dev",
                    "--proc", "/proc", "--bind", (char *)blocked_path,
                    SELECTED_PATH, "--", (char *)self, "nested", NULL};
    execv(args[0], args);
    _exit(127);
  }
  int status;
  if (waitpid(nested, &status, 0) < 0) ERR("wait nested");
  int nested_exit = WIFEXITED(status) ? WEXITSTATUS(status) : 128;
  printf("nested_exit=%d\n", nested_exit);
  fflush(stdout);
  return selected == 0 && blocked == EACCES && via_sendto == 1
         && via_sendmsg == 1 && nested_exit == 0 ? 0 : 1;
}

static int make_server(const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) ERR("server socket");
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  strcpy(addr.sun_path, path);
  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr))) ERR("server bind");
  if (listen(fd, 4)) ERR("server listen");
  if (fcntl(fd, F_SETFL, O_NONBLOCK)) ERR("server nonblock");
  return fd;
}

static int make_datagram_server(const char *path) {
  int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (fd < 0) ERR("datagram server socket");
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  strcpy(addr.sun_path, path);
  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr))) ERR("datagram server bind");
  if (fcntl(fd, F_SETFL, O_NONBLOCK)) ERR("datagram server nonblock");
  return fd;
}

static int drain_server(int fd) {
  int count = 0;
  for (;;) {
    int peer = accept4(fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (peer < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) return count;
      ERR("accept");
    }
    count++;
    close(peer);
  }
}

static int drain_datagrams(int fd) {
  int count = 0;
  char byte;
  for (;;) {
    if (recvfrom(fd, &byte, 1, 0, NULL, NULL) < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) return count;
      ERR("receive datagram");
    }
    count++;
  }
}

static int handle_one(int listener, int selected_handle, int naive) {
  struct seccomp_notif request = {0};
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &request)) return -1;
  struct seccomp_notif_resp response = {.id = request.id, .error = -EACCES};
  if (request.data.nr == __NR_connect && request.data.args[2] >= sizeof(sa_family_t)
      && request.data.args[2] <= sizeof(struct sockaddr_un)) {
    struct sockaddr_un addr = {0};
    struct iovec local = {.iov_base = &addr, .iov_len = request.data.args[2]};
    struct iovec remote = {.iov_base = (void *)(uintptr_t)request.data.args[1],
                           .iov_len = request.data.args[2]};
    if (process_vm_readv(request.pid, &local, 1, &remote, 1, 0) == (ssize_t)local.iov_len
        && addr.sun_family == AF_UNIX && addr.sun_path[0]
        && memchr(addr.sun_path, '\0', sizeof(addr.sun_path))) {
      if (!strcmp(addr.sun_path, SELECTED_PATH)) {
        int pidfd = syscall(__NR_pidfd_open, request.pid, 0);
        int duplicate = pidfd < 0 ? -1 : syscall(__NR_pidfd_getfd, pidfd,
                                                (int)request.data.args[0], 0);
        if (duplicate >= 0) {
          char resolved[sizeof(((struct sockaddr_un *)0)->sun_path)];
          if (naive) {
            snprintf(resolved, sizeof(resolved), "/proc/%u/root%s",
                     request.pid, SELECTED_PATH);
          } else {
            snprintf(resolved, sizeof(resolved), "/proc/self/fd/%d", selected_handle);
          }
          struct sockaddr_un broker_addr = {.sun_family = AF_UNIX};
          strcpy(broker_addr.sun_path, resolved);
          if (connect(duplicate, (struct sockaddr *)&broker_addr,
                      sizeof(broker_addr)) == 0) {
            response.error = 0;
          } else {
            response.error = -errno;
            fprintf(stderr, "broker_connect_errno=%d\n", errno);
          }
          close(duplicate);
        } else fprintf(stderr, "pidfd_getfd_errno=%d\n", errno);
        if (pidfd >= 0) close(pidfd);
      }
    }
  }
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, &response)) return -1;
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "nested")) {
    return attempt("nested_selected", SELECTED_PATH) == 0 ? 0 : 1;
  }
  if (argc == 5 && !strcmp(argv[1], "child")) {
    return child_main(argv[0], atoi(argv[2]), argv[3], argv[4]);
  }
  int naive = argc == 2 && !strcmp(argv[1], "naive");
  if (argc != 1 && !naive) return 2;
  char root[] = "/var/tmp/orbit-seccomp-probe-XXXXXX";
  if (!mkdtemp(root)) ERR("mkdtemp");
  char selected[256], blocked[256], blocked_datagram[256];
  snprintf(selected, sizeof(selected), "%s/selected.sock", root);
  snprintf(blocked, sizeof(blocked), "%s/blocked.sock", root);
  snprintf(blocked_datagram, sizeof(blocked_datagram), "%s/blocked-dgram.sock", root);
  int selected_server = make_server(selected);
  int blocked_server = make_server(blocked);
  int blocked_dgram_server = make_datagram_server(blocked_datagram);
  int selected_handle = open(selected, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (selected_handle < 0) ERR("open selected identity");
  int channel[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, channel)) ERR("socketpair");
  pid_t child = fork();
  if (child < 0) ERR("fork");
  if (!child) {
    close(channel[0]);
    fcntl(channel[1], F_SETFD, 0);
    char fd_text[16];
    snprintf(fd_text, sizeof(fd_text), "%d", channel[1]);
    char *args[] = {"/usr/bin/bwrap", "--bind", "/", "/", "--dev", "/dev",
                    "--proc", "/proc", "--tmpfs", "/tmp", "--dir", "/tmp/orbit-probe",
                    "--bind", selected, SELECTED_PATH, "--", argv[0], "child",
                    fd_text, blocked, blocked_datagram, NULL};
    execv(args[0], args);
    _exit(127);
  }
  close(channel[1]);
  int listener = recv_fd(channel[0]);
  close(channel[0]);
  if (listener < 0) ERR("receive listener");
  printf("broker_mode=%s\n", naive ? "naive" : "pinned");
  fflush(stdout);
  int status = 0;
  for (;;) {
    struct pollfd pfd = {.fd = listener, .events = POLLIN};
    int ready = poll(&pfd, 1, 200);
    if (ready > 0 && (pfd.revents & POLLIN)
        && handle_one(listener, selected_handle, naive)) ERR("handle notification");
    if (waitpid(child, &status, WNOHANG) == child) break;
  }
  close(listener);
  int selected_count = drain_server(selected_server);
  int blocked_count = drain_server(blocked_server);
  int blocked_datagrams = drain_datagrams(blocked_dgram_server);
  printf("selected_accepts=%d blocked_accepts=%d\n", selected_count, blocked_count);
  printf("blocked_datagrams=%d\n", blocked_datagrams);
  close(selected_server);
  close(blocked_server);
  close(blocked_dgram_server);
  close(selected_handle);
  unlink(selected);
  unlink(blocked);
  unlink(blocked_datagram);
  rmdir(root);
  printf("probe_exit=%d\n", WIFEXITED(status) ? WEXITSTATUS(status) : 128);
  return WIFEXITED(status) && !WEXITSTATUS(status)
         && selected_count == (naive ? 1 : 2)
         && blocked_count == (naive ? 1 : 0)
         && blocked_datagrams == 2 ? 0 : 1;
}
