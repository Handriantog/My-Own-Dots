"""Real macOS Ability confinement gate. Python stdlib and installed runtimes only.

Removing the sandbox, widening process creation/file access, leaking descriptors,
or removing parent-death cleanup must make these tests fail. All targets are
disposable files/processes/listeners created by this harness.
"""
import errno
import json
import os
from pathlib import Path
import select
import resource
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).with_name("fixtures")


def exists(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class SandboxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sys.platform != "darwin":
            raise RuntimeError("Real macOS acceptance is required; not a passing skip")
        cls.node = Path(shutil.which("node") or "missing-node").resolve()
        if not cls.node.is_file():
            raise RuntimeError("Installed Node is required for real runtime acceptance")
        cls.temporary = tempfile.TemporaryDirectory(prefix='dot-ability-"gate"-')
        cls.root = Path(cls.temporary.name).resolve()
        cls.package = cls.root / "package"
        cls.package.mkdir()
        cls.launcher = cls.root / "ability-launcher"
        cls.source = ROOT / "native/ability-launcher/main.c"
        cls.compile_error = "Ability launcher has not been implemented"
        if cls.source.exists():
            built = subprocess.run(["/usr/bin/xcrun", "clang", "-Wall", "-Wextra", "-Werror",
                                    "-Wno-deprecated-declarations", "-O2", str(cls.source),
                                    "-o", str(cls.launcher)], capture_output=True, text=True)
            cls.compile_error = built.stderr
        native = subprocess.run(["/usr/bin/xcrun", "clang", "-Wall", "-Wextra", "-Werror",
                                 "-Wno-deprecated-declarations", "-O2", str(FIXTURES / "native.c"),
                                 "-o", str(cls.package / "native")], capture_output=True, text=True)
        if native.returncode:
            raise RuntimeError(native.stderr)
        for name in ("node.mjs", "python.py"):
            shutil.copyfile(FIXTURES / name, cls.package / name)
        # python.org framework bin/python is a launcher which re-execs the app.
        # Execute its real interpreter directly; do not grant process creation.
        python = Path(sys.base_prefix) / "Resources/Python.app/Contents/MacOS/Python"
        if not python.is_file():
            python = Path(sys.executable)
        cls.executables = {
            "native": [str(cls.package / "native")],
            "python": [str(python.resolve()), "-I", "-S", "-B", str(cls.package / "python.py")],
            "node": [str(cls.node), str(cls.package / "node.mjs")],
        }

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.assertTrue(self.launcher.exists(), self.compile_error)
        self.state = self.root / self.id().rsplit(".", 1)[-1]
        self.state.mkdir(exist_ok=True)
        (self.state / "tmp").mkdir(exist_ok=True)
        self.secret = self.root / "other-dot-data"
        self.secret.write_text("disposable sentinel")
        self.profile = self.root / "profile.sb"
        self.profile.write_text(self.make_profile())
        self.profiles = {runtime: self.profile for runtime in self.executables}
        if os.environ.get("DOTS_ABILITY_APPLICATION_PROFILE") == "1":
            inputs = [{"packageRoot": str(self.package), "stateRoot": str(self.state),
                       "temporaryRoot": str(self.state / "tmp"), "executable": command[0],
                       "runtimeReadRoots": [] if runtime == "native" else
                       [str(self.node.parent)] if runtime == "node" else [str(Path(sys.base_prefix).resolve())]}
                      for runtime, command in self.executables.items()]
            generated = subprocess.run([str(self.node), "--import", "tsx", str(ROOT / "scripts/abilities/profile.mjs")],
                                       input=json.dumps(inputs), check=True, capture_output=True, text=True)
            for runtime, profile in zip(self.executables, json.loads(generated.stdout), strict=True):
                target = self.profile if runtime == "native" else self.root / (runtime + ".sb")
                target.write_text(profile)
                self.profiles[runtime] = target
        self.processes = []

    def tearDown(self):
        for process, control, status in self.processes:
            control.close()
            try:
                process.communicate(timeout=4)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
            status.close()

    def make_profile(self):
        literal = lambda path: json.dumps(str(path))
        runtime = [self.package, self.node.parent,
                   Path(sys.base_prefix).resolve(), Path(sys.executable).resolve().parent]
        reads = [Path("/System/Library"), Path("/usr/lib"), Path("/private/var/db/dyld"), *runtime]
        ancestors = sorted({str(parent) for path in [*reads, self.state] for parent in path.parents})
        return "\n".join([
            "(version 1)", "(deny default)", "(allow sysctl-read)",
            "(allow signal (target self))",
            # dyld on macOS 26 opens the root directory during cache discovery.
            # A literal match permits this directory, never its descendants.
            '(allow file-read-data (literal "/"))',
            "(allow file-read-metadata " + " ".join(f"(literal {literal(path)})" for path in ancestors) + ")",
            *[f"(allow file-read* (subpath {literal(path)}))" for path in reads],
            f"(allow file-read* file-write* (subpath {literal(self.state)}))",
            '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero") '
            '(literal "/dev/random") (literal "/dev/urandom"))',
            "(allow process-exec " + " ".join(
                f"(literal {literal(command[0])})" for command in self.executables.values()) + ")",
        ])

    def start(self, runtime, operation, *args, extra_fds=(), low_fd_limit=False):
        control_read, control_write = os.pipe()
        status_read, status_write = os.pipe()
        try:
            process = subprocess.Popen([
                str(self.launcher), "--profile", str(self.profiles[runtime]),
                "--control-fd", str(control_read), "--status-fd", str(status_write),
                "--", *self.executables[runtime], operation, *map(str, args),
            ], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                pass_fds=(control_read, status_write, *extra_fds), cwd=self.state,
                preexec_fn=(lambda: resource.setrlimit(resource.RLIMIT_NOFILE,
                    (64, resource.getrlimit(resource.RLIMIT_NOFILE)[1]))) if low_fd_limit else None,
                env={"PATH": "/usr/bin:/bin", "ABILITY_TEST_SECRET": "fixture-secret",
                     "NODE_OPTIONS": "--require=/nonexistent/ability-fixture",
                     "PYTHONPATH": str(self.root)})
        finally:
            os.close(control_read)
            os.close(status_write)
        status = os.fdopen(status_read, "rb", buffering=0)
        control = os.fdopen(control_write, "wb", buffering=0)
        self.processes.append((process, control, status))
        return process, control, status

    def run_probe(self, runtime, operation, *args, extra_fds=()):
        process, _, _ = self.start(runtime, operation, *args, extra_fds=extra_fds)
        output, errors = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, errors.decode(errors="replace"))
        return json.loads(output)

    def denied(self, runtime, operation, *args):
        report = self.run_probe(runtime, operation, *args)
        self.assertEqual(report["result"], -1, report)
        self.assertIn(report["errno"], (errno.EPERM, errno.EACCES), report)

    def test_private_paths(self):
        for runtime in self.executables:
            with self.subTest(runtime=runtime):
                own = self.state / runtime
                self.assertEqual(self.run_probe(runtime, "write", own)["result"], 1)
                self.assertEqual(self.run_probe(runtime, "read", own)["result"], 1)
                self.denied(runtime, "read", self.secret)
                self.denied(runtime, "write", self.secret)
                self.denied(runtime, "write", self.package / "tampered")
        self.assertEqual(self.secret.read_text(), "disposable sentinel")
        self.assertFalse((self.package / "tampered").exists())

    def test_no_direct_network(self):
        with socket.socket() as tcp, socket.socket(socket.AF_UNIX) as local:
            tcp.bind(("127.0.0.1", 0))
            tcp.listen()
            endpoint = self.root / "fixture.sock"
            local.bind(str(endpoint))
            local.listen()
            for runtime in self.executables:
                with self.subTest(runtime=runtime):
                    self.denied(runtime, "network", tcp.getsockname()[1])
                    self.denied(runtime, "unix", endpoint)

    def test_watchdog_rejects_network_and_named_unix_channels(self):
        for family in (socket.AF_INET, socket.AF_UNIX):
            with self.subTest(family=family), socket.socket(family) as listener, socket.socket(family) as client:
                address = ("127.0.0.1", 0) if family == socket.AF_INET else str(self.root / "watchdog.sock")
                listener.bind(address)
                listener.listen()
                client.connect(listener.getsockname())
                accepted, _ = listener.accept()
                status_read, status_write = os.pipe()
                try:
                    process = subprocess.run([str(self.launcher), "--profile", str(self.profile),
                        "--control-fd", str(accepted.fileno()), "--status-fd", str(status_write),
                        "--", *self.executables["native"], "write", str(self.state / "not-started")],
                        pass_fds=(accepted.fileno(), status_write), capture_output=True, timeout=3, cwd=self.state)
                    self.assertEqual(process.returncode, 125)
                    self.assertFalse((self.state / "not-started").exists())
                finally:
                    accepted.close()
                    os.close(status_read)
                    os.close(status_write)

    def test_no_fork_or_daemon(self):
        for runtime in self.executables:
            with self.subTest(runtime=runtime):
                self.denied(runtime, "fork")
        self.denied("native", "daemon")
        self.denied("native", "exec-other", "/usr/bin/true")

    def test_no_os_services(self):
        for service in ("com.apple.cfprefsd.daemon", "com.apple.coreservices.launchservicesd"):
            baseline = subprocess.run([*self.executables["native"], "mach", service],
                                      check=True, capture_output=True, text=True)
            self.assertEqual(json.loads(baseline.stdout)["result"], 0,
                             "Service must exist outside confinement for a meaningful denial test")
            report = self.run_probe("native", "mach", service)
            self.assertNotEqual(report["result"], 0, report)
        with subprocess.Popen(["/bin/sleep", "15"]) as unrelated:
            try:
                for runtime in self.executables:
                    self.denied(runtime, "signal", unrelated.pid)
                self.assertIsNone(unrelated.poll())
            finally:
                unrelated.terminate()

    def test_no_inherited_handles(self):
        with self.secret.open("rb") as secret:
            os.dup2(secret.fileno(), 123)
            try:
                for runtime in self.executables:
                    with self.subTest(runtime=runtime):
                        report = self.run_probe(runtime, "fd", 123, extra_fds=(123,))
                        self.assertEqual(report["errno"], errno.EBADF, report)
                        self.assertEqual(self.run_probe(runtime, "env")["result"], 0)
            finally:
                os.close(123)

    def test_handles_above_soft_limit(self):
        with self.secret.open("rb") as secret:
            os.dup2(secret.fileno(), 123)
            try:
                process, _, _ = self.start("native", "fd", 123, extra_fds=(123,), low_fd_limit=True)
                output, errors = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 0, errors)
                self.assertEqual(json.loads(output)["errno"], errno.EBADF)
            finally:
                os.close(123)

    def test_parent_death(self):
        for runtime, operation in [(name, "linger") for name in self.executables] + [("native", "reexec")]:
            with self.subTest(runtime=runtime, operation=operation):
                process, control, _ = self.start(runtime, operation)
                ready, _, _ = select.select([process.stdout], [], [], 4)
                self.assertTrue(ready, "Worker did not report readiness")
                line = process.stdout.readline()
                self.assertTrue(line, "Worker closed stdout before readiness")
                pid = json.loads(line)["pid"]
                self.assertTrue(exists(pid))
                control.close()
                started = time.monotonic()
                process.wait(timeout=3)
                self.assertLess(time.monotonic() - started, 3)
                self.assertFalse(exists(pid), f"Unsupervised worker {pid}")

    def test_owner_sigkill_with_open_control(self):
        # Keep the control pipe open in this process: only NOTE_EXIT/parent
        # identity detects the simulated desktop crash in this scenario.
        owner_code = '''
import json, os, subprocess, sys, time
command, inherited, cwd = json.loads(sys.argv[1])
child = subprocess.Popen(command, pass_fds=inherited, cwd=cwd,
                         stdin=subprocess.DEVNULL)
print(json.dumps({"supervisor": child.pid}), flush=True)
while True: time.sleep(1)
'''
        for runtime in self.executables:
            with self.subTest(runtime=runtime):
                control_read, control_write = os.pipe()
                status_read, status_write = os.pipe()
                command = [str(self.launcher), "--profile", str(self.profiles[runtime]),
                           "--control-fd", str(control_read), "--status-fd", str(status_write),
                           "--", *self.executables[runtime], "linger"]
                owner = subprocess.Popen([sys.executable, "-I", "-S", "-c", owner_code,
                    json.dumps([command, [control_read, status_write], str(self.state)])],
                    pass_fds=(control_read, status_write), stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, bufsize=0)
                os.close(control_read)
                os.close(status_write)
                worker = supervisor = None
                try:
                    with os.fdopen(status_read, "rb", buffering=0) as status:
                        self.assertTrue(select.select([status], [], [], 4)[0], "No spawn acknowledgment")
                        worker = json.loads(status.readline())["pid"]
                        # Both owner and worker emit one line; ordering may vary.
                        for _ in range(2):
                            self.assertTrue(select.select([owner.stdout], [], [], 4)[0], "Not ready")
                            report = json.loads(owner.stdout.readline())
                            supervisor = report.get("supervisor", supervisor)
                        owner.kill()
                        owner.wait(timeout=1)
                        self.assertTrue(select.select([status], [], [], 3)[0], "No cleanup acknowledgment")
                        report = json.loads(status.readline())
                        self.assertEqual(report, {"type": "exit", "code": 137})
                        observed = {"surviving_workers": [worker] if exists(worker) else []}
                        self.assertEqual(observed["surviving_workers"], [])
                finally:
                    os.close(control_write)
                    if owner.poll() is None:
                        owner.kill()
                    owner.wait(timeout=2)
                    # Only known fixture identities, on failure; never host PIDs.
                    if worker and exists(worker):
                        os.kill(worker, signal.SIGKILL)
                    if supervisor and exists(supervisor):
                        time.sleep(0.1)
                    owner.communicate(timeout=3)

    def test_path_replacement(self):
        alias = self.state / "alias"
        alias.symlink_to(self.secret)
        for runtime in self.executables:
            self.denied(runtime, "read", alias)
            self.denied(runtime, "write", alias)
            self.denied(runtime, "hardlink", self.secret, self.state / (runtime + "-linked"))
        self.assertEqual(self.secret.read_text(), "disposable sentinel")

    def test_path_replacement_race(self):
        safe = self.state / "safe"
        safe.write_text("safe")
        alias = self.state / "race"
        alias.symlink_to(safe)
        # Establish a deterministic positive control. During replacement every
        # attempted open may legitimately land on the forbidden target; requiring
        # a lucky successful write made the security check scheduler-dependent.
        for runtime in self.executables:
            self.assertGreater(self.run_probe(runtime, "race", alias)["result"], 0)
        stop = threading.Event()
        def replace():
            next_path = self.state / "next-link"
            while not stop.is_set():
                for destination in (self.secret, safe):
                    next_path.symlink_to(destination)
                    next_path.replace(alias)
        thread = threading.Thread(target=replace)
        thread.start()
        try:
            for runtime in self.executables:
                with self.subTest(runtime=runtime):
                    report = self.run_probe(runtime, "race", alias)
                    observed = {"outside_writes": int(self.secret.read_text() != "disposable sentinel")}
                    self.assertEqual(observed["outside_writes"], 0)
                    self.assertGreaterEqual(report["result"], 0)
        finally:
            stop.set()
            thread.join(timeout=2)

    def test_startup_failure(self):
        self.profile.write_text("(invalid-profile)")
        process, _, _ = self.start("native", "write", self.state / "should-not-exist")
        process.communicate(timeout=3)
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse((self.state / "should-not-exist").exists())

    def test_worker_failure_before_readiness(self):
        process, _, status = self.start("native", "unknown-probe")
        output, _ = process.communicate(timeout=3)
        self.assertEqual(process.returncode, 2)
        self.assertEqual(output, b"")
        events = [json.loads(line) for line in status.readlines()]
        self.assertEqual(events[1], {"type": "exit", "code": 2})
        self.assertFalse(exists(events[0]["pid"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
