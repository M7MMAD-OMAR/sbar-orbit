#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/audit.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <net/if.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/pidfd.h>
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
#define NATIVE_SYSCALL \
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)), \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS), \
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)), \
  BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS)
static int connected_messages;
static int connected_rights;
static int unexpected_stream_bytes;
static uint64_t approved_cookies[32];
static size_t approved_cookie_count;
static const char *selected_stream_path = SELECTED_PATH;
// Optional second pinned stream endpoint for the owned-display experiment.
static const char *additional_stream_path;
static int additional_stream_handle = -1;
static int private_bus_credentials;
static uint64_t private_bus_cookies[32];
static unsigned char private_bus_handshakes[32];
static size_t private_bus_cookie_count;
static size_t forwarded_bus_credentials;
static size_t forwarded_bus_data;
static int broker_metadata_audit;
static int private_loopback_netlink;
static uint64_t broker_netns_cookie;
static size_t forwarded_loopback;
static int private_socket_pairs;
static uint64_t private_pair_cookies[256];
static size_t private_pair_cookie_count;
static size_t forwarded_pair_messages;
static volatile sig_atomic_t broker_sigpipe_count;

static void record_sigpipe(int signal_number) {
  (void)signal_number;
  broker_sigpipe_count++;
}

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

static int install_connect_filter(int broker_datagram, int broker_connected, int channel) {
  struct sock_filter code[] = {
    NATIVE_SYSCALL,
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_connect, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_filter datagram_code[] = {
    NATIVE_SYSCALL,
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_connect, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendto, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_filter connected_code[] = {
    NATIVE_SYSCALL,
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, private_socket_pairs ? __NR_socketpair : (unsigned)-1, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_connect, 5, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendto, 4, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmsg, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (unsigned)channel, 2, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = broker_connected
    ? (struct sock_fprog){.len = sizeof(connected_code) / sizeof(connected_code[0]), .filter = connected_code}
    : broker_datagram
    ? (struct sock_fprog){.len = sizeof(datagram_code) / sizeof(datagram_code[0]), .filter = datagram_code}
    : (struct sock_fprog){.len = sizeof(code) / sizeof(code[0]), .filter = code};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return -1;
  return syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER,
                 SECCOMP_FILTER_FLAG_NEW_LISTENER, &program);
}

static int install_strict_send_filter(int broker_datagram, int broker_connected, int channel) {
  struct sock_filter code[] = {
    NATIVE_SYSCALL,
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendto, 4, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmsg, 3, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmmsg, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_enter, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_filter broker_code[] = {
    NATIVE_SYSCALL,
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmsg, 3, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmmsg, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_enter, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  // Permanently close the listener-handoff exception before target operations.
  // Reusing its numeric descriptor cannot regain the early sendmsg allowance.
  struct sock_filter connected_code[] = {
    NATIVE_SYSCALL,
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmsg, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (unsigned)channel, 5, 6),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmmsg, 3, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_enter, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = broker_connected
    ? (struct sock_fprog){.len = sizeof(connected_code) / sizeof(connected_code[0]), .filter = connected_code}
    : broker_datagram
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

static int send_connected(int handoff_fd, int probe_denials, int send_flags);

static void *thread_attempt(void *unused) {
  (void)unused;
  int result = send_connected(-1, 0, MSG_DONTWAIT | MSG_NOSIGNAL);
  printf("thread_connected_sendmsg_result=%d\n", result);
  fflush(stdout);
  return (void *)(intptr_t)(result == 2 ? 0 : 1);
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

static int send_connected(int handoff_fd, int probe_denials, int send_flags) {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  strcpy(addr.sun_path, SELECTED_PATH);
  if (fd < 0 || connect(fd, (struct sockaddr *)&addr, sizeof(addr))) ERR("connected fixture");
  int pipe_fds[2];
  if (pipe2(pipe_fds, O_CLOEXEC) || write(pipe_fds[1], "K", 1) != 1) ERR("rights fixture");
  close(pipe_fds[1]);
  char first = 'A', second = 'B';
  struct iovec io[] = {{&first, 1}, {&second, 1}};
  char control[CMSG_SPACE(sizeof(int))] = {0};
  struct msghdr msg = {.msg_iov = io, .msg_iovlen = 2,
                       .msg_control = control, .msg_controllen = sizeof(control)};
  struct cmsghdr *item = CMSG_FIRSTHDR(&msg);
  item->cmsg_level = SOL_SOCKET; item->cmsg_type = SCM_RIGHTS;
  item->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(item), &pipe_fds[0], sizeof(int));
  errno = 0;
  int sent = sendmsg(fd, &msg, send_flags);
  printf("connected_sendmsg_result=%d connected_sendmsg_errno=%d connected_sendmsg_flags=%d\n", sent, errno, send_flags);
  fflush(stdout);
  int denied = 1;
  if (probe_denials) {
    char oversized[4097] = {0};
    struct iovec large = {oversized, sizeof(oversized)};
    struct msghdr large_message = {.msg_iov = &large, .msg_iovlen = 1};
    errno = 0;
    int oversized_result = sendmsg(fd, &large_message, 0);
    int oversized_errno = errno;
    int device = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (device < 0) ERR("device rights fixture");
    errno = 0;
    int device_result = send_fd(fd, device);
    int device_errno = errno;
    close(device);
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair)) ERR("unapproved pair");
    errno = 0;
    int pair_result = sendmsg(pair[0], &msg, 0);
    int pair_errno = errno;
    close(pair[0]); close(pair[1]);
    if (dup2(fd, handoff_fd) != handoff_fd) ERR("reuse handoff descriptor");
    errno = 0;
    int reuse_result = sendmsg(handoff_fd, &msg, 0);
    int reuse_errno = errno;
    if (handoff_fd != fd) close(handoff_fd);
    int reused_fd = fd;
    close(fd);
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair)) ERR("reused descriptor pair");
    if (dup2(pair[0], reused_fd) != reused_fd) ERR("reuse approved descriptor number");
    errno = 0;
    int number_result = sendmsg(reused_fd, &msg, 0);
    int number_errno = errno;
    for (size_t i = 0; i < 2; i++) if (pair[i] != reused_fd) close(pair[i]);
    printf("oversized_sendmsg_result=%d oversized_sendmsg_errno=%d\n", oversized_result, oversized_errno);
    printf("device_rights_result=%d device_rights_errno=%d\n", device_result, device_errno);
    printf("unapproved_pair_result=%d unapproved_pair_errno=%d\n", pair_result, pair_errno);
    printf("handoff_reuse_result=%d handoff_reuse_errno=%d\n", reuse_result, reuse_errno);
    printf("descriptor_reuse_result=%d descriptor_reuse_errno=%d\n", number_result, number_errno);
    fflush(stdout);
    denied = oversized_result == -1 && oversized_errno == EACCES && device_result == -1 && device_errno == EACCES
      && pair_result == -1 && pair_errno == EACCES && reuse_result == -1 && reuse_errno == EACCES
      && number_result == -1 && number_errno == EACCES;
  }
  close(pipe_fds[0]); close(fd);
  return denied ? sent : -1;
}

static int send_disconnected(void) {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  strcpy(addr.sun_path, SELECTED_PATH);
  if (fd < 0 || connect(fd, (struct sockaddr *)&addr, sizeof(addr))) ERR("disconnect fixture");
  if (shutdown(fd, SHUT_WR)) ERR("disconnect shutdown");
  char byte = 'X';
  struct iovec io = {&byte, 1};
  struct msghdr msg = {.msg_iov = &io, .msg_iovlen = 1};
  errno = 0;
  int sent = sendmsg(fd, &msg, 0);
  int send_errno = errno;
  printf("disconnected_sendmsg_result=%d disconnected_sendmsg_errno=%d\n", sent, send_errno);
  fflush(stdout);
  close(fd);
  return sent == -1 && send_errno == EPIPE && attempt("after_disconnect", SELECTED_PATH) == 0;
}

static int send_wrong_type(void) {
  int pair[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair)) ERR("wrong-type pair");
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  strcpy(addr.sun_path, SELECTED_DGRAM_PATH);
  errno = 0;
  int sent = sendto(pair[0], "T", 1, 0, (struct sockaddr *)&addr, sizeof(addr));
  int send_errno = errno;
  char byte;
  int received = recv(pair[1], &byte, 1, MSG_DONTWAIT);
  printf("wrong_type_sendto_result=%d wrong_type_sendto_errno=%d wrong_type_received=%d\n",
         sent, send_errno, received);
  fflush(stdout);
  close(pair[0]); close(pair[1]);
  return sent == -1 && send_errno == EACCES && received == -1;
}

static int child_main(const char *self, int channel, const char *blocked_path,
                      const char *blocked_datagram, int mode) {
  int broker_connected = mode == 3 || mode == 5;
  int broker_datagram = mode == 2 || broker_connected;
  int strict = mode != 0;
  int listener = install_connect_filter(broker_datagram, broker_connected, channel);
  if (listener < 0) ERR("seccomp listener");
  if (send_fd(channel, listener) != 1) ERR("send listener");
  close(listener);
  close(channel);
  if (strict && install_strict_send_filter(broker_datagram, broker_connected, channel)) ERR("strict send filter");
  printf("blocked_visible=%d\n", access(blocked_path, F_OK) == 0);
  fflush(stdout);
  int selected = attempt("selected", SELECTED_PATH);
  int blocked = attempt("blocked", blocked_path);
  int via_sendto = send_datagram("blocked_sendto", blocked_datagram, 0);
  int via_sendmsg = send_datagram("blocked_sendmsg", blocked_datagram, 1);
  int via_sendmmsg = send_datagram("blocked_sendmmsg", blocked_datagram, 2);
  int selected_datagram = broker_datagram
    ? send_datagram("selected_sendto", SELECTED_DGRAM_PATH, 0) : 0;
  int connected = mode == 4 || broker_connected ? send_connected(channel, broker_connected, 0) : 2;
  int threaded = 1;
  if (broker_connected) {
    pthread_t thread;
    void *result;
    if (pthread_create(&thread, NULL, thread_attempt, NULL) || pthread_join(thread, &result)) ERR("thread fixture");
    threaded = (intptr_t)result == 0;
  }
  int disconnected = mode != 5 || send_disconnected();
  int wrong_type = mode != 5 || send_wrong_type();
  int x32_denied = 1;
  if (broker_connected) {
    pid_t x32 = fork();
    if (x32 < 0) ERR("fork x32 probe");
    if (!x32) { syscall(__NR_getpid | 0x40000000); _exit(0); }
    int x32_status;
    if (waitpid(x32, &x32_status, 0) < 0) ERR("wait x32 probe");
    int x32_signal = WIFSIGNALED(x32_status) ? WTERMSIG(x32_status) : 0;
    printf("x32_signal=%d\n", x32_signal);
    fflush(stdout);
    x32_denied = x32_signal == SIGSYS;
  }
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
         && connected == 2
         && x32_denied
         && threaded
         && disconnected
         && wrong_type
         && nested_exit == 0 ? 0 : 1;
}

static int make_server(const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) ERR("server socket");
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  strcpy(addr.sun_path, path);
  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr))) ERR("server bind");
  if (listen(fd, 16)) ERR("server listen");
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
    char payload[2] = {0};
    struct iovec io = {payload, sizeof(payload)};
    char control[CMSG_SPACE(sizeof(int))] = {0};
    struct msghdr msg = {.msg_iov = &io, .msg_iovlen = 1,
                         .msg_control = control, .msg_controllen = sizeof(control)};
    ssize_t received = recvmsg(peer, &msg, MSG_CMSG_CLOEXEC);
    struct cmsghdr *item = CMSG_FIRSTHDR(&msg);
    if (received == 2 && !memcmp(payload, "AB", 2)) connected_messages++;
    if (item && item->cmsg_level == SOL_SOCKET && item->cmsg_type == SCM_RIGHTS &&
        item->cmsg_len == CMSG_LEN(sizeof(int)) && !(msg.msg_flags & MSG_CTRUNC)) {
      int passed;
      memcpy(&passed, CMSG_DATA(item), sizeof(passed));
      char marker = 0;
      if (read(passed, &marker, 1) == 1 && marker == 'K') connected_rights++;
      close(passed);
    }
    char extra[8192];
    ssize_t trailing = recv(peer, extra, sizeof(extra), MSG_DONTWAIT);
    if (trailing > 0) unexpected_stream_bytes += trailing;
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

static int copy_child(pid_t pid, void *target, uintptr_t source, size_t size) {
  struct iovec local = {target, size}, remote = {(void *)source, size};
  return process_vm_readv(pid, &local, 1, &remote, 1, 0) == (ssize_t)size;
}

static int socket_cookie(int fd, uint64_t *cookie) {
  socklen_t length = sizeof(*cookie);
  return !getsockopt(fd, SOL_SOCKET, SO_COOKIE, cookie, &length) && length == sizeof(*cookie);
}

static int unix_socket_type(int fd, int expected_type) {
  int domain = 0, type = 0;
  socklen_t domain_length = sizeof(domain), type_length = sizeof(type);
  return !getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &domain, &domain_length)
    && domain_length == sizeof(domain) && domain == AF_UNIX
    && !getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &type_length)
    && type_length == sizeof(type) && type == expected_type;
}

static int approved_socket(int fd) {
  uint64_t cookie;
  if (!socket_cookie(fd, &cookie)) return 0;
  for (size_t i = 0; i < approved_cookie_count; i++)
    if (approved_cookies[i] == cookie) return 1;
  return 0;
}

static int private_bus_credential_slot(int fd, pid_t tid, struct ucred *credentials) {
  uint64_t cookie;
  if (!private_bus_credentials || !socket_cookie(fd, &cookie)) return -1;
  size_t slot = 0;
  for (; slot < private_bus_cookie_count; slot++) if (private_bus_cookies[slot] == cookie) break;
  if (slot == private_bus_cookie_count || private_bus_handshakes[slot]) return -1;
  char path[64], line[256];
  snprintf(path, sizeof(path), "/proc/%d/status", tid);
  FILE *status = fopen(path, "r");
  if (!status) return -1;
  unsigned int tgid = 0, uid = (unsigned int)-1, gid = (unsigned int)-1;
  while (fgets(line, sizeof(line), status)) {
    if (!strncmp(line, "Tgid:", 5)) sscanf(line + 5, "%u", &tgid);
    if (!strncmp(line, "Uid:", 4)) sscanf(line + 4, "%u", &uid);
    if (!strncmp(line, "Gid:", 4)) sscanf(line + 4, "%u", &gid);
  }
  fclose(status);
  if (!tgid || credentials->pid <= 0 || (unsigned int)credentials->pid != tgid ||
      credentials->uid != uid || credentials->gid != gid || uid != getuid() || gid != getgid()) return -1;
  // Explicit experiment semantics: the private bus sees the connecting broker,
  // not the application's PID. Never claim transparent process identity.
  credentials->pid = getpid();
  credentials->uid = getuid(); credentials->gid = getgid();
  return (int)slot;
}

static int broker_created_pair(int fd) {
  uint64_t cookie;
  if (!private_socket_pairs || !socket_cookie(fd, &cookie)) return 0;
  for (size_t i = 0; i < private_pair_cookie_count; i++) if (private_pair_cookies[i] == cookie) return 1;
  return 0;
}

static void create_private_pair(int listener, struct seccomp_notif *request,
                                struct seccomp_notif_resp *response) {
  int type = (int)request->data.args[1], original[2], remote_fds[2];
  int base_type = type & ~(SOCK_CLOEXEC | SOCK_NONBLOCK);
  if (request->data.args[0] != AF_UNIX || request->data.args[2] ||
      (base_type != SOCK_STREAM && base_type != SOCK_SEQPACKET) || private_pair_cookie_count > 254) return;
  // Pin the target memory handle, then revalidate the notification before any
  // writes. Numeric PID reuse cannot retarget this already-open memory handle.
  char memory_path[64];
  snprintf(memory_path, sizeof(memory_path), "/proc/%u/mem", request->pid);
  int memory = open(memory_path, O_RDWR | O_CLOEXEC);
  off_t offset = (off_t)request->data.args[3];
  if (memory < 0) { response->error = -errno; return; }
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request->id) ||
      pread(memory, original, sizeof(original), offset) != sizeof(original) ||
      pwrite(memory, original, sizeof(original), offset) != sizeof(original)) {
    response->error = -EFAULT; close(memory); return;
  }
  int pair[2]; uint64_t cookies[2];
  if (socketpair(AF_UNIX, type | SOCK_CLOEXEC, 0, pair)) { response->error = -errno; close(memory); return; }
  if (!socket_cookie(pair[0], &cookies[0]) || !socket_cookie(pair[1], &cookies[1])) goto done;
  for (size_t i = 0; i < 2; i++) {
    struct seccomp_notif_addfd addition = {.id = request->id, .srcfd = (unsigned int)pair[i],
      .newfd_flags = (type & SOCK_CLOEXEC) ? O_CLOEXEC : 0};
    remote_fds[i] = ioctl(listener, SECCOMP_IOCTL_NOTIF_ADDFD, &addition);
    if (remote_fds[i] < 0) { response->error = -errno; goto done; }
  }
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request->id) ||
      pwrite(memory, remote_fds, sizeof(remote_fds), offset) != sizeof(remote_fds)) { response->error = -EFAULT; goto done; }
  private_pair_cookies[private_pair_cookie_count++] = cookies[0];
  private_pair_cookies[private_pair_cookie_count++] = cookies[1];
  response->error = 0; response->val = 0;
done:
  close(pair[0]); close(pair[1]); close(memory);
}

static void send_connected_copy(int listener, int pidfd, struct seccomp_notif *request,
                                struct seccomp_notif_resp *response) {
  struct msghdr source = {0};
  struct iovec vectors[8];
  char payload[4096];
  union { struct cmsghdr align; char bytes[CMSG_SPACE(4 * sizeof(int))]; } control = {0};
  int rights[4] = {-1, -1, -1, -1};
  size_t rights_count = 0, total = 0;
  int duplicate = -1;
  int credential_slot = -1;
  const uint64_t allowed_flags = MSG_DONTWAIT | MSG_NOSIGNAL;
  if (broker_metadata_audit && copy_child(request->pid, &source, request->data.args[1], sizeof(source)))
    fprintf(stderr, "broker_send_shape fd=%llu flags=%llu vectors=%zu controlBytes=%zu named=%d\n",
      (unsigned long long)request->data.args[0], (unsigned long long)request->data.args[2],
      source.msg_iovlen, source.msg_controllen, source.msg_name != NULL);
  if ((request->data.args[2] & ~allowed_flags) ||
      !copy_child(request->pid, &source, request->data.args[1], sizeof(source)) ||
      source.msg_name || source.msg_namelen || !source.msg_iovlen || source.msg_iovlen > 8 ||
      source.msg_controllen > sizeof(control.bytes) ||
      (!source.msg_control && source.msg_controllen)) return;
  if (!copy_child(request->pid, vectors, (uintptr_t)source.msg_iov,
                  source.msg_iovlen * sizeof(vectors[0]))) return;
  for (size_t i = 0; i < source.msg_iovlen; i++) {
    if (broker_metadata_audit && vectors[i].iov_len > sizeof(payload) - total)
      fprintf(stderr, "broker_send_limit vectorBytes=%zu copiedBytes=%zu\n", vectors[i].iov_len, total);
    if (vectors[i].iov_len > sizeof(payload) - total ||
        (vectors[i].iov_len && !copy_child(request->pid, payload + total,
          (uintptr_t)vectors[i].iov_base, vectors[i].iov_len))) return;
    total += vectors[i].iov_len;
  }
  if (!total) return;
  duplicate = syscall(__NR_pidfd_getfd, pidfd, (int)request->data.args[0], 0);
  if (duplicate < 0 || (!unix_socket_type(duplicate, SOCK_STREAM) &&
      !(broker_created_pair(duplicate) && unix_socket_type(duplicate, SOCK_SEQPACKET))) ||
      (!approved_socket(duplicate) && !broker_created_pair(duplicate))) goto done;
  struct iovec io = {payload, total};
  struct msghdr copied = {.msg_iov = &io, .msg_iovlen = 1};
  if (source.msg_controllen) {
    if (!copy_child(request->pid, control.bytes, (uintptr_t)source.msg_control, source.msg_controllen)) goto done;
    copied.msg_control = control.bytes; copied.msg_controllen = source.msg_controllen;
    struct cmsghdr *item = CMSG_FIRSTHDR(&copied);
    if (broker_metadata_audit && item) fprintf(stderr, "broker_control_type=%d\n", item->cmsg_type);
    if (!item || item->cmsg_level != SOL_SOCKET || item->cmsg_len < CMSG_LEN(0) ||
        item->cmsg_len > source.msg_controllen || CMSG_NXTHDR(&copied, item)) goto done;
    if (item->cmsg_type == SCM_CREDENTIALS) {
      if (total != 1 || payload[0] != '\0' || item->cmsg_len != CMSG_LEN(sizeof(struct ucred)) ||
          (source.msg_controllen != CMSG_LEN(sizeof(struct ucred)) &&
           source.msg_controllen != CMSG_SPACE(sizeof(struct ucred)))) goto done;
      struct ucred credentials;
      memcpy(&credentials, CMSG_DATA(item), sizeof(credentials));
      credential_slot = private_bus_credential_slot(duplicate, request->pid, &credentials);
      if (credential_slot < 0) goto done;
      memcpy(CMSG_DATA(item), &credentials, sizeof(credentials));
    } else {
      if (item->cmsg_type != SCM_RIGHTS ||
          item->cmsg_len < CMSG_LEN(sizeof(int)) || item->cmsg_len > source.msg_controllen ||
          (item->cmsg_len - CMSG_LEN(0)) % sizeof(int)) goto done;
      size_t count = (item->cmsg_len - CMSG_LEN(0)) / sizeof(int);
      if (count > 4 || (source.msg_controllen != CMSG_LEN(count * sizeof(int)) &&
          source.msg_controllen != CMSG_SPACE(count * sizeof(int))) || CMSG_NXTHDR(&copied, item)) goto done;
      int original[4];
      memcpy(original, CMSG_DATA(item), count * sizeof(int));
      for (size_t i = 0; i < count; i++) {
        int passed = syscall(__NR_pidfd_getfd, pidfd, original[i], 0);
        if (passed < 0) goto done;
        rights[rights_count++] = passed;
        struct stat info;
        // Registered private pair endpoints may move over registered pairs only.
        // Devices and all other socket rights remain outside this experiment.
        if (fstat(passed, &info)) goto done;
        if (broker_metadata_audit) fprintf(stderr, "broker_rights_kind=%u\n", (unsigned int)(info.st_mode & S_IFMT));
        if (!S_ISREG(info.st_mode) && !S_ISFIFO(info.st_mode) &&
            !(S_ISSOCK(info.st_mode) && broker_created_pair(passed) && broker_created_pair(duplicate))) goto done;
      }
      memcpy(CMSG_DATA(item), rights, count * sizeof(int));
    }
  }
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request->id)) goto done;
  // A full target socket must not block the sole notification handler.
  // EAGAIN is explicit experimental behavior even for a blocking target FD.
  ssize_t sent = sendmsg(duplicate, &copied, (int)request->data.args[2] | MSG_NOSIGNAL | MSG_DONTWAIT);
  if (sent >= 0) {
    response->error = 0; response->val = sent;
    if (broker_created_pair(duplicate)) forwarded_pair_messages++;
    if (credential_slot >= 0 && sent == 1) {
      private_bus_handshakes[credential_slot] = 1;
      forwarded_bus_credentials++;
    }
  }
  else response->error = -errno;
done:
  for (size_t i = 0; i < rights_count; i++) close(rights[i]);
  if (duplicate >= 0) close(duplicate);
}

static void send_private_loopback(int listener, int pidfd, struct seccomp_notif *request,
                                  struct seccomp_notif_resp *response) {
  union { struct nlmsghdr align; unsigned char bytes[64]; } packet = {0};
  struct sockaddr_nl destination = {0}, bound = {0};
  if (request->data.args[3] || request->data.args[2] > sizeof(packet) ||
      request->data.args[2] < sizeof(struct nlmsghdr) || request->data.args[5] != sizeof(destination) ||
      !copy_child(request->pid, &destination, request->data.args[4], sizeof(destination)) ||
      destination.nl_family != AF_NETLINK || destination.nl_pad || destination.nl_pid || destination.nl_groups ||
      !copy_child(request->pid, packet.bytes, request->data.args[1], request->data.args[2])) return;
  struct nlmsghdr *header = &packet.align;
  if (header->nlmsg_len != request->data.args[2]) return;
  if (header->nlmsg_type == RTM_NEWADDR) {
    if (header->nlmsg_len != 40 || header->nlmsg_flags != (NLM_F_REQUEST | NLM_F_CREATE | NLM_F_EXCL | NLM_F_ACK)) return;
    struct ifaddrmsg address;
    memcpy(&address, packet.bytes + NLMSG_HDRLEN, sizeof(address));
    if (address.ifa_family != AF_INET || address.ifa_prefixlen != 8 || address.ifa_flags != IFA_F_PERMANENT ||
        address.ifa_scope != RT_SCOPE_HOST || address.ifa_index != 1) return;
    for (size_t i = 0; i < 2; i++) {
      struct rtattr attribute; uint32_t ip;
      size_t offset = NLMSG_HDRLEN + sizeof(address) + i * 8;
      memcpy(&attribute, packet.bytes + offset, sizeof(attribute));
      memcpy(&ip, packet.bytes + offset + sizeof(attribute), sizeof(ip));
      if (attribute.rta_len != 8 || attribute.rta_type != (i ? IFA_ADDRESS : IFA_LOCAL) ||
          ip != htonl(INADDR_LOOPBACK)) return;
    }
  } else if (header->nlmsg_type == RTM_NEWLINK) {
    if (header->nlmsg_len != NLMSG_LENGTH(sizeof(struct ifinfomsg)) || header->nlmsg_flags != (NLM_F_REQUEST | NLM_F_ACK)) return;
    struct ifinfomsg link;
    memcpy(&link, packet.bytes + NLMSG_HDRLEN, sizeof(link));
    if (link.ifi_family != AF_UNSPEC || link.__ifi_pad || link.ifi_type || link.ifi_index != 1 ||
        link.ifi_flags != IFF_UP || link.ifi_change != IFF_UP) return;
  } else return;
  int duplicate = syscall(__NR_pidfd_getfd, pidfd, (int)request->data.args[0], 0);
  if (duplicate < 0) return;
  int domain = 0, type = 0, protocol = -1;
  uint64_t cookie = 0; socklen_t length = sizeof(int);
  struct stat task_namespace, broker_namespace;
  char namespace_path[64];
  snprintf(namespace_path, sizeof(namespace_path), "/proc/%u/ns/net", request->pid);
  if (getsockopt(duplicate, SOL_SOCKET, SO_DOMAIN, &domain, &length) || domain != AF_NETLINK) goto done;
  length = sizeof(int);
  if (getsockopt(duplicate, SOL_SOCKET, SO_TYPE, &type, &length) || type != SOCK_RAW) goto done;
  length = sizeof(int);
  if (getsockopt(duplicate, SOL_SOCKET, SO_PROTOCOL, &protocol, &length) || protocol != NETLINK_ROUTE) goto done;
  length = sizeof(cookie);
  if (!broker_netns_cookie || getsockopt(duplicate, SOL_SOCKET, SO_NETNS_COOKIE, &cookie, &length) ||
      !cookie || cookie == broker_netns_cookie || stat(namespace_path, &task_namespace) ||
      stat("/proc/self/ns/net", &broker_namespace) ||
      (task_namespace.st_dev == broker_namespace.st_dev && task_namespace.st_ino == broker_namespace.st_ino)) goto done;
  length = sizeof(bound);
  if (getsockname(duplicate, (struct sockaddr *)&bound, &length) || bound.nl_family != AF_NETLINK ||
      bound.nl_pid != header->nlmsg_pid || ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request->id)) goto done;
  ssize_t sent = sendto(duplicate, packet.bytes, header->nlmsg_len, MSG_DONTWAIT,
                        (struct sockaddr *)&destination, sizeof(destination));
  if (sent >= 0) { response->error = 0; response->val = sent; forwarded_loopback++; }
  else response->error = -errno;
done:
  close(duplicate);
}

static int handle_one(int listener, int selected_handle, int selected_dgram_handle,
                      int naive, int broker_datagram, int broker_connected) {
  struct seccomp_notif request = {0};
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &request)) return -1;
  struct seccomp_notif_resp response = {.id = request.id, .error = -EACCES};
  int pidfd = syscall(__NR_pidfd_open, request.pid, broker_connected ? PIDFD_THREAD : 0);
  int live = pidfd >= 0 && ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id) == 0;
  if (live && private_socket_pairs && request.data.nr == __NR_socketpair)
    create_private_pair(listener, &request, &response);
  if (live && broker_connected && request.data.nr == __NR_sendmsg)
    send_connected_copy(listener, pidfd, &request, &response);
  if (live && private_loopback_netlink && request.data.nr == __NR_sendto)
    send_private_loopback(listener, pidfd, &request, &response);
  if (live && (private_bus_credentials || private_socket_pairs) && request.data.nr == __NR_sendto &&
      !request.data.args[4] && !request.data.args[5] && request.data.args[2] > 0 &&
      request.data.args[2] <= 4096 && !(request.data.args[3] & ~(uint64_t)(MSG_DONTWAIT | MSG_NOSIGNAL))) {
    int duplicate = syscall(__NR_pidfd_getfd, pidfd, (int)request.data.args[0], 0);
    uint64_t cookie;
    if (duplicate >= 0 && (unix_socket_type(duplicate, SOCK_STREAM) ||
        (broker_created_pair(duplicate) && unix_socket_type(duplicate, SOCK_SEQPACKET))) && socket_cookie(duplicate, &cookie)) {
      int pair_allowed = broker_created_pair(duplicate), bus_allowed = 0;
      for (size_t slot = 0; slot < private_bus_cookie_count; slot++) {
        if (cookie == private_bus_cookies[slot] && private_bus_handshakes[slot]) { bus_allowed = 1; break; }
      }
      if (pair_allowed || bus_allowed) {
        char payload[4096];
        if (copy_child(request.pid, payload, request.data.args[1], request.data.args[2]) &&
            ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id) == 0) {
          ssize_t sent = send(duplicate, payload, request.data.args[2], (int)request.data.args[3] | MSG_NOSIGNAL | MSG_DONTWAIT);
          if (sent >= 0) {
            response.error = 0; response.val = sent;
            if (pair_allowed) forwarded_pair_messages++; else forwarded_bus_data++;
          }
          else response.error = -errno;
        }
      }
    }
    if (duplicate >= 0) close(duplicate);
  }
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
        if (unix_socket_type(duplicate, SOCK_DGRAM) &&
            ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id) == 0) {
          ssize_t sent = sendto(duplicate, payload, local_data.iov_len, MSG_DONTWAIT,
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
      int pinned_handle = !strcmp(addr.sun_path, selected_stream_path) ? selected_handle :
        (additional_stream_path && !strcmp(addr.sun_path, additional_stream_path)
          ? additional_stream_handle : -1);
      if (pinned_handle >= 0) {
        int duplicate = syscall(__NR_pidfd_getfd, pidfd, (int)request.data.args[0], 0);
        if (duplicate >= 0) {
          char resolved[sizeof(((struct sockaddr_un *)0)->sun_path)];
          if (naive) {
            snprintf(resolved, sizeof(resolved), "/proc/%u/root%s",
                     request.pid, SELECTED_PATH);
          } else {
            snprintf(resolved, sizeof(resolved), "/proc/self/fd/%d", pinned_handle);
          }
          struct sockaddr_un broker_addr = {.sun_family = AF_UNIX};
          strcpy(broker_addr.sun_path, resolved);
          if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id) == 0) {
            if (connect(duplicate, (struct sockaddr *)&broker_addr,
                        sizeof(broker_addr)) == 0) {
              response.error = 0;
              if (broker_connected) {
                uint64_t cookie;
                if (approved_cookie_count < 32 && socket_cookie(duplicate, &cookie)) {
                  approved_cookies[approved_cookie_count++] = cookie;
                  if (private_bus_credentials && pinned_handle == additional_stream_handle && private_bus_cookie_count < 32)
                    private_bus_cookies[private_bus_cookie_count++] = cookie;
                }
                else response.error = -ENOSPC;
              }
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
  if (broker_metadata_audit && response.error) {
    char comm_path[64], comm[64] = "unknown";
    snprintf(comm_path, sizeof(comm_path), "/proc/%u/comm", request.pid);
    FILE *comm_file = fopen(comm_path, "r");
    if (comm_file) { if (!fgets(comm, sizeof(comm), comm_file)) strcpy(comm, "unknown"); fclose(comm_file); }
    comm[strcspn(comm, "\n")] = '\0';
    int duplicate = pidfd >= 0 && request.data.nr != __NR_socketpair
      ? syscall(__NR_pidfd_getfd, pidfd, (int)request.data.args[0], 0) : -1;
    int domain = -1, type = -1, protocol = -1, peer_bytes = -1, nl_type = -1, different_netns = -1;
    if (request.data.nr == __NR_socketpair) {
      domain = (int)request.data.args[0];
      type = (int)request.data.args[1] & ~(SOCK_CLOEXEC | SOCK_NONBLOCK);
      protocol = (int)request.data.args[2];
    }
    if (duplicate >= 0) {
      socklen_t length = sizeof(int);
      if (getsockopt(duplicate, SOL_SOCKET, SO_DOMAIN, &domain, &length)) domain = -1;
      length = sizeof(int);
      if (getsockopt(duplicate, SOL_SOCKET, SO_TYPE, &type, &length)) type = -1;
      length = sizeof(int);
      if (getsockopt(duplicate, SOL_SOCKET, SO_PROTOCOL, &protocol, &length)) protocol = -1;
      struct sockaddr_un peer = {0}; length = sizeof(peer);
      if (!getpeername(duplicate, (struct sockaddr *)&peer, &length)) peer_bytes = (int)length;
      if (domain == AF_NETLINK && request.data.nr == __NR_sendto) {
        struct nlmsghdr header = {0};
        if (request.data.args[2] >= sizeof(header) &&
            copy_child(request.pid, &header, request.data.args[1], sizeof(header))) nl_type = header.nlmsg_type;
        int reference = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
        uint64_t actual_cookie = 0, reference_cookie = 0;
        socklen_t actual_length = sizeof(actual_cookie), reference_length = sizeof(reference_cookie);
        if (reference >= 0 && !getsockopt(duplicate, SOL_SOCKET, SO_NETNS_COOKIE, &actual_cookie, &actual_length) &&
            !getsockopt(reference, SOL_SOCKET, SO_NETNS_COOKIE, &reference_cookie, &reference_length))
          different_netns = actual_cookie != reference_cookie;
        if (reference >= 0) close(reference);
      }
      close(duplicate);
    }
    fprintf(stderr, "broker_denied syscall=%d fd=%llu comm=%s errno=%d domain=%d type=%d protocol=%d peerBytes=%d nlType=%d differentNetns=%d\n",
      request.data.nr, (unsigned long long)request.data.args[0], comm, -response.error, domain, type, protocol, peer_bytes, nl_type, different_netns);
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
  int strict_connected = argc == 2 && !strcmp(argv[1], "strict-connected");
  int broker_disconnect = argc == 2 && !strcmp(argv[1], "broker-disconnect");
  int broker_connected = (argc == 2 && !strcmp(argv[1], "broker-connected")) || broker_disconnect;
  int broker_datagram = (argc == 2 && !strcmp(argv[1], "broker-dgram")) || broker_connected;
  int check_connected = strict_connected || broker_connected;
  if (argc != 1 && !naive && !strict && !broker_datagram && !strict_connected) return 2;
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
    if (strict_connected) mode_text[0] = '4';
    if (broker_connected) mode_text[0] = '3';
    if (broker_disconnect) mode_text[0] = '5';
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
  // Observe the regression without killing the fixture and leaking its child.
  // Production correctness requires no signal, not reliance on this observer.
  if (broker_disconnect) {
    struct sigaction observer = {.sa_handler = record_sigpipe};
    if (sigaction(SIGPIPE, &observer, NULL)) ERR("SIGPIPE observer");
  }
  printf("broker_mode=%s\n", naive ? "naive" : strict || strict_connected ? "pinned-strict"
         : broker_disconnect ? "pinned-disconnect" : broker_connected ? "pinned-connected"
         : broker_datagram ? "pinned-datagram" : "pinned");
  fflush(stdout);
  int status = 0;
  for (;;) {
    struct pollfd pfd = {.fd = listener, .events = POLLIN};
    int ready = poll(&pfd, 1, 200);
    if (ready > 0 && (pfd.revents & POLLIN)
        && handle_one(listener, selected_handle, selected_dgram_handle,
                      naive, broker_datagram, broker_connected)) ERR("handle notification");
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
  if (check_connected) printf("connected_messages=%d connected_rights=%d unexpected_stream_bytes=%d\n",
                              connected_messages, connected_rights, unexpected_stream_bytes);
  if (broker_disconnect) printf("broker_sigpipe_count=%d\n", (int)broker_sigpipe_count);
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
  int passed = WIFEXITED(status) && !WEXITSTATUS(status)
         && selected_count == (naive ? 1 : broker_disconnect ? 6 : broker_connected ? 4 : check_connected ? 3 : 2)
         && (!broker_disconnect || broker_sigpipe_count == 0)
         && (!check_connected || (connected_messages == (broker_connected ? 2 : 1)
                                 && connected_rights == (broker_connected ? 2 : 1)
                                 && unexpected_stream_bytes == 0))
         && selected_stream_broker_pid
         && blocked_count == (naive ? 1 : 0)
         && selected_datagrams == (broker_datagram ? 2 : 0)
         && (!broker_datagram || selected_dgram_broker_pid)
         && blocked_datagrams == (strict || strict_connected || broker_datagram ? 0 : 3) ? 0 : 1;
  printf("fixture_exit=%d\n", passed);
  return passed;
}
