/* Harmless acceptance probes. Every file/process target is supplied by the test. */
#include <errno.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    const char *op = argv[1];
    int result = -1;
    errno = 0;
    if (!strcmp(op, "race")) {
        result = 0;
        for (int i = 0; i < 5000; i++) {
            int fd = open(argv[2], O_WRONLY);
            if (fd >= 0) { result += write(fd, "x", 1) == 1; close(fd); }
        }
    } else if (!strcmp(op, "read") || !strcmp(op, "write")) {
        int writing = !strcmp(op, "write");
        int fd = open(argv[2], writing ? O_WRONLY | O_CREAT : O_RDONLY, 0600);
        if (fd >= 0) {
            char byte = 0;
            result = writing ? (int)write(fd, "x", 1) : (int)read(fd, &byte, 1);
            close(fd);
        }
    } else if (!strcmp(op, "hardlink")) {
        result = link(argv[2], argv[3]);
    } else if (!strcmp(op, "network")) {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        if (fd >= 0) {
            struct sockaddr_in addr = {.sin_family = AF_INET,
                .sin_port = htons((unsigned short)atoi(argv[2])),
                .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
            result = connect(fd, (struct sockaddr *)&addr, sizeof(addr));
            close(fd);
        }
    } else if (!strcmp(op, "unix")) {
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        if (fd >= 0) {
            struct sockaddr_un addr = {.sun_family = AF_UNIX};
            strlcpy(addr.sun_path, argv[2], sizeof(addr.sun_path));
            result = connect(fd, (struct sockaddr *)&addr, sizeof(addr));
            close(fd);
        }
    } else if (!strcmp(op, "fork")) {
        pid_t child = fork();
        if (!child) _exit(0);
        if (child > 0) waitpid(child, NULL, 0);
        result = (int)child;
    } else if (!strcmp(op, "daemon")) {
        /* Preserve stdio so a successful unexpected daemon can report and exit. */
        result = daemon(1, 1);
    } else if (!strcmp(op, "mach")) {
        mach_port_t service = MACH_PORT_NULL;
        result = bootstrap_look_up(bootstrap_port, argv[2], &service);
        if (service != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), service);
    } else if (!strcmp(op, "signal")) {
        result = kill((pid_t)atoi(argv[2]), SIGUSR1);
    } else if (!strcmp(op, "fd")) {
        char byte;
        result = (int)read(atoi(argv[2]), &byte, 1);
    } else if (!strcmp(op, "env")) {
        result = getenv("ABILITY_TEST_SECRET") || getenv("NODE_OPTIONS") || getenv("PYTHONPATH") ? 1 : 0;
    } else if (!strcmp(op, "reexec")) {
        execl(argv[0], argv[0], "linger", (char *)NULL);
    } else if (!strcmp(op, "exec-other")) {
        execl(argv[2], argv[2], (char *)NULL);
    } else if (!strcmp(op, "linger")) {
        signal(SIGTERM, SIG_IGN);
        printf("{\"pid\":%d}\n", getpid());
        fflush(stdout);
        for (;;) pause();
    } else return 2;
    printf("{\"result\":%d,\"errno\":%d,\"pid\":%d}\n", result, errno, getpid());
    return 0;
}
