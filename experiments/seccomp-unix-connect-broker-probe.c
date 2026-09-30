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
#define SELECTED_DGRAM_PATH "/tmp/orbit-probe/selected-dgram.sock"
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

static int install_connect_filter(int broker_datagram) {
  struct sock_filter code[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_connect, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_filter datagram_code[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_connect, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendto, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = broker_datagram
    ? (struct sock_fprog){.len = sizeof(datagram_code) / sizeof(datagram_code[0]), .filter = datagram_code}
    : (struct sock_fprog){.len = sizeof(code) / sizeof(code[0]), .filter = code};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return -1;
  return syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER,
                 SECCOMP_FILTER_FLAG_NEW_LISTENER, &program);
}

static int install_strict_send_filter(int broker_datagram) {
  struct sock_filter code[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendto, 4, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmsg, 3, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmmsg, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_enter, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_filter broker_code[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmsg, 3, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmmsg, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_enter, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = broker_datagram
    ? (struct sock_fprog){.len = sizeof(broker_code) / sizeof(broker_code[0]), .filter = broker_code}
    : (struct sock_fprog){.len = sizeof(code) / sizeof(code[0]), .filter = code};
  return syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program);
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

static int send_datagram(const char *name, const char *path, int method) {
  int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (fd < 0) ERR("datagram socket");
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  strcpy(addr.sun_path, path);
  char byte = 'x';
  int result;
  errno = 0;
  if (method) {
    struct iovec io = {.iov_base = &byte, .iov_len = 1};
    struct msghdr msg = {.msg_name = &addr, .msg_namelen = sizeof(addr),
                         .msg_iov = &io, .msg_iovlen = 1};
    if (method == 2) {
      struct mmsghdr batch = {.msg_hdr = msg};
      result = sendmmsg(fd, &batch, 1, 0);
    } else {
      result = sendmsg(fd, &msg, 0);
    }
  } else {
    result = sendto(fd, &byte, 1, 0, (struct sockaddr *)&addr, sizeof(addr));
  }
  int send_errno = errno;
  printf("%s_result=%d %s_errno=%d\n", name, result, name, send_errno);
  fflush(stdout);
  close(fd);
  return result < 0 ? -send_errno : result;
}

static int child_main(const char *self, int channel, const char *blocked_path,
                      const char *blocked_datagram, int mode) {
  int broker_datagram = mode == 2;
  int strict = mode != 0;
  int listener = install_connect_filter(broker_datagram);
  if (listener < 0) ERR("seccomp listener");
  if (send_fd(channel, listener) != 1) ERR("send listener");
  close(listener);
  close(channel);
  if (strict && install_strict_send_filter(broker_datagram)) ERR("strict send filter");
  printf("blocked_visible=%d\n", access(blocked_path, F_OK) == 0);
  fflush(stdout);
  int selected = attempt("selected", SELECTED_PATH);
  int blocked = attempt("blocked", blocked_path);
  int via_sendto = send_datagram("blocked_sendto", blocked_datagram, 0);
  int via_sendmsg = send_datagram("blocked_sendmsg", blocked_datagram, 1);
  int via_sendmmsg = send_datagram("blocked_sendmmsg", blocked_datagram, 2);
  int selected_datagram = broker_datagram
    ? send_datagram("selected_sendto", SELECTED_DGRAM_PATH, 0) : 0;
  pid_t nested = fork();
  if (nested < 0) ERR("fork nested");
  if (!nested) {
    char *stream_args[] = {"/usr/bin/bwrap", "--bind", "/", "/", "--dev", "/dev",
                           "--proc", "/proc", "--bind", (char *)blocked_path,
                           SELECTED_PATH, "--", (char *)self, "nested", NULL};
    char *datagram_args[] = {"/usr/bin/bwrap", "--bind", "/", "/", "--dev", "/dev",
                             "--proc", "/proc", "--bind", (char *)blocked_path,
                             SELECTED_PATH, "--bind", (char *)blocked_datagram,
                             SELECTED_DGRAM_PATH, "--", (char *)self, "nested-dgram", NULL};
    char **args = broker_datagram ? datagram_args : stream_args;
    execv(args[0], args);
    _exit(127);
  }
  int status;
  if (waitpid(nested, &status, 0) < 0) ERR("wait nested");
  int nested_exit = WIFEXITED(status) ? WEXITSTATUS(status) : 128;
  printf("nested_exit=%d\n", nested_exit);
  fflush(stdout);
  return selected == 0 && blocked == EACCES
         && via_sendto == (strict ? -EACCES : 1)
         && via_sendmsg == (strict ? -EACCES : 1)
         && via_sendmmsg == (strict ? -EACCES : 1)
         && selected_datagram == (broker_datagram ? 1 : 0)
         && nested_exit == 0 ? 0 : 1;
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
  int enabled = 1;
  if (setsockopt(fd, SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled))) ERR("datagram credentials");
  if (fcntl(fd, F_SETFL, O_NONBLOCK)) ERR("datagram server nonblock");
  return fd;
}

static int drain_server(int fd, int *all_broker_pid) {
  int count = 0;
  for (;;) {
    int peer = accept4(fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (peer < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) return count;
      ERR("accept");
    }
    if (all_broker_pid) {
      struct ucred credentials = {0};
      socklen_t length = sizeof(credentials);
      if (getsockopt(peer, SOL_SOCKET, SO_PEERCRED, &credentials, &length) ||
          length != sizeof(credentials) || credentials.pid != getpid())
        *all_broker_pid = 0;
    }
    count++;
    close(peer);
  }
}

static int drain_datagrams(int fd, int *all_broker_pid) {
  int count = 0;
  char byte;
  for (;;) {
    struct iovec io = {.iov_base = &byte, .iov_len = 1};
    char control[CMSG_SPACE(sizeof(struct ucred))] = {0};
    struct msghdr msg = {.msg_iov = &io, .msg_iovlen = 1,
                         .msg_control = control, .msg_controllen = sizeof(control)};
    if (recvmsg(fd, &msg, 0) < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) return count;
      ERR("receive datagram");
    }
    if (all_broker_pid) {
      struct cmsghdr *item = CMSG_FIRSTHDR(&msg);
      struct ucred credentials = {0};
      if (!item || item->cmsg_level != SOL_SOCKET || item->cmsg_type != SCM_CREDENTIALS)
        *all_broker_pid = 0;
      else {
        memcpy(&credentials, CMSG_DATA(item), sizeof(credentials));
        if (credentials.pid != getpid()) *all_broker_pid = 0;
      }
    }
    count++;
  }
}

static int handle_one(int listener, int selected_handle, int selected_dgram_handle,
                      int naive, int broker_datagram) {
  struct seccomp_notif request = {0};
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &request)) return -1;
  struct seccomp_notif_resp response = {.id = request.id, .error = -EACCES};
  int pidfd = syscall(__NR_pidfd_open, request.pid, 0);
  int live = pidfd >= 0 && ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id) == 0;
  if (broker_datagram && request.data.nr == __NR_sendto &&
      live &&
      request.data.args[2] > 0 && request.data.args[2] <= 4096 &&
      request.data.args[3] == 0 &&
      request.data.args[5] >= sizeof(sa_family_t) &&
      request.data.args[5] <= sizeof(struct sockaddr_un)) {
    struct sockaddr_un addr = {0};
    struct iovec local_addr = {.iov_base = &addr, .iov_len = request.data.args[5]};
    struct iovec remote_addr = {.iov_base = (void *)(uintptr_t)request.data.args[4],
                                .iov_len = request.data.args[5]};
    char payload[4096];
    struct iovec local_data = {.iov_base = payload, .iov_len = request.data.args[2]};
    struct iovec remote_data = {.iov_base = (void *)(uintptr_t)request.data.args[1],
                                .iov_len = request.data.args[2]};
    if (process_vm_readv(request.pid, &local_addr, 1, &remote_addr, 1, 0) ==
          (ssize_t)local_addr.iov_len && addr.sun_family == AF_UNIX &&
        addr.sun_path[0] && memchr(addr.sun_path, '\0', sizeof(addr.sun_path)) &&
        !strcmp(addr.sun_path, SELECTED_DGRAM_PATH) &&
        process_vm_readv(request.pid, &local_data, 1, &remote_data, 1, 0) ==
          (ssize_t)local_data.iov_len &&
        ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id) == 0) {
      int duplicate = syscall(__NR_pidfd_getfd, pidfd, (int)request.data.args[0], 0);
      if (duplicate >= 0) {
        char selected_path[sizeof(addr.sun_path)];
        snprintf(selected_path, sizeof(selected_path), "/proc/self/fd/%d", selected_dgram_handle);
        struct sockaddr_un selected_addr = {.sun_family = AF_UNIX};
        strcpy(selected_addr.sun_path, selected_path);
        if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id) == 0) {
          ssize_t sent = sendto(duplicate, payload, local_data.iov_len, 0,
                                (struct sockaddr *)&selected_addr, sizeof(selected_addr));
          if (sent >= 0) { response.error = 0; response.val = sent; }
          else response.error = -errno;
        }
        close(duplicate);
      }
    }
  }
  if (live && request.data.nr == __NR_connect && request.data.args[2] >= sizeof(sa_family_t)
      && request.data.args[2] <= sizeof(struct sockaddr_un)) {
    struct sockaddr_un addr = {0};
    struct iovec local = {.iov_base = &addr, .iov_len = request.data.args[2]};
    struct iovec remote = {.iov_base = (void *)(uintptr_t)request.data.args[1],
                           .iov_len = request.data.args[2]};
    if (process_vm_readv(request.pid, &local, 1, &remote, 1, 0) == (ssize_t)local.iov_len
        && addr.sun_family == AF_UNIX && addr.sun_path[0]
        && memchr(addr.sun_path, '\0', sizeof(addr.sun_path))) {
      if (!strcmp(addr.sun_path, SELECTED_PATH)) {
        int duplicate = syscall(__NR_pidfd_getfd, pidfd, (int)request.data.args[0], 0);
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
          if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id) == 0) {
            if (connect(duplicate, (struct sockaddr *)&broker_addr,
                        sizeof(broker_addr)) == 0) {
              response.error = 0;
            } else {
              response.error = -errno;
              fprintf(stderr, "broker_connect_errno=%d\n", errno);
            }
          }
          close(duplicate);
        } else fprintf(stderr, "pidfd_getfd_errno=%d\n", errno);
      }
    }
  }
  if (pidfd >= 0) close(pidfd);
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, &response)) return -1;
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "nested")) {
    return attempt("nested_selected", SELECTED_PATH) == 0 ? 0 : 1;
  }
  if (argc == 2 && !strcmp(argv[1], "nested-dgram")) {
    int stream = attempt("nested_selected", SELECTED_PATH);
    int datagram = send_datagram("nested_selected_sendto", SELECTED_DGRAM_PATH, 0);
    return stream == 0 && datagram == 1 ? 0 : 1;
  }
  if (argc == 6 && !strcmp(argv[1], "child")) {
    return child_main(argv[0], atoi(argv[2]), argv[3], argv[4], atoi(argv[5]));
  }
  int naive = argc == 2 && !strcmp(argv[1], "naive");
  int strict = argc == 2 && !strcmp(argv[1], "strict");
  int broker_datagram = argc == 2 && !strcmp(argv[1], "broker-dgram");
  if (argc != 1 && !naive && !strict && !broker_datagram) return 2;
  char root[] = "/var/tmp/orbit-seccomp-probe-XXXXXX";
  if (!mkdtemp(root)) ERR("mkdtemp");
  char selected[256], selected_datagram[256], blocked[256], blocked_datagram[256];
  snprintf(selected, sizeof(selected), "%s/selected.sock", root);
  snprintf(selected_datagram, sizeof(selected_datagram), "%s/selected-dgram.sock", root);
  snprintf(blocked, sizeof(blocked), "%s/blocked.sock", root);
  snprintf(blocked_datagram, sizeof(blocked_datagram), "%s/blocked-dgram.sock", root);
  int selected_server = make_server(selected);
  int selected_dgram_server = make_datagram_server(selected_datagram);
  int blocked_server = make_server(blocked);
  int blocked_dgram_server = make_datagram_server(blocked_datagram);
  int selected_handle = open(selected, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (selected_handle < 0) ERR("open selected identity");
  int selected_dgram_handle = open(selected_datagram, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (selected_dgram_handle < 0) ERR("open selected datagram identity");
  int channel[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, channel)) ERR("socketpair");
  pid_t child = fork();
  if (child < 0) ERR("fork");
  if (!child) {
    close(channel[0]);
    fcntl(channel[1], F_SETFD, 0);
    char fd_text[16];
    snprintf(fd_text, sizeof(fd_text), "%d", channel[1]);
    char mode_text[] = "0";
    if (strict) mode_text[0] = '1';
    if (broker_datagram) mode_text[0] = '2';
    char *args[] = {"/usr/bin/bwrap", "--bind", "/", "/", "--dev", "/dev",
                    "--proc", "/proc", "--tmpfs", "/tmp", "--dir", "/tmp/orbit-probe",
                    "--bind", selected, SELECTED_PATH,
                    "--bind", selected_datagram, SELECTED_DGRAM_PATH, "--", argv[0], "child",
                    fd_text, blocked, blocked_datagram, mode_text, NULL};
    execv(args[0], args);
    _exit(127);
  }
  close(channel[1]);
  int listener = recv_fd(channel[0]);
  close(channel[0]);
  if (listener < 0) ERR("receive listener");
  printf("broker_mode=%s\n", naive ? "naive" : strict ? "pinned-strict"
         : broker_datagram ? "pinned-datagram" : "pinned");
  fflush(stdout);
  int status = 0;
  for (;;) {
    struct pollfd pfd = {.fd = listener, .events = POLLIN};
    int ready = poll(&pfd, 1, 200);
    if (ready > 0 && (pfd.revents & POLLIN)
        && handle_one(listener, selected_handle, selected_dgram_handle,
                      naive, broker_datagram)) ERR("handle notification");
    if (waitpid(child, &status, WNOHANG) == child) break;
  }
  close(listener);
  int selected_stream_broker_pid = 1;
  int selected_count = drain_server(selected_server, &selected_stream_broker_pid);
  int selected_dgram_broker_pid = 1;
  int selected_datagrams = drain_datagrams(selected_dgram_server, &selected_dgram_broker_pid);
  int blocked_count = drain_server(blocked_server, NULL);
  int blocked_datagrams = drain_datagrams(blocked_dgram_server, NULL);
  printf("selected_accepts=%d blocked_accepts=%d\n", selected_count, blocked_count);
  printf("selected_stream_broker_pid=%d\n", selected_stream_broker_pid);
  printf("selected_datagrams=%d blocked_datagrams=%d\n", selected_datagrams, blocked_datagrams);
  if (broker_datagram) printf("selected_dgram_broker_pid=%d\n", selected_dgram_broker_pid);
  close(selected_server);
  close(selected_dgram_server);
  close(blocked_server);
  close(blocked_dgram_server);
  close(selected_handle);
  close(selected_dgram_handle);
  unlink(selected);
  unlink(selected_datagram);
  unlink(blocked);
  unlink(blocked_datagram);
  rmdir(root);
  printf("probe_exit=%d\n", WIFEXITED(status) ? WEXITSTATUS(status) : 128);
  return WIFEXITED(status) && !WEXITSTATUS(status)
         && selected_count == (naive ? 1 : 2)
         && selected_stream_broker_pid
         && blocked_count == (naive ? 1 : 0)
         && selected_datagrams == (broker_datagram ? 2 : 0)
         && (!broker_datagram || selected_dgram_broker_pid)
         && blocked_datagrams == (strict || broker_datagram ? 0 : 3) ? 0 : 1;
}
