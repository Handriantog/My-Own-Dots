import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform == 'darwin', 'macOS sandbox acceptance')
class QwenLauncherTests(unittest.TestCase):
    def test_synthesis_launch_passes_saved_voice_and_needs_no_recognition_models(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            scripts = root/'scripts'; scripts.mkdir()
            runtime = root/'runtime'; (runtime/'venv/bin').mkdir(parents=True)
            (runtime/'venv/bin/python').symlink_to(sys.executable)
            tts = root/'tts'; (tts/'models'/'fixture').mkdir(parents=True)
            for name in ('qwen_launcher.py', 'native_launcher.py'):
                source = Path(__file__).with_name(name)
                if source.exists(): shutil.copyfile(source, scripts/name)
            (scripts/'qwen3-tts-model.json').write_text(json.dumps({'tts': {'revision': 'fixture'}}))
            (scripts/'qwen_tts.py').write_text('import json,sys; print(json.dumps(sys.argv[1:]))')
            result = subprocess.run([sys.executable, str(scripts/'qwen_launcher.py'),
                                    '--runtime-root', str(runtime), '--tts-root', str(tts),
                                    '--voice', 'ryan', '--personality', 'calm'], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), ['--model', str(tts/'models/fixture'),
                                                       '--voice', 'ryan', '--personality', 'calm'])


if __name__ == '__main__': unittest.main()
