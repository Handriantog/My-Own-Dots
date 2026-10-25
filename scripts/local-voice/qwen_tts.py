"""Pinned offline Qwen3 speech. No recognition, task tools or audio devices."""
from array import array
import base64
import contextlib
import json
import math
from pathlib import Path
import sys

SPEAKERS = frozenset(('vivian', 'serena', 'ryan', 'aiden', 'uncle_fu', 'ono_anna', 'sohee', 'dylan', 'eric'))
PROFILES = {
    'natural': 'Speak naturally and clearly in a friendly conversational tone.',
    'cheerful': 'Speak clearly with a warm, cheerful conversational tone. Do not sing.',
    'calm': 'Speak calmly and gently, with a steady conversational pace.',
    'serious': 'Speak clearly in a measured, professional tone.',
}
MAX_TOKENS = 375


def validate_settings(voice, personality):
    if type(voice) is not str or voice not in SPEAKERS or type(personality) is not str or personality not in PROFILES:
        raise ValueError('Select a supported High voice and personality')


def encode_pcm(samples, rate, tokens):
    # The pinned decoder returns audio even at its token cap. Such audio may be
    # truncated: only a normal EOS, strictly before the cap, is admissible.
    if rate != 24000 or type(tokens) is not int or not 0 < tokens < MAX_TOKENS or not 0 < len(samples) <= 720000:
        raise ValueError('Incomplete or invalid Qwen speech')
    pcm = array('h')
    for value in samples:
        value = float(value)
        if not math.isfinite(value):
            raise ValueError('Invalid Qwen speech samples')
        pcm.append(int(max(-1., min(1., value)) * 32767))
    if not any(pcm):
        raise ValueError('Silent Qwen speech')
    if sys.byteorder != 'little':
        pcm.byteswap()
    return base64.b64encode(pcm.tobytes()).decode('ascii')


class QwenTtsRuntime:
    def __init__(self, model_dir, voice, personality):
        validate_settings(voice, personality)
        from native_worker import verify_assets
        manifest = json.loads(Path(__file__).with_name('qwen3-tts-model.json').read_text())['tts']
        model_dir = Path(model_dir)
        verify_assets(model_dir, manifest['files'])
        # Only the allowlisted local architecture/data can be loaded. Model code,
        # remote tokenizers and model-supplied templates are never executed.
        with contextlib.redirect_stdout(sys.stderr):
            from mlx_audio.tts.utils import load_model
            self.model = load_model(model_dir, strict=True)
        if set(self.model.get_supported_speakers()) != SPEAKERS or self.model.sample_rate != 24000:
            raise ValueError('Unexpected Qwen voice model')
        self.voice, self.personality = voice, personality

    def speak(self, text):
        from native_worker import plain
        if not plain(text, 400):
            raise ValueError('Invalid speech text')
        with contextlib.redirect_stdout(sys.stderr):
            results = list(self.model.generate_custom_voice(
                text=text, speaker=self.voice, language='English',
                instruct=PROFILES[self.personality], max_tokens=MAX_TOKENS,
                verbose=False,
            ))
        if len(results) != 1 or results[0].audio.ndim != 1:
            raise ValueError('Invalid Qwen speech result')
        result = results[0]
        return {'text': text, 'pcm': encode_pcm(result.audio.tolist(), result.sample_rate, result.token_count)}


if __name__ == '__main__':
    import argparse
    from native_worker import serve
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--voice', required=True)
    parser.add_argument('--personality', required=True)
    args = parser.parse_args()
    try:
        serve(sys.stdin.buffer, sys.stdout, lambda: QwenTtsRuntime(args.model, args.voice, args.personality))
    except Exception:
        sys.exit(1)
