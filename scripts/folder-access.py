"""Bounded POSIX file operations. One JSON request on stdin, one response on stdout.

All traversal uses directory descriptors and O_NOFOLLOW. There is deliberately no
shell, delete, recursive traversal, mkdir, or arbitrary process operation.
"""
import hashlib
import fcntl
import itertools
import json
import os
import secrets
import signal
import stat
import sys
import threading
import time
import traceback

MAX_BYTES = 65536
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


class Rejected(Exception):
    pass


def cancelled(_signum, _frame):
    raise Rejected("Folder operation was cancelled.")


def watch_parent(parent_pid):
    if not isinstance(parent_pid, int) or parent_pid < 2 or os.getppid() != parent_pid:
        raise Rejected("Folder operation was cancelled because its server exited.")

    def watch():
        while os.getppid() == parent_pid:
            time.sleep(0.05)
        os.kill(os.getpid(), signal.SIGTERM)

    threading.Thread(target=watch, daemon=True).start()


def components(path, allow_root=False):
    if not isinstance(path, str) or len(path) > 4096 or "\0" in path:
        raise Rejected("Invalid relative path.")
    if allow_root and path in ("", "."):
        return []
    parts = path.split("/")
    if not path or path.startswith("/") or any(p in ("", ".", "..") for p in parts):
        raise Rejected("Use a relative path inside the approved folder.")
    return parts


def descend(fd, parts):
    current = os.dup(fd)
    try:
        for part in parts:
            child = os.open(part, DIR_FLAGS, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def open_root(path):
    if not isinstance(path, str) or not path.startswith("/") or len(path) > 4096 or "\0" in path:
        raise Rejected("Choose an absolute folder path.")
    parts = [] if path == "/" else components(path[1:])
    base = os.open("/", DIR_FLAGS)
    try:
        return descend(base, parts)
    finally:
        os.close(base)


def identity(info):
    return {"dev": str(info.st_dev), "ino": str(info.st_ino)}


def check_root(fd, request):
    if identity(os.fstat(fd)) != request.get("identity"):
        raise Rejected("The approved folder changed. Choose and approve it again.")


def read_text(parent, name):
    fd = os.open(name, FILE_FLAGS, dir_fd=parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise Rejected("Only regular files without hardlinks are allowed.")
        if before.st_size > MAX_BYTES:
            raise Rejected("File exceeds the 64 KiB limit.")
        data = bytearray()
        while len(data) <= MAX_BYTES:
            chunk = os.read(fd, min(8192, MAX_BYTES + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(fd)
        if len(data) > MAX_BYTES:
            raise Rejected("File exceeds the 64 KiB limit.")
        if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_nlink) != (
            after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink
        ):
            raise Rejected("File changed while reading. Read it again.")
        try:
            content = data.decode("utf-8")
        except UnicodeError:
            raise Rejected("Only UTF-8 text files are supported.") from None
        if "\0" in content:
            raise Rejected("Only UTF-8 text files are supported.")
        return content, hashlib.sha256(data).hexdigest(), before
    finally:
        os.close(fd)


def list_directory(root, path):
    fd = descend(root, components(path, allow_root=True))
    try:
        entries = []
        with os.scandir(fd) as scan:
            sampled = list(itertools.islice(scan, 201))
            for entry in sampled[:200]:
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    kind = "directory"
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    kind = "file"
                else:
                    kind = "blocked"
                entries.append({"name": entry.name, "type": kind})
        return {"path": path or ".", "entries": sorted(entries, key=lambda item: item["name"]), "truncated": len(sampled) > 200}
    finally:
        os.close(fd)


def file_operation(root, request):
    path = request.get("path")
    parts = components(path)
    parent = descend(root, parts[:-1])
    name = parts[-1]
    temporary = None
    try:
        if request["action"] == "read":
            content, digest, _ = read_text(parent, name)
            return {"path": path, "content": content, "bytes": len(content.encode("utf-8")), "hash": digest}
        # Directory-descriptor locks coordinate every helper, including different
        # grants, overlapping roots, and server processes. They are advisory:
        # unrelated editors that do not take this lock can still race the final
        # hash check and rename. Closing parent releases the lock on every exit.
        fcntl.flock(parent, fcntl.LOCK_EX)
        content = request.get("content")
        expected = request.get("expectedHash")
        if not isinstance(content, str) or "\0" in content:
            raise Rejected("Only UTF-8 text is supported.")
        try:
            data = content.encode("utf-8")
        except UnicodeError:
            raise Rejected("Only UTF-8 text is supported.") from None
        if len(data) > MAX_BYTES:
            raise Rejected("File exceeds the 64 KiB limit.")
        if not isinstance(expected, str) or (expected != "new" and (len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected))):
            raise Rejected("A file hash or the new-file sentinel is required.")
        previous = None
        try:
            _, actual, previous = read_text(parent, name)
            if expected == "new" or actual != expected:
                raise Rejected("File changed or already exists. Read it before writing.")
        except FileNotFoundError:
            if expected != "new":
                raise Rejected("File changed. Read it before writing.") from None
        temporary = ".dots-write-" + secrets.token_hex(16)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        try:
            offset = 0
            while offset < len(data):
                offset += os.write(fd, data[offset:])
            os.fchmod(fd, (previous.st_mode & 0o777) if previous else 0o600)
            os.fsync(fd)
        finally:
            os.close(fd)
        check_root(root, request)
        if previous:
            _, current_hash, current = read_text(parent, name)
            if current_hash != expected or (current.st_dev, current.st_ino) != (previous.st_dev, previous.st_ino):
                raise Rejected("File changed. Read it before writing.")
            os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
            temporary = None
        else:
            # link is atomic and fails if anything already occupies the new name.
            os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        return {"path": path, "bytes": len(data), "hash": hashlib.sha256(data).hexdigest()}
    finally:
        if temporary:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
        os.close(parent)


def execute(request):
    action = request.get("action")
    if action == "inspect":
        path = request.get("root")
        if not isinstance(path, str) or not path.startswith("/") or len(path) > 4096 or "\0" in path:
            raise Rejected("Choose an absolute folder path.")
        canonical = os.path.realpath(path, strict=True)
        fd = open_root(canonical)
        try:
            return {"path": canonical, "name": os.path.basename(canonical) or "/", "identity": identity(os.fstat(fd))}
        finally:
            os.close(fd)
    if action not in ("verify", "list", "read", "write"):
        raise Rejected("Unknown folder operation.")
    fd = open_root(request.get("root"))
    try:
        check_root(fd, request)
        if action == "verify":
            return {"ok": True}
        if action == "list":
            return list_directory(fd, request.get("path"))
        return file_operation(fd, request)
    finally:
        os.close(fd)


def failure(message, error, code=None):
    # Locations and exception type are enough to trace the helper without file contents.
    frames = traceback.extract_tb(error.__traceback__)[-5:]
    result = {"ok": False, "error": message, "exceptionType": type(error).__name__,
              "pythonTrace": " > ".join(f"{os.path.basename(frame.filename)}:{frame.lineno}:{frame.name}" for frame in frames)}
    if code:
        result["code"] = code
    return result


def main():
    if sys.version_info[:2] != (3, 12):
        print(json.dumps({"ok": False, "code": "unsupported_python", "pythonVersion": ".".join(map(str, sys.version_info[:3])), "error": "Folder access requires managed Python 3.12. Run integration setup or configure DOTS_FOLDER_PYTHON with an absolute Python 3.12 path."}))
        return
    signal.signal(signal.SIGTERM, cancelled)
    try:
        raw = sys.stdin.buffer.read(524289)
        if len(raw) > 524288:
            raise Rejected("Folder request is too large.")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise Rejected("Invalid folder request.")
        if "parentPid" in request:
            watch_parent(request["parentPid"])
        result = {"ok": True, "result": execute(request)}
    except Rejected as error:
        result = failure(str(error), error)
    except (ValueError, TypeError, UnicodeError) as error:
        result = failure("Invalid folder request.", error)
    except FileNotFoundError as error:
        result = failure("The folder or file no longer exists.", error)
    except OSError as error:
        result = failure("Folder operation denied. Symlinks, special files, or inaccessible paths are not allowed.", error)
    except Exception as error:
        result = failure("Folder helper failed. Check the daily error log.", error, "helper_failure")
    if not result["ok"]:
        result["pythonVersion"] = ".".join(map(str, sys.version_info[:3]))
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
