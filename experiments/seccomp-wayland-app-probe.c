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
    int listener = install_connect_filter(0, 1, channel[1]);
    if (listener < 0 || send_fd(channel[1], listener) != 1) _exit(125);
    close(listener);
    int handoff = channel[1];
    close(handoff);
    if (install_strict_send_filter(0, 1, handoff)) _exit(125);
    execv(argv[2], &argv[2]);
    _exit(127);
  }
  setpgid(child, child);
  close(channel[1]);
  int listener = recv_fd(channel[0]);
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
  int application_exit = WIFEXITED(status) ? WEXITSTATUS(status) : 128;
  printf("{\"approvedConnections\":%zu,\"applicationExit\":%d,\"brokerFailure\":%d,\"stopped\":%d}\n",
         approved_cookie_count, application_exit, failed, (int)stopping);
  return failed ? 1 : application_exit;
}
