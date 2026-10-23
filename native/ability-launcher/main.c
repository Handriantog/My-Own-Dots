/* Trusted macOS supervisor. No untrusted code runs until the watchdog is armed.
 * Workers cannot fork: the host launches each permitted helper through a separate
 * instance of this supervisor. The child PID remains unreaped until cleanup, so
 * signals cannot accidentally target a recycled unrelated PID.
 */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <libproc.h>
#include <sandbox.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stopping = 0;

static void requested_stop(int value) { (void)value; stopping = 1; }

static int descriptor(const char *text) {
    char *end = NULL;
    errno = 0;
    long value = strtol(text, &end, 10);
    return errno || !*text || *end || value < 3 || value > INT_MAX ? -1 : (int)value;
}

static double monotonic(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value)) _exit(125);
    return (double)value.tv_sec + (double)value.tv_nsec / 1e9;
}

static bool consume_renewal(int control, const struct kevent *event, bool leased) {
    if (!leased || event->filter != EVFILT_READ || (event->flags & (EV_EOF | EV_ERROR)) ||
        event->data <= 0 || event->data > 32) return false;
    char renewals[32];
    ssize_t count = read(control, renewals, (size_t)event->data);
    if (count <= 0) return false;
    for (ssize_t i = 0; i < count; i++) if (renewals[i] != 'R') return false;
    return true;
}

static char *read_profile(const char *path) {
    if (*path != '/') return NULL;
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return NULL;
    struct stat info;
    if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_uid != geteuid() ||
        (info.st_mode & 0022) || info.st_size <= 0 || info.st_size > 1024 * 1024) {
        close(fd);
        return NULL;
    }
    size_t size = (size_t)info.st_size;
    char *profile = calloc(size + 1, 1);
    if (!profile) { close(fd); return NULL; }
    size_t offset = 0;
    while (offset < size) {
        ssize_t count = read(fd, profile + offset, size - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { free(profile); close(fd); return NULL; }
        offset += (size_t)count;
    }
    close(fd);
    if (memchr(profile, '\0', size)) { free(profile); return NULL; }
    return profile;
}

static bool pipe_descriptor(int fd, int mode) {
    struct stat info;
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fstat(fd, &info)) return false;
    if (S_ISFIFO(info.st_mode)) return (flags & O_ACCMODE) == mode;
    /* Node/libuv's child stdio pipes are anonymous local socketpairs. Never
     * accept network sockets or named Unix endpoints as watchdog channels. */
    if (!S_ISSOCK(info.st_mode) || (flags & O_ACCMODE) != O_RDWR) return false;
    struct sockaddr_un local = {0}, peer = {0};
    socklen_t local_size = sizeof(local), peer_size = sizeof(peer), type_size = sizeof(int);
    int type = 0;
    return getsockname(fd, (struct sockaddr *)&local, &local_size) == 0 &&
        getpeername(fd, (struct sockaddr *)&peer, &peer_size) == 0 &&
        getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &type_size) == 0 &&
        local.sun_family == AF_UNIX && peer.sun_family == AF_UNIX &&
        local.sun_path[0] == 0 && peer.sun_path[0] == 0 && type == SOCK_STREAM;
}

/* RLIMIT_NOFILE can be lowered below already-open descriptors. Enumerate the
 * actual table before fork rather than assuming the soft limit covers it. This
 * launcher is single-threaded, so no other thread can add descriptors here. */
static int descriptor_limit(void) {
    int bytes = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, NULL, 0);
    int limit = getdtablesize();
    if (bytes <= 0 || bytes > INT_MAX - 32 * (int)sizeof(struct proc_fdinfo) || limit < 0)
        return -1;
    int capacity = bytes + 32 * (int)sizeof(struct proc_fdinfo);
    struct proc_fdinfo *list = malloc((size_t)capacity);
    if (!list) return -1;
    int used = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, list, capacity);
    if (used <= 0 || used >= capacity || used % sizeof(*list)) { free(list); return -1; }
    for (size_t i = 0; i < (size_t)used / sizeof(*list); i++) {
        if (list[i].proc_fd >= INT_MAX) { free(list); return -1; }
        if ((int)list[i].proc_fd >= limit) limit = (int)list[i].proc_fd + 1;
    }
    free(list);
    return limit;
}

static void child_exec(int gate, const char *profile, char **command, int fd_limit) {
    char permit = 0;
    ssize_t count;
    do { count = read(gate, &permit, 1); } while (count < 0 && errno == EINTR);
    if (count != 1 || permit != 'R') _exit(125);
    char *error = NULL;
    if (sandbox_init(profile, 0, &error)) {
        /* Profile errors must not disclose host paths to worker protocol/logs. */
        if (error) sandbox_free_error(error);
        _exit(125);
    }
    char cwd[PATH_MAX];
    char home[PATH_MAX + 6], temporary[PATH_MAX + 12];
    if (!getcwd(cwd, sizeof(cwd))) _exit(125);
    if (snprintf(home, sizeof(home), "HOME=%s", cwd) >= (int)sizeof(home) ||
        snprintf(temporary, sizeof(temporary), "TMPDIR=%s/tmp/", cwd) >= (int)sizeof(temporary))
        _exit(125);
    char *environment[] = {
        "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8",
        "PYTHONNOUSERSITE=1", "PYTHONDONTWRITEBYTECODE=1", "PYTHONUNBUFFERED=1",
        "ELECTRON_RUN_AS_NODE=1",
        home, temporary, NULL,
    };
    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    signal(SIGPIPE, SIG_DFL);
    for (int fd = 3; fd < fd_limit; fd++) close(fd);
    execve(command[0], command, environment);
    _exit(126);
}

int main(int argc, char **argv) {
    bool leased = argc >= 10 && !strcmp(argv[7], "--lease");
    int separator = leased ? 8 : 7, executable = separator + 1;
    if (argc < 9 || strcmp(argv[1], "--profile") || strcmp(argv[3], "--control-fd") ||
        strcmp(argv[5], "--status-fd") || argc <= executable ||
        strcmp(argv[separator], "--") || argv[executable][0] != '/') {
        fputs("Invalid Ability launcher arguments\n", stderr);
        return 125;
    }
    int control = descriptor(argv[4]), status = descriptor(argv[6]);
    if (control < 0 || status < 0 || control == status ||
        !pipe_descriptor(control, O_RDONLY) || !pipe_descriptor(status, O_WRONLY)) return 125;
    char canonical[PATH_MAX];
    if (!realpath(argv[executable], canonical) || strcmp(canonical, argv[executable])) return 125;
    char *profile = read_profile(argv[2]);
    if (!profile) return 125;
    signal(SIGTERM, requested_stop);
    signal(SIGINT, requested_stop);
    signal(SIGHUP, requested_stop);
    signal(SIGPIPE, SIG_IGN);

    int queue = kqueue();
    int gate[2];
    if (queue < 0 || pipe(gate)) { free(profile); return 125; }
    struct kevent changes[2];
    pid_t owner = getppid();
    EV_SET(&changes[0], (uintptr_t)control, EVFILT_READ, EV_ADD | EV_CLEAR, 0, 0, NULL);
    EV_SET(&changes[1], (uintptr_t)owner, EVFILT_PROC, EV_ADD | EV_CLEAR, NOTE_EXIT, 0, NULL);
    if (owner <= 1 || kevent(queue, changes, 2, NULL, 0, NULL) < 0 || getppid() != owner) {
        free(profile);
        return 125;
    }
    /* Reject an already-dead owner before releasing any child code. */
    struct kevent event;
    struct timespec immediate = {0, 0};
    int initial = kevent(queue, NULL, 0, &event, 1, &immediate);
    if (initial < 0 || (initial > 0 && !consume_renewal(control, &event, leased))) {
        free(profile);
        return 125;
    }
    int limit = descriptor_limit();
    if (limit < 0) { free(profile); return 125; }
    pid_t child = fork();
    if (child < 0) { free(profile); return 125; }
    if (!child) {
        close(gate[1]);
        child_exec(gate[0], profile, &argv[executable], limit);
    }
    free(profile);
    close(gate[0]);
    /* Remove accidental inherited descriptors in the trusted supervisor too. */
    for (int fd = 3; fd < limit; fd++)
        if (fd != control && fd != status && fd != queue && fd != gate[1]) close(fd);
    EV_SET(&changes[0], (uintptr_t)child, EVFILT_PROC, EV_ADD | EV_CLEAR, NOTE_EXIT, 0, NULL);
    if (kevent(queue, changes, 1, NULL, 0, NULL) < 0 || stopping || getppid() != owner) {
        stopping = 1;
    } else {
        int flags = fcntl(status, F_GETFL);
        if (flags < 0 || fcntl(status, F_SETFL, flags | O_NONBLOCK) < 0 ||
            dprintf(status, "{\"type\":\"spawn\",\"pid\":%d}\n", child) < 0 ||
            write(gate[1], "R", 1) != 1) stopping = 1;
    }
    close(gate[1]);
    double deadline = 0;
    double lease_until = monotonic() + 3.0, hard_deadline = monotonic() + 60.0;
    int child_status = 0;
    for (;;) {
        pid_t reaped = waitpid(child, &child_status, WNOHANG);
        if (reaped == child) break;
        if (reaped < 0 && errno != EINTR) return 125;
        if (monotonic() >= hard_deadline || (leased && monotonic() >= lease_until)) stopping = 1;
        if (stopping && !deadline) {
            kill(child, SIGTERM);
            deadline = monotonic() + 2.0;
        }
        if (deadline && monotonic() >= deadline) kill(child, SIGKILL);
        struct timespec interval = {0, 25000000};
        int ready = kevent(queue, NULL, 0, &event, 1, &interval);
        if (ready < 0) { if (errno != EINTR) stopping = 1; continue; }
        if (ready && event.filter == EVFILT_READ) {
            if (!consume_renewal(control, &event, leased)) stopping = 1;
            if (!stopping) lease_until = monotonic() + 3.0;
        }
        if (ready && event.filter == EVFILT_PROC && event.ident == (uintptr_t)owner) stopping = 1;
        if (getppid() != owner) stopping = 1;
    }
    int code = WIFEXITED(child_status) ? WEXITSTATUS(child_status) : 128 + WTERMSIG(child_status);
    (void)dprintf(status, "{\"type\":\"exit\",\"code\":%d}\n", code);
    close(status);
    close(control);
    close(queue);
    return code;
}
