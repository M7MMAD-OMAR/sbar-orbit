#define main synthetic_fixture_main
#include "seccomp-unix-connect-broker-probe.c"
#undef main
#include <limits.h>
#include <time.h>

// Reuse the synthetic transport in an opt-in owned-display experiment only.
// This is not linked into Orbit's application launcher or managed service.
static volatile sig_atomic_t stopping;
static void stop_probe(int signal_number) { (void)signal_number; stopping = 1; }

int main(int argc, char **argv) {
  broker_metadata_audit = getenv("ORBIT_PRIVATE_BROKER_AUDIT") &&
    !strcmp(getenv("ORBIT_PRIVATE_BROKER_AUDIT"), "1");
  private_loopback_netlink = getenv("ORBIT_PRIVATE_BROKER_LOOPBACK") &&
    !strcmp(getenv("ORBIT_PRIVATE_BROKER_LOOPBACK"), "1");
  private_socket_pairs = getenv("ORBIT_PRIVATE_BROKER_PAIRS") &&
    !strcmp(getenv("ORBIT_PRIVATE_BROKER_PAIRS"), "1");
  const char *tcp_port = getenv("ORBIT_PRIVATE_BROKER_TCP_PORT");
  if (tcp_port) {
    if (!*tcp_port || strlen(tcp_port) > 5 || strspn(tcp_port, "0123456789") != strlen(tcp_port)) return 2;
    unsigned long value = strtoul(tcp_port, NULL, 10);
    if (!value || value > 65535) return 2;
    private_tcp_port = (unsigned int)value;
  }
  if (private_loopback_netlink || private_tcp_port) {
    int reference = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
    socklen_t length = sizeof(broker_netns_cookie);
    if (reference < 0 || getsockopt(reference, SOL_SOCKET, SO_NETNS_COOKIE, &broker_netns_cookie, &length) || !broker_netns_cookie) return 2;
    close(reference);
  }
  if (argc < 4 || strncmp(argv[1], "/tmp/orbit-native-", 18)) return 2;
  char *name = strrchr(argv[1], '/');
  if (!name || strncmp(name + 1, "wayland-", 8) || !name[9] ||
      strspn(name + 9, "0123456789") != strlen(name + 9)) return 2;
  char canonical[PATH_MAX], directory[PATH_MAX];
  size_t parent_length = (size_t)(name - argv[1]);
  if (strchr(argv[1] + 18, '/') != name || name == argv[1] + 18 ||
      parent_length >= sizeof(directory) || !realpath(argv[1], canonical) || strcmp(argv[1], canonical)) return 2;
  memcpy(directory, argv[1], parent_length); directory[parent_length] = '\0';
  struct stat parent_identity;
  if (lstat(directory, &parent_identity) || !S_ISDIR(parent_identity.st_mode) ||
      parent_identity.st_uid != getuid() || (parent_identity.st_mode & 0077)) return 2;
  selected_stream_path = argv[1];
  int selected = open(argv[1], O_PATH | O_NOFOLLOW | O_CLOEXEC);
  struct stat identity;
  if (selected < 0 || fstat(selected, &identity) || !S_ISSOCK(identity.st_mode) || identity.st_uid != getuid()) return 2;
  int command = 2;
  if (!strcmp(argv[2], "--bus") || !strcmp(argv[2], "--bus-credentials")) {
    private_bus_credentials = !strcmp(argv[2], "--bus-credentials");
    char bus_path[PATH_MAX];
    if (argc < 6 || snprintf(bus_path, sizeof(bus_path), "%s/bus", directory) >= (int)sizeof(bus_path) ||
        strcmp(argv[3], bus_path) || !realpath(argv[3], canonical) || strcmp(argv[3], canonical)) return 2;
    additional_stream_path = argv[3];
    additional_stream_handle = open(argv[3], O_PATH | O_NOFOLLOW | O_CLOEXEC);
    if (additional_stream_handle < 0 || fstat(additional_stream_handle, &identity) ||
        !S_ISSOCK(identity.st_mode) || identity.st_uid != getuid()) return 2;
    command = 4;
  }
  int channel[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, channel)) return 2;
  struct sigaction action = {.sa_handler = stop_probe};
  if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) return 2;
  pid_t child = fork();
  if (child < 0) return 2;
  if (!child) {
    setpgid(0, 0);
    prctl(PR_SET_PDEATHSIG, SIGKILL);
    close(channel[0]); close(selected);
    if (additional_stream_handle >= 0) close(additional_stream_handle);
    // Transfer the listener through pidfd_getfd after a numeric write/ack.
    // No sendmsg exception or permanently reserved application FD is needed.
    int listener = install_connect_filter(0, 1, -1);
    int acknowledged = 0;
    if (listener < 0 || write(channel[1], &listener, sizeof(listener)) != sizeof(listener) ||
        read(channel[1], &acknowledged, sizeof(acknowledged)) != sizeof(acknowledged) || !acknowledged) _exit(125);
    close(listener);
    close(channel[1]);
    if (install_strict_send_filter(0, 1, -1)) _exit(125);
    if (private_socket_pairs && syscall(__NR_close_range, 3u, ~0u, 0)) _exit(125);
    execv(argv[command], &argv[command]);
    _exit(127);
  }
  setpgid(child, child);
  close(channel[1]);
  int child_listener = -1, acknowledged = 0;
  int child_pidfd = syscall(__NR_pidfd_open, child, 0);
  int listener = -1;
  if (child_pidfd >= 0 && read(channel[0], &child_listener, sizeof(child_listener)) == sizeof(child_listener))
    listener = syscall(__NR_pidfd_getfd, child_pidfd, child_listener, 0);
  if (child_pidfd >= 0) close(child_pidfd);
  acknowledged = listener >= 0;
  if (write(channel[0], &acknowledged, sizeof(acknowledged)) != sizeof(acknowledged)) acknowledged = 0;
  close(channel[0]);
  int status = 0, finished = 0, failed = listener < 0;
  time_t started = time(NULL);
  while (!failed && !stopping && time(NULL) - started < 30) {
    struct pollfd pfd = {.fd = listener, .events = POLLIN};
    int ready = poll(&pfd, 1, 100);
    if (ready > 0 && (pfd.revents & POLLIN) && handle_one(listener, selected, -1, 0, 0, 1)) failed = 1;
    if (waitpid(child, &status, WNOHANG) == child) { finished = 1; break; }
  }
  // Own process group only. The backend's compositor and the person's apps
  // are outside this group and never targets of the cleanup signal.
  kill(-child, SIGTERM);
  if (!finished) {
    for (int i = 0; i < 20; i++) {
      if (waitpid(child, &status, WNOHANG) == child) { finished = 1; break; }
      usleep(10000);
    }
    if (!finished) { kill(-child, SIGKILL); waitpid(child, &status, 0); }
  }
  if (listener >= 0) close(listener);
  close(selected);
  if (additional_stream_handle >= 0) close(additional_stream_handle);
  int application_exit = WIFEXITED(status) ? WEXITSTATUS(status) : 128;
  printf("{\"approvedConnections\":%zu,\"forwardedBusCredentials\":%zu,\"forwardedBusData\":%zu,\"forwardedLoopback\":%zu,\"createdPairs\":%zu,\"forwardedPairMessages\":%zu,\"tcpConnections\":%zu,\"forwardedTcpData\":%zu,\"applicationExit\":%d,\"brokerFailure\":%d,\"stopped\":%d}\n",
         approved_cookie_count, forwarded_bus_credentials, forwarded_bus_data, forwarded_loopback,
         private_pair_cookie_count / 2, forwarded_pair_messages, private_tcp_cookie_count, forwarded_tcp_data,
         application_exit, failed, (int)stopping);
  return failed ? 1 : application_exit;
}
