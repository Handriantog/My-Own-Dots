/* Test-only author fixture: recognizes the host's compact handshake frames. */
#include <stdio.h>
#include <string.h>
int main(void) {
    char line[8192];
    while (fgets(line, sizeof(line), stdin)) {
        char *id = strstr(line, "\"id\":\"");
        if (!id) continue;
        id += 6;
        char *end = strchr(id, '"');
        if (!end || end - id > 128) return 1;
        int invoke = strstr(line, "\"method\":\"invoke\"") != NULL;
        int init = strstr(line, "\"method\":\"initialize\"") != NULL;
        if (!invoke && !init) continue;
        *end = '\0';
        if (invoke) {
            FILE *file = fopen("verified", "w");
            if (!file) return 2;
            fputs("native", file);
            fclose(file);
        }
        printf("{\"jsonrpc\":\"2.0\",\"id\":\"%s\",\"result\":%s}\n", id,
               invoke ? "{\"status\":\"success\",\"value\":42}" : "{\"apiVersion\":1}");
        fflush(stdout);
    }
    return 0;
}
