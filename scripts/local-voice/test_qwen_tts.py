"""Boundary tests use generated numbers only; no model imports or downloads."""
import importlib.util
from pathlib import Path
import unittest
import base64
from array import array

spec = importlib.util.spec_from_file_location('qwen_tts', Path(__file__).with_name('qwen_tts.py'))
engine = importlib.util.module_from_spec(spec)
if Path(spec.origin).exists():
    spec.loader.exec_module(engine)


class QwenTtsTests(unittest.TestCase):
    def test_selected_speaker_and_profile_reject_unknown_or_injected_values(self):
        validate = getattr(engine, 'validate_settings', None)
        self.assertTrue(callable(validate), 'Qwen settings must validate before loading models')
        for voice in ('vivian', 'serena', 'ryan', 'aiden', 'uncle_fu', 'ono_anna', 'sohee', 'dylan', 'eric'):
            validate(voice, 'calm')
        for voice, profile in (('Samantha', 'calm'), ('../../model', 'natural'), ('vivian', 'angry'), ('vivian', None)):
            with self.subTest(voice=voice, profile=profile), self.assertRaises(ValueError):
                validate(voice, profile)

    def test_pcm_rejects_unterminated_and_invalid_audio(self):
        encode = getattr(engine, 'encode_pcm', None)
        self.assertTrue(callable(encode), 'Token-limit exhaustion must not return truncated speech')
        for samples, rate, tokens in (([.1], 24000, 375), ([.1], 22050, 1), ([], 24000, 1),
                                      ([0., 0.], 24000, 1), ([float('nan')], 24000, 1),
                                      ([float('inf')], 24000, 1), ([.1] * 720001, 24000, 1)):
            with self.subTest(rate=rate, tokens=tokens), self.assertRaises(ValueError):
                encode(samples, rate, tokens)
        pcm = base64.b64decode(encode([-.5, 0., .5], 24000, 3), validate=True)
        samples = array('h'); samples.frombytes(pcm)
        self.assertEqual(list(samples), [-16383, 0, 16383])


if __name__ == '__main__':
    unittest.main()
