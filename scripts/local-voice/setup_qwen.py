"""Explicit, data-only Qwen3 speech setup using reviewed native setup helpers."""
import argparse
import json
from pathlib import Path
import re
import sys
# Also support the documented isolated interpreter invocation (-I -S).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from setup_native import (ensure_artifact, local_path, relative_path, require,
                          setup_lock, validate_artifact, validate_root, verify_artifact, verify_inventory)


def load_manifest(path=None):
    manifest = json.loads(Path(path or Path(__file__).with_name('qwen3-tts-model.json')).read_text())
    require(set(manifest) == {'version', 'tts'} and manifest['version'] == 1, 'Invalid speech manifest')
    model = manifest['tts']
    require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', model['repository'])
            and re.fullmatch(r'[a-f0-9]{40}', model['revision']), 'Speech model must be pinned')
    paths = set()
    for item in model['files']:
        validate_artifact(item)
        path = relative_path(item['path'])
        require(path.suffix in ('.json', '.safetensors') or str(path) == 'merges.txt', 'Only speech model data is allowed')
        require(str(path).casefold() not in paths, 'Duplicate speech model file')
        paths.add(str(path).casefold())
    require(0 < sum(item['bytes'] for item in model['files']) <= 3_200_000_000, 'Speech model byte bound exceeded')
    return model


def prepare_model(runtime, model, source=None, offline=False, verify_only=False):
    expected = {model['revision']+'/'+item['path'] for item in model['files']}
    verify_inventory(runtime/'models', expected, allow_missing=not verify_only)
    for item in model['files']:
        relative = 'models/'+model['revision']+'/'+item['path']
        if verify_only:
            verify_artifact(local_path(runtime, relative), item)
        else:
            ensure_artifact(runtime, relative,
                            {**item, 'url':'https://huggingface.co/'+model['repository']+'/resolve/'+model['revision']+'/'+item['path']},
                            source=source/model['revision']/item['path'] if source else None, offline=offline)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tts-root', type=Path, default=Path.home()/'Library/Application Support/My Own Dots/qwen3-tts')
    parser.add_argument('--model-source', type=Path)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    model = load_manifest()
    runtime = validate_root(args.tts_root, create=not args.verify_only)
    require(all(p.name in ('models', 'cache', '.setup.lock') and not p.is_symlink() for p in runtime.iterdir()),
            'Choose a dedicated speech model directory')
    with setup_lock(runtime):
        if not args.verify_only:
            local_path(runtime, 'cache/tmp', parents=True).mkdir(exist_ok=True)
        prepare_model(runtime, model, args.model_source, args.offline, args.verify_only)
    print('Qwen3-TTS model verified at '+str(runtime)+'. The existing native Python runtime is also required.')


if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
