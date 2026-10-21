"""Local fixtures only: no network, package installation, model imports or inference."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("setup_native", Path(__file__).with_name("setup_native.py"))
setup = importlib.util.module_from_spec(spec)
if spec.loader and Path(spec.origin).exists():
    spec.loader.exec_module(setup)


def artifact(data, name="model.safetensors"):
    return {"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "url": "https://huggingface.co/owner/model/resolve/" + "a" * 40 + "/" + name}


class NativeSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()

    def test_setup_exposes_explicit_artifact_preparation(self):
        self.assertTrue(callable(getattr(setup, "ensure_artifact", None)))

    def test_copies_verified_local_bytes_atomically_and_reuses_them(self):
        data = b"fixture model bytes"
        source = self.root / "source"
        source.write_bytes(data)
        item = artifact(data)
        with patch.object(setup, "download", side_effect=AssertionError("network forbidden")):
            target = setup.ensure_artifact(self.runtime, "models/revision/model.safetensors", item, source=source, offline=True)
            inode = target.stat().st_ino
            self.assertEqual(target.read_bytes(), data)
            self.assertEqual(setup.ensure_artifact(self.runtime, "models/revision/model.safetensors", item, offline=True).stat().st_ino, inode)
        self.assertFalse(list(self.runtime.rglob("*.partial")))

    def test_corrupt_or_oversized_local_copy_never_publishes(self):
        source = self.root / "source"
        for data in (b"changed", b"too many bytes for this bound"):
            source.write_bytes(data)
            with self.subTest(data=data), self.assertRaises(ValueError):
                setup.ensure_artifact(self.runtime, "models/file", artifact(b"expected"), source=source, offline=True)
            self.assertFalse((self.runtime / "models/file").exists())
            self.assertFalse(list(self.runtime.rglob("*.partial")))

    def test_same_size_hash_mismatch_and_existing_corruption_fail_closed(self):
        source = self.root / "source"
        source.write_bytes(b"tampered")
        with self.assertRaises(ValueError):
            setup.ensure_artifact(self.runtime, "model", artifact(b"expected"), source=source, offline=True)
        (self.runtime / "model").write_bytes(b"tampered")
        with patch.object(setup, "download", side_effect=AssertionError("network forbidden")), self.assertRaises(ValueError):
            setup.ensure_artifact(self.runtime, "model", artifact(b"expected"))
        self.assertEqual((self.runtime / "model").read_bytes(), b"tampered")

    def test_missing_offline_data_does_not_attempt_download(self):
        with patch.object(setup, "download", side_effect=AssertionError("network forbidden")), self.assertRaisesRegex(ValueError, "offline|Offline"):
            setup.ensure_artifact(self.runtime, "model", artifact(b"data"), offline=True)

    def test_rejects_absolute_traversal_and_symlinked_paths(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.runtime / "link").symlink_to(outside, target_is_directory=True)
        for name in ("../outside/file", "/tmp/absolute", "a/../file", "link/file", "a\\b", "a//b"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                setup.ensure_artifact(self.runtime, name, artifact(b"data"), offline=True)
        source = self.root / "source"
        source.write_bytes(b"data")
        link = self.root / "source-link"
        link.symlink_to(source)
        with self.assertRaises(ValueError):
            setup.ensure_artifact(self.runtime, "file", artifact(b"data"), source=link, offline=True)
        self.assertEqual(list(outside.iterdir()), [])

    def test_partial_download_is_removed_on_failure(self):
        def failed(item, stream, runtime):
            stream.write(b"partial")
            raise ValueError("fixture transfer failed")
        with patch.object(setup, "download", side_effect=failed), self.assertRaisesRegex(ValueError, "transfer failed"):
            setup.ensure_artifact(self.runtime, "file", artifact(b"expected"))
        self.assertEqual(list(self.runtime.iterdir()), [])

    def test_download_command_and_environment_exclude_credentials_and_non_https(self):
        command = setup.download_command(artifact(b"data"))
        self.assertEqual(command[:2], ["/usr/bin/curl", "-q"])
        self.assertIn("--max-filesize", command)
        self.assertEqual(command[command.index("--max-filesize") + 1], "4")
        self.assertIn("--proto-redir", command)
        self.assertEqual(command[command.index("--proto-redir") + 1], "=https")
        for url in ("http://huggingface.co/file", "https://user:secret@huggingface.co/file", "https://localhost/file", "https://files.pythonhosted.org:444/file"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                setup.download_command({**artifact(b"data"), "url": url})
        with patch.dict("os.environ", {"HF_TOKEN": "secret", "HTTPS_PROXY": "private", "PYTHONPATH": "private", "UV_INDEX_URL": "private"}):
            env = setup.environment(self.runtime)
        self.assertFalse({"HOME", "HF_TOKEN", "HTTPS_PROXY", "PYTHONPATH", "UV_INDEX_URL"} & env.keys())
        profile = setup.sandbox_profile(self.runtime, [], network=False)
        self.assertIn("(deny network*)", profile)
        self.assertIn('"com.apple.securityd"', profile)

    def test_wheel_archive_rejects_startup_hooks_symlinks_and_traversal(self):
        for name, mode in (("unsafe.pth", 0), ("sitecustomize.py", 0), ("../outside", 0), ("pkg/link", 0o120777 << 16), ("pkg.data/scripts/run", 0)):
            path = self.root / "fixture.whl"
            with zipfile.ZipFile(path, "w") as wheel:
                entry = zipfile.ZipInfo(name)
                entry.external_attr = mode
                wheel.writestr(entry, b"do not execute")
            with self.subTest(name=name), self.assertRaises(ValueError):
                setup.inspect_wheel(path)

    @unittest.skipUnless(sys.platform == "darwin", "macOS sandbox acceptance")
    def test_sandbox_allows_canonical_runtime_paths_but_denies_outside_contents(self):
        # /Users ancestors reproduce uv's canonicalization failure; /tmp would not.
        directory = Path(__file__).resolve().parent
        if not directory.is_relative_to("/Users"):
            self.skipTest("This sandbox regression requires a checkout below /Users")
        with tempfile.TemporaryDirectory(prefix='.setup "sandbox" ', dir=directory) as temporary:
            root = Path(temporary).resolve()
            runtime = root / "runtime"
            target = runtime / "venv/bin/fixture"
            target.parent.mkdir(parents=True)
            target.write_text("allowed fixture")
            outside = root / "outside"
            outside.write_text("benign outside fixture")
            code = (
                "import pathlib,sys\n"
                "target,outside=map(pathlib.Path,sys.argv[1:])\n"
                "assert target.resolve(strict=True)==target\n"
                "assert target.read_text()=='allowed fixture'\n"
                "assert outside.stat().st_size>0\n"
                "for mode in ('r','w'):\n"
                " try:\n"
                "  with outside.open(mode): pass\n"
                " except PermissionError: pass\n"
                " else: raise AssertionError('outside contents accessible')\n"
                "print('canonical path allowed; outside contents denied')\n"
            )
            result = subprocess.run(
                setup.sandbox_command([sys.executable, "-I", "-S", "-c", code,
                                       str(target), str(outside)], runtime),
                cwd=runtime, env=setup.environment(runtime), capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "canonical path allowed; outside contents denied")
            self.assertEqual(outside.read_text(), "benign outside fixture")

    def test_installer_is_pinned_offline_wheels_only_inside_selected_venv(self):
        command = setup.install_command(Path("/trusted/uv"), self.runtime)
        self.assertIn("--offline", command)
        self.assertIn("--no-config", command)
        self.assertIn("--no-index", command)
        self.assertIn("--require-hashes", command)
        self.assertNotIn("--no-build", command)  # Conflicts with --only-binary in reviewed uv.
        self.assertEqual(command[command.index("--only-binary") + 1], ":all:")
        self.assertEqual(command[command.index("--python") + 1], str(self.runtime / "venv/bin/python"))
        self.assertEqual(command[command.index("--keyring-provider") + 1], "disabled")
        self.assertNotIn("--system", command)

    def test_existing_uv_accepts_install_flags_before_reading_missing_requirements(self):
        uv = shutil.which("uv")
        if not uv:
            self.skipTest("Existing uv CLI is unavailable; no CLI is downloaded for tests")
        # A missing input and --dry-run prevent installation or interpreter execution.
        # Reaching this input error proves argument validation accepted the real command.
        result = subprocess.run(setup.install_command(Path(uv), self.runtime) + ["--dry-run"],
                                cwd=self.runtime, env=setup.environment(self.runtime),
                                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("File not found", result.stderr)
        self.assertIn("requirements-native.txt", result.stderr)
        self.assertNotIn("cannot be used with", result.stderr)
        self.assertFalse((self.runtime / "venv").exists())

    def test_manifests_match_exact_requirements_and_model_bytes(self):
        wheels, models = setup.load_manifests()
        self.assertEqual(len(wheels["packages"]), 36)
        self.assertEqual(sum(item["bytes"] for item in wheels["packages"]), 131988574)
        self.assertEqual(sum(item["bytes"] for model in (models["audio"], models["router"]) for item in model["files"]), 3682006015)
        requirements = Path(__file__).with_name("requirements-native.txt").read_text()
        setup.verify_requirements(wheels, requirements)
        with self.assertRaises(ValueError):
            setup.verify_requirements(wheels, requirements.replace("anyio==4.14.2", "anyio==4.14.1"))

    def test_rejects_unexpected_model_files_and_symlinked_runtime_roots(self):
        (self.runtime / "unexpected.py").write_text("raise AssertionError('never execute')")
        with self.assertRaises(ValueError):
            setup.verify_inventory(self.runtime, {"config.json"}, allow_missing=True)
        link = self.root / "runtime-link"
        link.symlink_to(self.runtime, target_is_directory=True)
        with self.assertRaises(ValueError):
            setup.validate_root(link)

    def test_verifies_installed_files_without_importing_them_and_rejects_tampering(self):
        metadata = self.runtime / "venv/lib/python3.14/site-packages/fixture-1.0.dist-info/METADATA"
        metadata.parent.mkdir(parents=True)
        metadata.write_text("Name: fixture\nVersion: 1.0\n")
        module = metadata.parent.parent / "fixture.py"
        module.write_text("raise AssertionError('package code must never execute')\n")
        python = self.runtime / "venv/bin/python"
        python.parent.mkdir(parents=True)
        python.write_bytes(b"fixture executable, not run")
        wheels = {"packages": [{"name": "fixture", "version": "1.0"}]}
        identity = {"executable": "fixture"}
        receipt = {"version": 1, "locks": setup.lock_identity(), "python": identity,
                   "files": setup.venv_inventory(self.runtime, wheels)}
        requirements = Path(__file__).with_name("requirements-native.txt").read_bytes()
        (self.runtime / "requirements-native.txt").write_bytes(requirements)
        (self.runtime / "native-ready.json").write_text(json.dumps(receipt))
        with patch.object(setup.subprocess, "run", side_effect=AssertionError("nothing executes")):
            setup.verify_ready(self.runtime, wheels, identity)
            module.write_text("changed")
            with self.assertRaisesRegex(ValueError, "changed"):
                setup.verify_ready(self.runtime, wheels, identity)
            module.write_text("raise AssertionError('package code must never execute')\n")
            (self.runtime / "requirements-native.txt").write_text("unreviewed package")
            with self.assertRaises(ValueError):
                setup.verify_ready(self.runtime, wheels, identity)

    def test_rejects_unexpected_model_revision_directories_before_downloading(self):
        models = self.runtime / "models"
        models.mkdir()
        (models / "unreviewed.py").write_text("never execute")
        manifest = {"audio": {"revision": "a" * 40, "repository": "owner/audio", "files": [artifact(b"one")]},
                    "router": {"revision": "b" * 40, "repository": "owner/router", "files": [artifact(b"two")]}}
        with patch.object(setup, "download", side_effect=AssertionError("no network")), self.assertRaisesRegex(ValueError, "Unexpected"):
            setup.prepare_artifacts(self.runtime, {"packages": []}, manifest, offline=True)

    def test_rejects_world_writable_runtime_and_honors_single_setup_lock(self):
        self.runtime.chmod(0o777)
        with self.assertRaises(ValueError):
            setup.validate_root(self.runtime)
        self.runtime.chmod(0o700)
        with setup.setup_lock(self.runtime):
            with self.assertRaisesRegex(ValueError, "already running"):
                with setup.setup_lock(self.runtime):
                    self.fail("second setup acquired the lock")

    def test_special_source_files_fail_without_blocking_on_open(self):
        fifo = self.root / "fifo"
        os.mkfifo(fifo)
        code = (
            "import importlib.util,sys; "
            "s=importlib.util.spec_from_file_location('setup',sys.argv[1]); "
            "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
            "m.open_regular(m.Path(sys.argv[2]))"
        )
        result = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", code,
                                 str(Path(__file__).with_name("setup_native.py")), str(fifo)],
                                capture_output=True, timeout=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"regular file", result.stderr)


if __name__ == "__main__":
    unittest.main()
