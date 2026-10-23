#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>

static void result(const char *id, const char *outside) {
    int fd = open(outside, O_RDONLY);
    if (fd >= 0) close(fd);
    printf("{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":{\"status\":\"success\",\"value\":{\"pid\":%d,\"readBlocked\":%s}}}\n", id, getpid(), fd < 0 ? "true" : "false");
    fflush(stdout);
}
static int field(const char *line, const char *key, char *output, size_t capacity) {
    char pattern[128]; snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
    const char *begin = strstr(line, pattern);
    if (!begin) return 0;
    begin += strlen(pattern);
    const char *end = strchr(begin, '"');
    if (!end || (size_t)(end - begin) >= capacity) return 0;
    memcpy(output, begin, (size_t)(end - begin)); output[end - begin] = 0;
    return 1;
}
int main(int argc, char **argv) {
    if (argc == 4) { result(argv[2], argv[3]); return 0; }
    char *line = NULL; size_t size = 0;
    while (getline(&line, &size, stdin) > 0) {
        char id[128], outside[4096] = "/not-permitted";
        if (!field(line, "id", id, sizeof(id))) continue;
        if (strstr(line, "\"initialize\"")) {
            printf("{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":{\"apiVersion\":1}}\n", id); fflush(stdout);
        } else if (strstr(line, "\"invoke\"")) {
            field(line, "outside", outside, sizeof(outside));
            if (strstr(line, "\"reexec\"")) execl(argv[0], argv[0], "--again", id, outside, NULL);
            result(id, outside);
        }
    }
    free(line); return 0;
}
