import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import shutil
import json

spec = importlib.util.spec_from_file_location("native_launcher", Path(__file__).with_name("native_launcher.py"))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


@unittest.skipUnless(sys.platform == "darwin", "macOS sandbox acceptance")
class SandboxTests(unittest.TestCase):
    def test_speech_only_launcher_does_not_require_a_router(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            scripts = root / "scripts"
            scripts.mkdir()
            (root / "venv/bin").mkdir(parents=True)
            (root / "venv/bin/python").symlink_to(sys.executable)
            shutil.copyfile(Path(__file__).with_name("native_launcher.py"), scripts / "native_launcher.py")
            (scripts / "native-models.json").write_text(json.dumps({"audio": {"revision": "fixture"}}))
            (scripts / "native_worker.py").write_text("import sys; print('speech-only' if '--router-model' not in sys.argv else 'router')\n")
            result = subprocess.run([sys.executable, str(scripts / "native_launcher.py"), "--runtime-root", str(root), "--speech-only"], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), b"speech-only")

    def test_worker_starts_from_private_cache_when_app_cwd_is_denied(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            scripts = root / "scripts"
            scripts.mkdir()
            (root / "venv/bin").mkdir(parents=True)
            (root / "venv/bin/python").symlink_to(sys.executable)
            shutil.copyfile(Path(__file__).with_name("native_launcher.py"), scripts / "native_launcher.py")
            (scripts / "native-models.json").write_text(json.dumps({
                "audio": {"revision": "fixture"}, "router": {"revision": "fixture"},
            }))
            (scripts / "native_worker.py").write_text(
                "import os; print('ready' if 'tmp' in os.listdir('.') else 'wrong')\n"
            )
            result = subprocess.run(
                [sys.executable, str(scripts / "native_launcher.py"), "--runtime-root", str(root)],
                cwd=Path(__file__).resolve().parents[2], capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), b"ready")

    def test_cache_symlink_cannot_create_files_outside_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            runtime, outside = root / "runtime", root / "outside"
            (runtime / "venv/bin").mkdir(parents=True)
            outside.mkdir()
            (runtime / "venv/bin/python").symlink_to(sys.executable)
            (runtime / "cache").symlink_to(outside, target_is_directory=True)
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("native_launcher.py")),
                 "--runtime-root", str(runtime)], capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(list(outside.iterdir()), [])

    def test_reads_only_allowed_home_files_and_writes_only_cache(self):
        # Quoted/spaced paths also exercise sandbox-profile escaping.
        with tempfile.TemporaryDirectory(prefix='native "voice" ') as directory:
            root = Path(directory).resolve()
            cache = root / "cache"
            cache.mkdir()
            fixture = root / "model-data"
            fixture.write_text("harmless fixture")
            profile = launcher.sandbox_profile(root, Path(__file__).parent.resolve(), cache)
            def run(*command):
                return subprocess.run(
                    ["/usr/bin/sandbox-exec", "-p", profile, *command],
                    capture_output=True,
                    env=launcher.environment(cache),
                )
            self.assertEqual(run("/bin/cat", str(fixture)).returncode, 0)
            # This repository instruction file is harmless, outside allowed script paths.
            self.assertNotEqual(run("/bin/cat", str(Path(__file__).resolve().parents[2] / "AGENTS.md")).returncode, 0)
            self.assertEqual(run("/usr/bin/touch", str(cache / "allowed")).returncode, 0)
            self.assertNotEqual(run("/usr/bin/touch", str(root / "forbidden-write")).returncode, 0)

    def test_network_is_denied(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            profile = launcher.sandbox_profile(root, Path(__file__).parent.resolve(), root)
            result = subprocess.run(
                ["/usr/bin/sandbox-exec", "-p", profile, sys.executable, "-c",
                 "import socket; s=socket.socket(); print(s.connect_ex(('127.0.0.1',9)))"],
                capture_output=True, env=launcher.environment(root),
            )
            # EPERM proves policy denial, not merely no listener (ECONNREFUSED).
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout.strip(), b"1")


if __name__ == "__main__":
    unittest.main()
