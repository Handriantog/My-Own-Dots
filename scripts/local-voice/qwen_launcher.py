"""Launch the Qwen speech process with the existing reviewed offline runtime."""
import argparse
import json
import os
from pathlib import Path
import platform
import sys
from native_launcher import sandbox_profile, environment


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime-root', type=Path, required=True)
    parser.add_argument('--python', type=Path)
    parser.add_argument('--tts-root', type=Path, required=True)
    parser.add_argument('--voice', required=True)
    parser.add_argument('--personality', required=True)
    args = parser.parse_args()
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        raise ValueError('High voice requires Apple Silicon macOS')
    for root in (args.runtime_root, args.tts_root):
        if not root.is_absolute() or any(p.is_symlink() for p in (root, *root.parents)):
            raise ValueError('Invalid speech runtime path')
    runtime, tts = args.runtime_root.resolve(strict=True), args.tts_root.resolve(strict=True)
    python = args.python or runtime/'venv/bin/python'
    if not python.is_absolute() or not python.parent.resolve().is_relative_to(runtime) or not os.access(python, os.X_OK):
        raise ValueError('Native Python must belong to the selected runtime')
    scripts = Path(__file__).resolve().parent
    manifest = json.loads((scripts/'qwen3-tts-model.json').read_text())['tts']
    cache = tts/'cache'
    for path in [cache, *[cache/name for name in ('tmp', 'module-cache', 'huggingface')]]:
        if path.is_symlink() or not path.resolve().is_relative_to(tts):
            raise ValueError('Invalid speech cache')
        path.mkdir(parents=True, exist_ok=True)
    command = ['/usr/bin/sandbox-exec', '-p', sandbox_profile(runtime, scripts, cache, tts),
               str(python), '-B', str(scripts/'qwen_tts.py'),
               '--model', str(tts/'models'/manifest['revision']),
               '--voice', args.voice, '--personality', args.personality]
    os.chdir(cache)
    os.execve(command[0], command, environment(cache))


if __name__ == '__main__':
    try: main()
    except Exception: sys.exit(1)
