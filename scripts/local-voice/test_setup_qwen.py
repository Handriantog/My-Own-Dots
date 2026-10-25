import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys

spec = importlib.util.spec_from_file_location('setup_qwen', Path(__file__).with_name('setup_qwen.py'))
setup = importlib.util.module_from_spec(spec)
if Path(spec.origin).exists(): spec.loader.exec_module(setup)


class QwenSetupTests(unittest.TestCase):
    def test_setup_cli_runs_with_isolated_python_without_loading_model_packages(self):
        result = subprocess.run([sys.executable, '-I', '-S', '-B', str(Path(__file__).with_name('setup_qwen.py')), '--help'], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b'--tts-root', result.stdout)

    def test_installs_only_pinned_model_files_and_rejects_corruption_on_reuse(self):
        prepare = getattr(setup, 'prepare_model', None)
        self.assertTrue(callable(prepare), 'Qwen model setup must be explicit and hash verified')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); runtime = root/'runtime'; runtime.mkdir()
            source = root/'source'; (source/'a').mkdir(parents=True)
            data = b'model fixture'; (source/'a/model.safetensors').write_bytes(data)
            model = {'repository':'owner/model', 'revision':'a', 'files':[
                {'path':'model.safetensors', 'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}]}
            prepare(runtime, model, source, offline=True)
            target=runtime/'models/a/model.safetensors'
            self.assertEqual(target.read_bytes(), data)
            prepare(runtime, model, source, offline=True)
            target.write_bytes(b'changed data!')
            with self.assertRaises(ValueError): prepare(runtime, model, source, offline=True)

    def test_actual_manifest_has_only_pinned_data_and_supported_custom_voice_config(self):
        load = getattr(setup, 'load_manifest', None)
        self.assertTrue(callable(load), 'Setup must reject unpinned/executable assets')
        model=load()
        self.assertEqual(len(model['revision']),40)
        self.assertTrue(all(len(row['sha256'])==64 for row in model['files']))
        self.assertGreater(sum(row['bytes'] for row in model['files']), 3_000_000_000)
        self.assertFalse(any(row['path'].endswith(('.py','.bin','.pkl')) for row in model['files']))


if __name__ == '__main__': unittest.main()
