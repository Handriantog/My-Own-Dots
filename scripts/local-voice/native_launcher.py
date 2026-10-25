"""macOS native worker launcher. No installer, download, microphone or provider."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys


def sandbox_profile(runtime, scripts, cache):
    system_cache = Path(subprocess.check_output(
        ["/usr/bin/getconf", "DARWIN_USER_CACHE_DIR"], text=True,
        env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
    ).strip()).resolve()
    literal = lambda value: json.dumps(str(value))
    # Apple Metal's own compiler caches are the only write exceptions outside
    # our private cache. No Swift build/temp directories are needed at runtime.
    metal = [
        system_cache / "clang/ModuleCache",
        *[system_cache / name for name in (
            "com.apple.metalfe", "com.apple.metal", "com.apple.gpuarchiver",
            "org.python.python/com.apple.metalfe", "org.python.python/com.apple.metal",
            "org.python.python/com.apple.gpuarchiver",
        )],
    ]
    return (
        "(version 1)\n(deny default)\n"
        "(allow process*)\n(allow sysctl-read)\n(allow mach-lookup)\n"
        "(allow signal (target children))\n(allow ipc-posix*)\n(allow file-read*)\n"
        '(allow iokit-open (iokit-user-client-class "IOSurfaceRootUserClient") '
        '(iokit-user-client-class "AGXDeviceUserClient"))\n'
        '(deny file-read* (require-all (subpath "/Users") '
        "(require-not (subpath " + literal(runtime) + ")) "
        "(require-not (subpath " + literal(scripts) + "))))\n"
        '(deny file-read* (subpath "/Library/Keychains") (subpath "/private/var/root"))\n'
        "(allow file-read-metadata)\n"
        "(allow file-write* file-issue-extension (subpath " + literal(cache) + "))\n"
        # GPU services need read access to model/runtime data through extensions.
        "(allow file-issue-extension (subpath " + literal(runtime) + "))\n"
        + "".join("(allow file-write* file-issue-extension (subpath " + literal(path) + "))\n"
                  for path in metal)
        + '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero") '
        '(literal "/dev/random") (literal "/dev/urandom") (literal "/dev/dtracehelper"))\n'
        "(deny network*)\n"
        '(deny mach-lookup (global-name "com.apple.securityd") '
        '(global-name "com.apple.secd") (global-name "com.apple.SecurityAgent") '
        '(global-name "com.apple.audio.coreaudiod") (global-name "com.apple.audio.audiohald") '
        '(global-name "com.apple.audio.systemsoundserver"))\n'
    )


def environment(cache):
    return {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "TMPDIR": str(cache / "tmp") + "/",
        "CLANG_MODULE_CACHE_PATH": str(cache / "module-cache"),
        "LC_ALL": "en_US.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HOME": str(cache / "huggingface"),
        "TOKENIZERS_PARALLELISM": "false",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--python", type=Path)
    parser.add_argument("--speech-only", action="store_true")
    args = parser.parse_args()
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise ValueError("Native voice requires Apple Silicon macOS")
    runtime = args.runtime_root.resolve(strict=True)
    python = args.python or runtime / "venv/bin/python"
    # The environment is explicitly installed by the owner, not model output.
    if not python.is_absolute() or not python.parent.resolve().is_relative_to(runtime):
        raise ValueError("Native Python must belong to the selected runtime")
    if not os.access(python, os.X_OK):
        raise ValueError("Native voice Python is not installed")
    scripts = Path(__file__).resolve().parent
    manifest = json.loads((scripts / "native-models.json").read_text())
    cache = runtime / "cache"
    if cache.is_symlink():
        raise ValueError("Invalid native voice cache")
    children = [cache / name for name in ("tmp", "module-cache", "huggingface")]
    if any(path.is_symlink() or not path.resolve().is_relative_to(runtime) for path in children):
        raise ValueError("Invalid native voice cache")
    for path in children:
        path.mkdir(parents=True, exist_ok=True)
    cache = cache.resolve(strict=True)
    if not cache.is_relative_to(runtime):
        raise ValueError("Invalid native voice cache")
    command = [
        "/usr/bin/sandbox-exec", "-p", sandbox_profile(runtime, scripts, cache),
        str(python), "-B", str(scripts / "native_worker.py"),
        "--audio-model", str(runtime / "models" / manifest["audio"]["revision"]),
    ]
    if not args.speech_only:
        command += ["--router-model", str(runtime / "models" / manifest["router"]["revision"])]
    # Replace this process; parent cancellation targets the actual worker PID.
    # Libraries inspect cwd at startup; never broaden reads to the app workspace.
    os.chdir(cache)
    os.execve(command[0], command, environment(cache))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
