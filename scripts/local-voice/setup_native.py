"""Explicit native-voice setup. Standard library only; never imports model code.

Downloads are public, content pinned data. Installation uses an existing, reviewed
uv CLI, an isolated venv and offline wheels. No package build or inference occurs.
"""
import argparse
from contextlib import contextmanager
from email.parser import Parser
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import uuid
from urllib.parse import urlsplit
import zipfile

SCRIPTS = Path(__file__).resolve().parent
MAX_FILE = 2_400_000_000
MAX_MODEL_BYTES = 3_800_000_000
MAX_WHEEL_BYTES = 150_000_000
MAX_ENV_BYTES = 3_000_000_000
CHUNK = 1024 * 1024
UV_VERSION = "0.11.6"
SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def relative_path(value):
    require(isinstance(value, str) and 0 < len(value) <= 1024, "Invalid artifact path")
    parts = PurePosixPath(value).parts
    require(not value.startswith("/") and "\\" not in value and "\x00" not in value
            and all(p not in (".", "..") for p in parts)
            and "/".join(parts) == value, "Invalid artifact path")
    return Path(*parts)


def no_symlinks(path):
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts, "An absolute path is required")
    for item in (*reversed(path.parents), path):
        require(not item.is_symlink(), "Symlinked setup path is not allowed")
    return path


def validate_root(path, create=False):
    root = no_symlinks(Path(path).expanduser())
    require(root != Path(root.anchor) and root != Path.home(), "Choose a dedicated runtime directory")
    if create:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(root.is_dir() and root.stat().st_uid == os.getuid(), "Runtime directory must belong to this user")
    require(root.stat().st_mode & 0o022 == 0, "Runtime directory must not be writable by other users")
    return root


def local_path(root, relative, parents=False):
    path = no_symlinks(root / relative_path(relative))
    if parents:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def open_regular(path):
    no_symlinks(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(stat.S_ISREG(os.fstat(descriptor).st_mode), "Artifact must be a regular file")
        return os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise


def digest_file(path, expected_bytes=None):
    with open_regular(path) as stream:
        size = os.fstat(stream.fileno()).st_size
        require(size <= MAX_FILE, "Artifact exceeds its byte bound")
        require(expected_bytes is None or size == expected_bytes, "Artifact byte count mismatch")
        digest = hashlib.sha256()
        count = 0
        while block := stream.read(CHUNK):
            count += len(block)
            require(expected_bytes is None or count <= expected_bytes, "Artifact exceeds its byte bound")
            digest.update(block)
        require(count == size, "Artifact changed during verification")
        return count, digest.hexdigest()


def verify_artifact(path, item):
    size, digest = digest_file(path, item["bytes"])
    require(digest == item["sha256"], "Artifact SHA-256 mismatch")
    return size


def validate_artifact(item):
    require(type(item["bytes"]) is int and 0 < item["bytes"] <= MAX_FILE, "Invalid artifact byte bound")
    require(isinstance(item["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", item["sha256"]), "Invalid artifact hash")


def public_url(url):
    parsed = urlsplit(url)
    require(parsed.scheme == "https" and parsed.hostname in ("files.pythonhosted.org", "huggingface.co")
            and not parsed.username and not parsed.password and parsed.port is None
            and not parsed.query and not parsed.fragment, "Only pinned public HTTPS URLs are allowed")
    return url


def load_manifests():
    wheels = json.loads((SCRIPTS / "native-wheels.json").read_text())
    models = json.loads((SCRIPTS / "native-models.json").read_text())
    require(wheels["version"] == 1 and models["version"] == 1, "Unsupported native setup manifest")
    require(len(wheels["packages"]) == 36, "Unexpected native dependency closure")
    names, filenames = set(), set()
    for item in wheels["packages"]:
        validate_artifact(item)
        require(re.fullmatch(r"[a-z0-9][a-z0-9-]*", item["name"]) and re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", item["version"]), "Invalid package pin")
        filename = relative_path(item["filename"])
        require(len(filename.parts) == 1 and filename.suffix == ".whl", "Only selected wheels are allowed")
        require(item["name"] not in names and item["filename"].casefold() not in filenames, "Duplicate package pin")
        names.add(item["name"])
        filenames.add(item["filename"].casefold())
        require(urlsplit(public_url(item["url"])).hostname == "files.pythonhosted.org"
                and item["url"].endswith("/" + item["filename"]), "Wheel URL mismatch")
    wheel_bytes = sum(item["bytes"] for item in wheels["packages"])
    require(wheel_bytes == wheels["total_bytes"] and wheel_bytes <= MAX_WHEEL_BYTES, "Wheelhouse byte limit exceeded")
    require(set(models) == {"version", "audio", "router"}, "Unexpected model roles")
    for role in ("audio", "router"):
        model = models[role]
        require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", model["repository"])
                and re.fullmatch(r"[a-f0-9]{40}", model["revision"]), "Model revision must be pinned")
        paths = set()
        for item in model["files"]:
            validate_artifact(item)
            path = relative_path(item["path"])
            require(path.suffix in (".json", ".safetensors") and str(path).casefold() not in paths, "Only unique model data files are allowed")
            paths.add(str(path).casefold())
    require(sum(item["bytes"] for role in ("audio", "router") for item in models[role]["files"]) <= MAX_MODEL_BYTES, "Model byte limit exceeded")
    verify_requirements(wheels, (SCRIPTS / "requirements-native.txt").read_text())
    return wheels, models


def verify_requirements(wheels, text):
    expected = {f'{item["name"]}=={item["version"]} --hash=sha256:{item["sha256"]}' for item in wheels["packages"]}
    lines = [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    require(len(lines) == len(expected) and set(lines) == expected, "Requirements do not match reviewed wheel pins")


def environment(runtime):
    return {
        "PATH": SYSTEM_PATH, "LC_ALL": "en_US.UTF-8",
        "TMPDIR": str(runtime / "cache/tmp") + "/", "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1", "UV_NO_CONFIG": "1", "UV_KEYRING_PROVIDER": "disabled",
        "UV_PYTHON_DOWNLOADS": "never", "UV_CACHE_DIR": str(runtime / "cache/uv"),
        "MACOSX_DEPLOYMENT_TARGET": "26.0",
        "CURL_SSL_BACKEND": "openssl",
    }


def sandbox_profile(runtime, readable, network=False):
    literal = lambda value: json.dumps(str(value))
    exceptions = "".join("(require-not (subpath " + literal(path) + "))" for path in [runtime, *readable])
    return (
        "(version 1)\n(allow default)\n"
        + ("" if network else "(deny network*)\n")
        + '(deny file-read* (require-all (subpath "/Users") ' + exceptions + "))\n"
        + '(deny file-read* (subpath "/Library/Keychains") (subpath "/private/var/root"))\n'
        # Canonicalization needs ancestor metadata even when contents stay denied.
        + "(allow file-read-metadata)\n"
        + '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.secd") '
          '(global-name "com.apple.SecurityAgent"))\n'
        + "(deny file-write*)\n(allow file-write* (subpath " + literal(runtime) + "))\n"
        + '(allow file-write* (literal "/dev/null"))\n'
    )


def sandbox_command(command, runtime, readable=(), network=False):
    return ["/usr/bin/sandbox-exec", "-p", sandbox_profile(runtime, readable, network), *map(str, command)]


def download_command(item):
    validate_artifact(item)
    return [
        "/usr/bin/curl", "-q", "--fail", "--silent", "--show-error", "--location",
        "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "5",
        "--proxy", "", "--no-ca-native", "--cacert", "/etc/ssl/cert.pem",
        "--connect-timeout", "30", "--max-time", "3600", "--max-filesize", str(item["bytes"]),
        "--output", "-", public_url(item["url"]),
    ]


def download(item, stream, runtime):
    # curl cannot read credentials or use Keychain, and receives no inherited proxy/config.
    command = sandbox_command(download_command(item), runtime, network=True)
    result = subprocess.run(command, stdout=stream, stderr=subprocess.PIPE,
                            env=environment(runtime), cwd=runtime, timeout=3660)
    require(result.returncode == 0, "Public artifact download failed (no credentials or Keychain access permitted)")


def ensure_artifact(runtime, relative, item, source=None, offline=False):
    validate_artifact(item)
    target = local_path(runtime, relative, parents=True)
    if target.exists():
        verify_artifact(target, item)
        return target
    require(source is not None or not offline, "Artifact missing in offline setup")
    partial = target.with_name(target.name + "." + uuid.uuid4().hex + ".partial")
    descriptor = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            if source is None:
                download(item, output, runtime)
            else:
                with open_regular(Path(source)) as incoming:
                    require(os.fstat(incoming.fileno()).st_size == item["bytes"], "Artifact byte count mismatch")
                    count = 0
                    while block := incoming.read(CHUNK):
                        count += len(block)
                        require(count <= item["bytes"], "Artifact exceeds its byte bound")
                        output.write(block)
            output.flush()
            os.fsync(output.fileno())
        verify_artifact(partial, item)
        # Atomic publication without overwriting an existing file or following a link.
        os.link(partial, target, follow_symlinks=False)
        return target
    finally:
        partial.unlink(missing_ok=True)


def verify_inventory(directory, expected, allow_missing=False):
    no_symlinks(directory)
    if not directory.exists():
        require(allow_missing, "Artifact directory is missing")
        return
    parents = {str(parent) for name in expected for parent in relative_path(name).parents if str(parent) != "."}
    found = set()
    for path in directory.rglob("*"):
        no_symlinks(path)
        name = path.relative_to(directory).as_posix()
        if path.is_dir():
            require(name in parents, "Unexpected artifact directory")
        else:
            require(path.is_file() and name in expected, "Unexpected artifact file")
            found.add(name)
    require(allow_missing or found == expected, "Required artifact is missing")


def inspect_wheel(path):
    total, names = 0, set()
    with zipfile.ZipFile(path) as archive:
        for item in archive.infolist():
            name = item.filename.rstrip("/")
            relative_path(name)
            require(name.casefold() not in names, "Duplicate wheel path")
            names.add(name.casefold())
            require(not stat.S_ISLNK(item.external_attr >> 16), "Wheel symlinks are forbidden")
            require(not name.lower().endswith(".pth") and ".data/scripts/" not in name.lower()
                    and Path(name).name.lower() not in ("sitecustomize.py", "usercustomize.py"), "Wheel startup hooks/scripts are forbidden")
            total += item.file_size
            require(item.file_size <= MAX_FILE and total <= MAX_ENV_BYTES, "Expanded wheel limit exceeded")


def prepare_artifacts(runtime, wheels, models, wheel_source=None, model_source=None, offline=False, verify_only=False):
    model_paths = {models[role]["revision"] + "/" + item["path"]
                   for role in ("audio", "router") for item in models[role]["files"]}
    verify_inventory(runtime / "models", model_paths, allow_missing=not verify_only)
    wheel_dir = runtime / "wheelhouse"
    verify_inventory(wheel_dir, {item["filename"] for item in wheels["packages"]}, allow_missing=not verify_only)
    for item in wheels["packages"]:
        relative = "wheelhouse/" + item["filename"]
        if verify_only:
            verify_artifact(local_path(runtime, relative), item)
        else:
            ensure_artifact(runtime, relative, item,
                            source=wheel_source / item["filename"] if wheel_source else None, offline=offline)
        inspect_wheel(local_path(runtime, relative))
    for role in ("audio", "router"):
        model = models[role]
        directory = runtime / "models" / model["revision"]
        verify_inventory(directory, {item["path"] for item in model["files"]}, allow_missing=not verify_only)
        for item in model["files"]:
            relative = "models/" + model["revision"] + "/" + item["path"]
            if verify_only:
                verify_artifact(local_path(runtime, relative), item)
            else:
                remote = {**item, "url": "https://huggingface.co/" + model["repository"] + "/resolve/" + model["revision"] + "/" + item["path"]}
                ensure_artifact(runtime, relative, remote,
                                source=model_source / model["revision"] / item["path"] if model_source else None, offline=offline)


def install_command(uv, runtime):
    # --only-binary :all: forbids source builds; uv rejects pairing it with --no-build.
    return [str(uv), "--no-config", "--offline", "--no-python-downloads", "pip", "sync",
            "--python", str(runtime / "venv/bin/python"), "--no-index",
            "--find-links", str(runtime / "wheelhouse"), "--require-hashes",
            "--only-binary", ":all:", "--keyring-provider", "disabled",
            "--link-mode", "copy", "--strict", str(runtime / "requirements-native.txt")]


def run_command(command, runtime, readable):
    result = subprocess.run(sandbox_command(command, runtime, readable), env=environment(runtime),
                            cwd=runtime, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    require(result.returncode == 0, "Native setup subprocess failed: " + result.stderr.decode(errors="replace")[-1500:])
    return result.stdout.decode()


def check_python(python, runtime):
    require(python.is_absolute(), "--python must name an absolute installed interpreter")
    python = python.resolve(strict=True)  # Explicit owner-selected interpreter aliases are allowed.
    require(python.is_file() and os.access(python, os.X_OK), "Python interpreter is unavailable")
    code = ('import json,sys,sysconfig,platform; print(json.dumps({"implementation":sys.implementation.name,'
            '"version":list(sys.version_info[:3]),"machine":platform.machine(),"platform":sys.platform,'
            '"gil_disabled":bool(sysconfig.get_config_var("Py_GIL_DISABLED")),"prefix":sys.base_prefix}))')
    metadata = json.loads(run_command([python, "-I", "-S", "-c", code], runtime, [python.parent.parent]))
    require(metadata["implementation"] == "cpython" and metadata["version"][:2] == [3, 14]
            and metadata["machine"] == "arm64" and metadata["platform"] == "darwin"
            and not metadata["gil_disabled"], "Use existing CPython 3.14, ordinary GIL build, macOS arm64")
    return python, {**metadata, "executable": str(python), "sha256": digest_file(python)[1]}


def venv_inventory(runtime, wheels):
    root = local_path(runtime, "venv")
    require(root.is_dir(), "Native venv is missing")
    rows, total = [], 0
    for index, path in enumerate(root.rglob("*")):
        require(index < 16_000, "Installed environment entry limit exceeded")
        no_symlinks(path)
        if path.is_dir():
            continue
        require(path.is_file() and path.suffix != ".pth", "Unexpected venv startup hook or special file")
        size, digest = digest_file(path)
        total += size
        require(len(rows) < 12_000 and size <= MAX_FILE and total <= MAX_ENV_BYTES, "Installed environment exceeds its bound")
        rows.append({"path": path.relative_to(root).as_posix(), "bytes": size, "sha256": digest})
    actual = {}
    for path in root.glob("lib/python3.14/site-packages/*.dist-info/METADATA"):
        require(path.stat().st_size < CHUNK, "Package metadata exceeds limit")
        metadata = Parser().parsestr(path.read_text())
        name = re.sub(r"[-_.]+", "-", metadata["Name"]).lower()
        require(name not in actual, "Duplicate installed package metadata")
        actual[name] = metadata["Version"]
    require(actual == {item["name"]: item["version"] for item in wheels["packages"]}, "Installed packages do not match reviewed closure")
    require((root / "bin/python").is_file(), "Venv interpreter is missing")
    return sorted(rows, key=lambda row: row["path"])


def lock_identity():
    return {name: hashlib.sha256((SCRIPTS / name).read_bytes()).hexdigest()
            for name in ("native-wheels.json", "native-models.json", "requirements-native.txt")}


def verify_ready(runtime, wheels, python):
    requirements = (SCRIPTS / "requirements-native.txt").read_bytes()
    verify_artifact(local_path(runtime, "requirements-native.txt"), {
        "bytes": len(requirements), "sha256": hashlib.sha256(requirements).hexdigest(),
    })
    ready = local_path(runtime, "native-ready.json")
    require(ready.is_file() and ready.stat().st_size <= 4 * CHUNK, "Native setup is incomplete; no ready receipt")
    with open_regular(ready) as stream:
        receipt = json.load(stream)
    require(receipt.get("version") == 1 and receipt.get("locks") == lock_identity()
            and receipt.get("python") == python, "Native setup identity changed; use a separate runtime directory")
    require(receipt.get("files") == venv_inventory(runtime, wheels), "Installed runtime changed after setup")


@contextmanager
def setup_lock(runtime):
    path = local_path(runtime, ".setup.lock")
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        require(stat.S_ISREG(os.fstat(descriptor).st_mode), "Setup lock must be a regular file")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another native setup is already running") from None
        yield
    finally:
        os.close(descriptor)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", type=Path, default=Path.home() / "Library/Application Support/My Own Dots/native-voice")
    parser.add_argument("--python", type=Path, required=True, help="Explicit existing CPython 3.14 interpreter")
    parser.add_argument("--uv", type=Path, help="Explicit existing reviewed uv 0.11.6 executable")
    parser.add_argument("--wheel-source", type=Path, help="Offline directory containing exact selected wheel filenames")
    parser.add_argument("--model-source", type=Path, help="Offline model directory containing revision subdirectories")
    parser.add_argument("--offline", action="store_true", help="Never download missing artifacts")
    parser.add_argument("--verify-only", action="store_true", help="Verify an existing setup; never install or download")
    args = parser.parse_args(argv)
    require(sys.platform == "darwin" and platform.machine() == "arm64"
            and int(platform.mac_ver()[0].split(".")[0]) >= 26, "Selected wheels require macOS 26+ on Apple Silicon")
    wheels, models = load_manifests()
    runtime = validate_root(args.runtime_root, create=not args.verify_only)
    allowed = {"wheelhouse", "models", "cache", "venv", "requirements-native.txt", "native-ready.json", ".setup.lock"}
    require(all(path.name in allowed and not path.is_symlink() for path in runtime.iterdir()), "Runtime directory contains unrelated or symlinked files")
    for source in (args.wheel_source, args.model_source):
        if source:
            require(no_symlinks(source).is_dir(), "Offline source directory is unavailable")
    with setup_lock(runtime):
        for name in ("cache/tmp", "cache/uv"):
            path = local_path(runtime, name)
            if not args.verify_only:
                path.mkdir(parents=True, exist_ok=True, mode=0o700)
        python, metadata = check_python(args.python, runtime)
        ready = (runtime / "native-ready.json").exists()
        uv = None
        readable = [python.parent.parent]
        if not ready and not args.verify_only:
            require(not (runtime / "venv").exists(), "Unmarked or interrupted venv exists; inspect it and use a fresh runtime directory")
            uv = args.uv or Path(shutil.which("uv") or "")
            require(uv.is_absolute() and uv.is_file(), "An existing reviewed uv 0.11.6 executable is required")
            uv = uv.resolve(strict=True)
            readable.append(uv)
            require(run_command([uv, "--version"], runtime, readable).strip().split()[:2] == ["uv", UV_VERSION], "Use reviewed uv 0.11.6; setup never downloads package managers")
        prepare_artifacts(runtime, wheels, models, args.wheel_source, args.model_source, args.offline, args.verify_only)
        if ready:
            verify_ready(runtime, wheels, metadata)
            print("Native voice runtime verified; existing installation reused.")
            return
        require(not args.verify_only, "Native setup is incomplete; no ready receipt")
        requirements = (SCRIPTS / "requirements-native.txt").read_bytes()
        pin = {"bytes": len(requirements), "sha256": hashlib.sha256(requirements).hexdigest()}
        ensure_artifact(runtime, "requirements-native.txt", pin, source=SCRIPTS / "requirements-native.txt", offline=True)
        created = False
        try:
            # --without-pip avoids unreviewed seed packages. --copies keeps runtime files inside the venv.
            created = True
            run_command([python, "-I", "-S", "-m", "venv", "--without-pip", "--copies", str(runtime / "venv")], runtime, readable)
            run_command(install_command(uv, runtime), runtime, readable)
            receipt = {"version": 1, "locks": lock_identity(), "python": metadata, "files": venv_inventory(runtime, wheels)}
            data = (json.dumps(receipt, separators=(",", ":")) + "\n").encode()
            ready = local_path(runtime, "native-ready.json")
            temporary = ready.with_name(".native-ready-" + uuid.uuid4().hex + ".partial")
            try:
                with temporary.open("xb") as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                os.link(temporary, ready, follow_symlinks=False)
            finally:
                temporary.unlink(missing_ok=True)
        except BaseException:
            if created and (runtime / "venv").exists():
                no_symlinks(runtime / "venv")
                shutil.rmtree(runtime / "venv")
            raise
        print("Native voice setup complete. No models were imported or inference run.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print("Native setup failed: " + str(error), file=sys.stderr)
        sys.exit(1)
