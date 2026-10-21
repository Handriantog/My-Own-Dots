"""Deterministic tests: no installed speech packages, assets or inference required."""

import base64
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
WORKER = HERE / "worker.py"


def load_worker():
    spec = importlib.util.spec_from_file_location("local_voice_worker", WORKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorkerTests(unittest.TestCase):
    def test_recognition_verifies_only_its_pinned_dependencies_without_tts(self):
        lock = json.loads((HERE / "runtime-lock.json").read_text())
        versions = {p["name"]: p["version"] for p in lock["packages"]}
        recognition = {"pywhispercpp", "numpy", "requests", "tqdm", "platformdirs",
                       "charset-normalizer", "idna", "urllib3", "certifi"}
        checked = []
        def version(name):
            checked.append(name)
            if name not in recognition:
                raise self.worker.importlib.metadata.PackageNotFoundError(name)
            return versions[name]
        with patch.object(self.worker.sys, "version_info", (3, 12)), \
                patch.object(self.worker.platform, "system", return_value="Darwin"), \
                patch.object(self.worker.platform, "machine", return_value="arm64"), \
                patch.object(self.worker.importlib.metadata, "version", side_effect=version), \
                patch.object(self.worker, "load_recognition", return_value="recognition"):
            self.assertEqual(self.worker.load_engines({"whisper": "local.bin"}), ("recognition", None))
        self.assertEqual(set(checked), recognition)

    def setUp(self):
        self.assertTrue(WORKER.is_file(), "The bounded local speech worker is missing")
        self.worker = load_worker()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.assets = Path(self.temp.name)
        records = []
        for kind in ("whisper", "kokoro", "voices", "vad"):
            content = kind.encode()
            (self.assets / (kind + ".bin")).write_bytes(content)
            records.append({"id": kind, "filename": kind + ".bin", "downloadBytes": len(content),
                            "sha256": hashlib.sha256(content).hexdigest()})
        self.manifest = {"assets": records}

    def test_verifies_all_assets_before_loading_and_reuses_warm_models(self):
        engine = self.worker.Worker(self.assets)
        with patch.object(self.worker, "read_manifest", return_value=self.manifest), \
                patch.object(self.worker, "load_engines", return_value=(object(), object())) as load:
            self.assertEqual(engine.handle({"id": 1, "method": "warm"}), {"ready": True})
            self.assertEqual(engine.handle({"id": 2, "method": "warm"}), {"ready": True})
            self.assertEqual(load.call_count, 1)
            self.assertEqual(set(load.call_args.args[0]), {"whisper", "kokoro", "voices"})

    def test_rejects_missing_changed_sized_or_symlink_assets_before_import(self):
        for failure in ("missing", "hash", "size", "symlink"):
            with self.subTest(failure=failure):
                path = self.assets / "whisper.bin"
                if path.exists() or path.is_symlink():
                    path.unlink()
                if failure == "hash":
                    path.write_bytes(b"WHISPER")
                elif failure == "size":
                    path.write_bytes(b"x")
                elif failure == "symlink":
                    path.symlink_to(self.assets / "voices.bin")
                with patch.object(self.worker, "read_manifest", return_value=self.manifest), \
                        patch.object(self.worker, "load_engines") as load:
                    with self.assertRaises(self.worker.WorkerError):
                        self.worker.Worker(self.assets).handle({"id": 1, "method": "warm"})
                    load.assert_not_called()

    def test_separate_modes_only_verify_and_load_their_required_assets(self):
        for mode, required, result in [
                ("recognition", {"whisper"}, (object(), None)),
                ("synthesis", {"kokoro", "voices"}, (None, object()))]:
            with self.subTest(mode=mode), \
                    patch.object(self.worker, "read_manifest", return_value=self.manifest), \
                    patch.object(self.worker, "load_engines", return_value=result) as load:
                # An unrelated model may be absent or tampered without affecting
                # this process. Only the selected engine is allowed to load.
                unrelated = self.assets / "vad.bin"
                unrelated.write_bytes(b"invalid")
                engine = self.worker.Worker(self.assets, mode=mode)
                self.assertEqual(engine.handle({"id": 1, "method": "warm"}), {"ready": True})
                self.assertEqual(engine.handle({"id": 2, "method": "warm"}), {"ready": True})
                self.assertEqual(set(load.call_args.args[0]), required)
                self.assertEqual(load.call_count, 1)
                wrong = ({"id": 3, "method": "synthesize", "text": "Hello"}
                         if mode == "recognition" else
                         {"id": 3, "method": "transcribe", "pcm": "AAA=", "language": "en"})
                with self.assertRaisesRegex(self.worker.WorkerError, "mode"):
                    engine.handle(wrong)

    def test_engine_loader_never_initializes_the_other_speech_engine(self):
        for paths, expected in [({"whisper": "whisper"}, ("recognition", None)),
                                ({"kokoro": "kokoro", "voices": "voices"}, (None, "synthesis"))]:
            with self.subTest(paths=paths), patch.object(self.worker, "verify_runtime"), \
                    patch.object(self.worker, "load_recognition", return_value="recognition") as stt, \
                    patch.object(self.worker, "load_synthesis", return_value="synthesis") as tts:
                self.assertEqual(self.worker.load_engines(paths), expected)
                self.assertEqual(stt.call_count, int("whisper" in paths))
                self.assertEqual(tts.call_count, int("kokoro" in paths))

    def test_vad_mode_uses_one_model_and_resets_without_loading_speech_engines(self):
        calls = []
        detector = types.SimpleNamespace(
            detect=lambda pcm: calls.append(pcm) or {"probability": 0.75},
            reset=lambda: calls.append("reset"))
        with patch.object(self.worker, "read_manifest", return_value=self.manifest), \
                patch.object(self.worker, "load_vad", return_value=detector) as load, \
                patch.object(self.worker, "load_engines") as speech:
            engine = self.worker.Worker(self.assets, mode="vad")
            request = {"id": 1, "method": "vad", "pcm": base64.b64encode(bytes(1024)).decode()}
            with self.assertRaisesRegex(self.worker.WorkerError, "warm"):
                engine.handle(request)
            self.assertEqual(engine.handle({"id": 2, "method": "warm"}), {"ready": True})
            self.assertEqual(engine.handle(request), {"probability": 0.75})
            self.assertEqual(engine.handle({"id": 3, "method": "reset"}), {"ready": True})
            self.assertEqual(engine.handle({"id": 4, "method": "warm"}), {"ready": True})
            self.assertEqual(calls, [bytes(1024), "reset"])
            load.assert_called_once_with(str(self.assets.resolve() / "vad.bin"))
            speech.assert_not_called()
            for count in (0, 512, 1023, 1025, 2048):
                request["pcm"] = base64.b64encode(bytes(count)).decode()
                with self.assertRaises(self.worker.WorkerError):
                    engine.handle(request)
            request["pcm"] = "A" * 1366 + "=="  # Noncanonical trailing bits.
            request["pcm"] = request["pcm"][:-3] + "B=="
            with self.assertRaises(self.worker.WorkerError):
                engine.handle(request)
            self.assertEqual(len(calls), 2)

    def test_vad_failure_is_terminal_and_cannot_reuse_stale_state(self):
        def fail(pcm):
            raise RuntimeError("private audio details")
        detector = types.SimpleNamespace(detect=fail, reset=lambda: None)
        with patch.object(self.worker, "read_manifest", return_value=self.manifest), \
                patch.object(self.worker, "load_vad", return_value=detector):
            engine = self.worker.Worker(self.assets, mode="vad")
            engine.handle({"id": 1, "method": "warm"})
            output = io.BytesIO()
            request = {"id": 2, "method": "vad", "pcm": base64.b64encode(bytes(1024)).decode()}
            self.worker.serve(engine, io.BytesIO((json.dumps(request) + "\n").encode()), output)
            self.assertNotIn(b"private", output.getvalue())
            with self.assertRaisesRegex(self.worker.WorkerError, "failed"):
                engine.handle({"id": 3, "method": "reset"})

    def test_vad_preserves_64_sample_context_and_state_until_explicit_reset(self):
        seen = []
        def run(outputs, inputs):
            seen.append(inputs)
            return [Tensor([0.75], (1, 1)), Tensor([1.] * 256, (2, 1, 128))]
        detector = self.worker.SileroEngine(types.SimpleNamespace(run=run), Numpy())
        pcm = struct.pack("<512h", *([16384] * 512))
        self.assertEqual(detector.detect(pcm), {"probability": 0.75})
        detector.detect(pcm)
        detector.reset()
        detector.detect(pcm)
        self.assertEqual(seen[0]["input"].shape, (1, 576))
        self.assertEqual(seen[0]["input"].values, [0.] * 64 + [0.5] * 512)
        self.assertEqual(seen[0]["sr"].values, [16000])
        self.assertEqual(seen[0]["state"].values, [0.] * 256)
        self.assertEqual(seen[1]["state"].values, [1.] * 256)
        self.assertEqual(seen[1]["input"].values, [0.5] * 576)
        self.assertEqual(seen[2]["state"].values, [0.] * 256)
        self.assertEqual(seen[2]["input"].values, [0.] * 64 + [0.5] * 512)

    def test_vad_rejects_invalid_probability_and_next_state(self):
        for probability, state in [
                (Tensor([-0.1], (1, 1)), Tensor([0.] * 256, (2, 1, 128))),
                (Tensor([1.1], (1, 1)), Tensor([0.] * 256, (2, 1, 128))),
                (Tensor([float("nan")], (1, 1)), Tensor([0.] * 256, (2, 1, 128))),
                (Tensor([float("inf")], (1, 1)), Tensor([0.] * 256, (2, 1, 128))),
                (Tensor([0.5], (1,)), Tensor([0.] * 256, (2, 1, 128))),
                (Tensor([0.5], (1, 1)), Tensor([float("nan")] * 256, (2, 1, 128))),
                (Tensor([0.5], (1, 1)), Tensor([0.], (1,)))]:
            session = types.SimpleNamespace(run=lambda _, inputs: [probability, state])
            detector = self.worker.SileroEngine(session, Numpy())
            with self.assertRaises(self.worker.WorkerError):
                detector.detect(bytes(1024))

    def test_invalid_requests_never_load_or_call_engines(self):
        engine = self.worker.Worker(self.assets)
        bad = [None, [], {}, {"id": True, "method": "warm"},
               {"id": 1, "method": "warm", "extra": True},
               {"id": 1, "method": "download"},
               {"id": 1, "method": "transcribe", "pcm": "AA==", "language": "en"},
               {"id": 1, "method": "transcribe", "pcm": "not base64", "language": "en"},
               {"id": 1, "method": "transcribe", "pcm": "AAAA", "language": "de"},
               {"id": 1, "method": "transcribe", "pcm": "A" * 1_280_004, "language": "auto"},
               {"id": 1, "method": "synthesize", "text": " "},
               {"id": 1, "method": "synthesize", "text": "x" * 401}]
        with patch.object(self.worker, "load_engines") as load:
            for request in bad:
                with self.subTest(request=str(request)[:80]), self.assertRaises(self.worker.WorkerError):
                    engine.handle(request)
            load.assert_not_called()
        with self.assertRaisesRegex(self.worker.WorkerError, "warm"):
            engine.handle({"id": 1, "method": "synthesize", "text": "Hello"})

    def test_transcription_returns_detected_language_and_ten_ms_timestamps(self):
        model = types.SimpleNamespace(transcribe=lambda audio, **kwargs: [
            types.SimpleNamespace(t0=2, t1=40, text=" Halo "),
            types.SimpleNamespace(t0=40, t1=90, text=" dunia. ")], _ctx=object())
        bindings = types.SimpleNamespace(whisper_full_lang_id=lambda ctx: 7,
                                         whisper_lang_str=lambda language_id: "id")
        numpy = types.SimpleNamespace(frombuffer=lambda pcm, dtype: FloatInput(pcm), float32="f32")
        engine = self.worker.WhisperEngine(model, numpy, bindings)
        self.assertEqual(engine.transcribe(b"\0\0" * 16000, "auto"), {
            "text": "Halo dunia.", "language": "id", "segments": [
                {"startMs": 20, "endMs": 400, "text": "Halo"},
                {"startMs": 400, "endMs": 900, "text": "dunia."}]})
        engine.bindings = object()
        self.assertEqual(engine.transcribe(b"\0\0" * 16000, "auto")["language"], "und")

    def test_english_context_is_explicit_cleared_between_requests_and_never_rewrites_words(self):
        seen = []
        def transcribe(audio, **kwargs):
            seen.append(kwargs)
            return [types.SimpleNamespace(t0=0, t1=40, text="Best fuel.")]
        numpy = types.SimpleNamespace(frombuffer=lambda pcm, dtype: FloatInput(pcm), float32="f32")
        engine = self.worker.WhisperEngine(types.SimpleNamespace(transcribe=transcribe), numpy, object())
        self.assertEqual(engine.transcribe(b"\0\0" * 16000, "en", "Sapa, mountain views.")["text"], "Best fuel.")
        self.assertIn("Sapa, mountain views.", seen[-1]["initial_prompt"])
        self.assertTrue(seen[-1]["no_context"])
        engine.transcribe(b"\0\0" * 16000, "en")
        self.assertNotIn("Sapa", seen[-1]["initial_prompt"])
        engine.transcribe(b"\0\0" * 16000, "id", "Sapa, mountain views.")
        self.assertEqual(seen[-1]["initial_prompt"], "")

    def test_recognition_context_protocol_is_bounded_before_model_execution(self):
        seen = []
        engine = self.worker.Worker(self.assets, mode="recognition")
        engine.ready = True
        engine.whisper = types.SimpleNamespace(transcribe=lambda *args: seen.append(args) or {"text": "views"})
        request = {"id": 1, "method": "transcribe", "pcm": "AAA=", "language": "en", "context": "Sapa views"}
        self.assertEqual(engine.handle(request), {"text": "views"})
        self.assertEqual(seen[-1][-1], "Sapa views")
        for hint in [None, [], "x" * 601, "bad\x00hint"]:
            with self.subTest(hint=type(hint).__name__), self.assertRaises(self.worker.WorkerError):
                engine.handle({**request, "context": hint})
        with self.assertRaises(self.worker.WorkerError):
            engine.handle({**request, "language": "id"})
        self.assertEqual(len(seen), 1)

    def test_invalid_context_timestamps_retry_same_audio_without_optional_hint(self):
        seen = []
        def transcribe(audio, **kwargs):
            seen.append((audio, kwargs))
            # Observed with the installed base model: a long hint yields the
            # correct words but a 30-second segment for an 800-ms utterance.
            if "mountain views" in kwargs["initial_prompt"]:
                return [types.SimpleNamespace(t0=0, t1=3000, text="suspect first result")]
            return [types.SimpleNamespace(t0=0, t1=84, text="Hello Dot.")]
        numpy = types.SimpleNamespace(frombuffer=lambda pcm, dtype: FloatInput(pcm), float32="f32")
        whisper = self.worker.WhisperEngine(types.SimpleNamespace(transcribe=transcribe), numpy, object())
        engine = self.worker.Worker(self.assets, mode="recognition")
        engine.ready, engine.whisper = True, whisper
        pcm = b"\1\0" * 12800
        request = {"id": 1, "method": "transcribe", "pcm": base64.b64encode(pcm).decode(),
                   "language": "en", "context": "Sapa mountain views"}
        result = engine.handle(request)
        self.assertEqual(result, {"text": "Hello Dot.", "language": "und", "segments": [
            {"startMs": 0, "endMs": 800, "text": "Hello Dot."}], "fallbackReason": "invalid_timestamp"})
        self.assertEqual(len(seen), 2)
        self.assertEqual(seen[0][0].pcm, pcm)
        self.assertEqual(seen[1][0].pcm, pcm)
        self.assertEqual(seen[1][1]["initial_prompt"], "A conversation with an AI assistant named Dot.")
        self.assertTrue(engine.ready)
        self.assertFalse(engine.failed)

    def test_optional_context_fallback_is_once_and_still_rejects_invalid_results(self):
        for context, attempts in [("mountain views", 2), ("", 2)]:
            seen = []
            def transcribe(audio, **kwargs):
                seen.append(kwargs)
                return [types.SimpleNamespace(t0=0, t1=3000, text="suspect text")]
            numpy = types.SimpleNamespace(frombuffer=lambda pcm, dtype: FloatInput(pcm), float32="f32")
            engine = self.worker.WhisperEngine(types.SimpleNamespace(transcribe=transcribe), numpy, object())
            with self.subTest(context=context), self.assertRaises(self.worker.RecognitionInputError):
                engine.transcribe(b"\1\0" * 12800, "en", context)
            self.assertEqual(len(seen), attempts)

    def test_fixed_hint_timestamp_failure_retries_without_any_prompt_and_resets_next_input(self):
        seen = []
        def transcribe(audio, **kwargs):
            seen.append(kwargs)
            if kwargs["initial_prompt"]:
                return [types.SimpleNamespace(t0=0, t1=400, text="suspect timestamp")]
            return [types.SimpleNamespace(t0=0, t1=300, text="My dad is coming home today.")]
        numpy = types.SimpleNamespace(frombuffer=lambda pcm, dtype: FloatInput(pcm), float32="f32")
        engine = self.worker.WhisperEngine(types.SimpleNamespace(transcribe=transcribe), numpy, object())
        pcm = b"\1\0" * 58496  # 3656 ms, matching the quiet-clip rejection in the model probe.
        for _ in range(2):
            result = engine.transcribe(pcm, "en")
            self.assertEqual(result["text"], "My dad is coming home today.")
            self.assertEqual(result["fallbackReason"], "invalid_timestamp")
        self.assertEqual([row["initial_prompt"] for row in seen], [
            "A conversation with an AI assistant named Dot.", "",
            "A conversation with an AI assistant named Dot.", ""])

    def test_optional_context_does_not_retry_a_failed_native_engine(self):
        seen = []
        def transcribe(audio, **kwargs):
            seen.append(kwargs)
            raise self.worker.WorkerError("Whisper native decode failed")
        numpy = types.SimpleNamespace(frombuffer=lambda pcm, dtype: FloatInput(pcm), float32="f32")
        engine = self.worker.WhisperEngine(types.SimpleNamespace(transcribe=transcribe), numpy, object())
        with self.assertRaisesRegex(self.worker.WorkerError, "native decode failed"):
            engine.transcribe(b"\1\0" * 12800, "en", "mountain views")
        self.assertEqual(len(seen), 1)

    def test_transcription_has_no_translation_or_carried_context_and_bounds_segments(self):
        seen = []
        def transcribe(audio, **kwargs):
            seen.append(kwargs)
            return [types.SimpleNamespace(t0=0, t1=200, text="hello")]
        model = types.SimpleNamespace(transcribe=transcribe)
        numpy = types.SimpleNamespace(frombuffer=lambda pcm, dtype: FloatInput(pcm), float32="f32")
        engine = self.worker.WhisperEngine(model, numpy, object())
        with self.assertRaises(self.worker.WorkerError):
            engine.transcribe(b"\0\0" * 16000, "id")
        self.assertEqual(seen[0]["language"], "id")
        self.assertIs(seen[0]["translate"], False)
        self.assertIs(seen[0]["no_context"], True)
        self.assertIs(seen[0]["detect_language"], False)

    def test_short_clip_timestamp_padding_is_clamped_without_changing_text(self):
        model = types.SimpleNamespace(transcribe=lambda audio, **kwargs: [
            types.SimpleNamespace(t0=0, t1=84, text=" Hello. ")])
        numpy = types.SimpleNamespace(frombuffer=lambda pcm, dtype: FloatInput(pcm), float32="f32")
        engine = self.worker.WhisperEngine(model, numpy, object())
        result = engine.transcribe(b"\1\0" * 12800, "en")
        self.assertEqual(result["text"], "Hello.")
        self.assertEqual(result["segments"], [{"startMs": 0, "endMs": 800, "text": "Hello."}])

    def test_invalid_recognition_is_recoverable_and_never_returns_suspect_text(self):
        model = types.SimpleNamespace(transcribe=lambda audio, **kwargs: [
            types.SimpleNamespace(t0=0, t1=1000, text="hallucination")])
        numpy = types.SimpleNamespace(frombuffer=lambda pcm, dtype: FloatInput(pcm), float32="f32")
        whisper = self.worker.WhisperEngine(model, numpy, object())
        engine = self.worker.Worker(self.assets, mode="recognition")
        engine.ready, engine.whisper = True, whisper
        request = {"id": 1, "method": "transcribe", "pcm": base64.b64encode(b"\1\0" * 12800).decode(), "language": "en"}
        output = io.BytesIO()
        self.worker.serve(engine, io.BytesIO((json.dumps(request) + "\n").encode()), output)
        result = json.loads(output.getvalue())
        self.assertEqual(result["code"], "recognition_input")
        self.assertEqual(result["reason"], "invalid_timestamp")
        self.assertNotIn("hallucination", str(result))
        self.assertTrue(engine.ready)
        self.assertFalse(engine.failed)
        model.transcribe = lambda audio, **kwargs: [types.SimpleNamespace(t0=0, t1=40, text="Hello")]
        self.assertEqual(engine.handle(request)["text"], "Hello")

    def test_rejected_hint_retry_reports_both_reasons_without_suspect_text(self):
        def transcribe(audio, **kwargs):
            if "mountains" in kwargs["initial_prompt"]:
                return [types.SimpleNamespace(t0=0, t1=3000, text="PRIVATE")]
            return [types.SimpleNamespace(t0=0, t1=40, text="PRIVATE" * 1000)]
        numpy = types.SimpleNamespace(frombuffer=lambda pcm, dtype: FloatInput(pcm), float32="f32")
        engine = self.worker.Worker(self.assets, mode="recognition")
        engine.ready = True
        engine.whisper = self.worker.WhisperEngine(types.SimpleNamespace(transcribe=transcribe), numpy, object())
        request = {"id": 1, "method": "transcribe", "pcm": base64.b64encode(b"\1\0" * 12800).decode(),
                   "language": "en", "context": "mountains"}
        output = io.BytesIO()
        self.worker.serve(engine, io.BytesIO((json.dumps(request) + "\n").encode()), output)
        result = json.loads(output.getvalue())
        self.assertEqual(result["reason"], "invalid_segment_text")
        self.assertEqual(result["fallbackReason"], "invalid_timestamp")
        self.assertNotIn("PRIVATE", str(result))

    def test_segment_entirely_in_padding_is_not_forwarded(self):
        model = types.SimpleNamespace(transcribe=lambda audio, **kwargs: [
            types.SimpleNamespace(t0=85, t1=90, text="padded text")])
        numpy = types.SimpleNamespace(frombuffer=lambda pcm, dtype: FloatInput(pcm), float32="f32")
        engine = self.worker.WhisperEngine(model, numpy, object())
        with self.assertRaises(self.worker.RecognitionInputError):
            engine.transcribe(b"\1\0" * 12800, "en")

    def test_failed_native_decode_cannot_return_stale_previous_segments(self):
        bindings = types.SimpleNamespace(whisper_full=lambda *args: -7)
        def transcribe(audio, **kwargs):
            # pywhispercpp 1.5.1 does not itself check this native return code.
            bindings.whisper_full(None, None, audio, 16000)
            return [types.SimpleNamespace(t0=0, t1=50, text="stale prior turn")]
        numpy = types.SimpleNamespace(frombuffer=lambda pcm, dtype: FloatInput(pcm), float32="f32")
        engine = self.worker.WhisperEngine(types.SimpleNamespace(transcribe=transcribe), numpy, bindings)
        with self.assertRaisesRegex(self.worker.WorkerError, "decode"):
            engine.transcribe(b"\0\0" * 16000, "auto")

    def test_synthesis_is_bounded_pcm16_mono_24k_and_rejects_invalid_model_output(self):
        model = types.SimpleNamespace(create=lambda text, **kwargs: (Samples([-1., 0., .5, 1.]), 24000))
        engine = self.worker.KokoroEngine(model)
        self.assertEqual(base64.b64decode(engine.synthesize("Hello")["pcm"]),
                         struct.pack("<hhhh", -32768, 0, 16384, 32767))
        for samples, rate in [(Samples([]), 24000), (Samples([float("nan")]), 24000),
                              (Samples([0]), 16000), (Samples([0], ndim=2), 24000),
                              (Samples([0], length=720001), 24000)]:
            model.create = lambda text, samples=samples, rate=rate, **kwargs: (samples, rate)
            with self.assertRaises(self.worker.WorkerError):
                engine.synthesize("Hello")

    def test_selected_voice_and_personality_reach_kokoro_with_matching_english_locale(self):
        calls = []
        def create(text, **kwargs):
            calls.append((text, kwargs))
            return Samples([0., .25]), 24000
        model = types.SimpleNamespace(create=create, get_voices=lambda: ["af_heart", "am_michael", "bm_george"])
        engine = self.worker.Worker(self.assets, mode="synthesis")
        engine.ready, engine.kokoro = True, self.worker.KokoroEngine(model)
        for voice, personality, locale, speed, sentence, clause in [
                ("bm_george", "calm", "en-gb", .94, .32, .14),
                ("am_michael", "cheerful", "en-us", 1.06, .18, .08),
                ("bm_george", "serious", "en-gb", .98, .28, .12),
                ("af_heart", "natural", "en-us", 1., .25, .1)]:
            with self.subTest(voice=voice, personality=personality):
                request = {"id": 1, "method": "synthesize", "text": "Hello.",
                           "voiceId": voice, "personality": personality}
                output = io.BytesIO()
                self.worker.serve(engine, io.BytesIO((json.dumps(request) + "\n").encode()), output)
                response = json.loads(output.getvalue())
                self.assertIn("result", response)
                result = response["result"]
                self.assertEqual(base64.b64decode(result["pcm"]), struct.pack("<hh", 0, 8192))
                self.assertEqual(calls[-1], ("Hello.", {
                    "voice": voice, "speed": speed, "lang": locale,
                    "sentence_pause": sentence, "clause_pause": clause}))

    def test_legacy_synthesis_keeps_heart_and_original_kokoro_defaults(self):
        calls = []
        def create(text, **kwargs):
            calls.append((text, kwargs))
            return Samples([.25]), 24000
        engine = self.worker.Worker(self.assets, mode="synthesis")
        engine.ready, engine.kokoro = True, self.worker.KokoroEngine(types.SimpleNamespace(create=create))
        result = engine.handle({"id": 1, "method": "synthesize", "text": "Hello."})
        self.assertEqual(base64.b64decode(result["pcm"]), struct.pack("<h", 8192))
        self.assertEqual(calls, [("Hello.", {"voice": "af_heart", "speed": 1., "lang": "en-us"})])

    def test_invalid_voice_settings_do_not_infer_or_poison_warm_worker(self):
        calls = []
        def create(text, **kwargs):
            calls.append(kwargs)
            return Samples([.25]), 24000
        model = types.SimpleNamespace(create=create, get_voices=lambda: ["bm_george"])
        engine = self.worker.Worker(self.assets, mode="synthesis")
        engine.ready, engine.kokoro = True, self.worker.KokoroEngine(model)
        valid = {"id": 1, "method": "synthesize", "text": "Hello.",
                 "voiceId": "bm_george", "personality": "natural"}
        bad = [{**valid, "voiceId": voice} for voice in
               ("unknown", "jf_alpha", "af_heart/../../voices", "BM_GEORGE", "", None, [], True)]
        bad += [{**valid, "personality": personality} for personality in
                ("angry", "Natural", "", None, {}, True)]
        bad += [{key: value for key, value in valid.items() if key != missing}
                for missing in ("voiceId", "personality")]
        bad += [{**valid, field: value} for field, value in
                (("speed", 2), ("pitch", 1), ("lang", "ja"), ("voiceSettings", {}),
                 ("sentence_pause", 3), ("emotion", "happy"))]
        for request in bad:
            with self.subTest(request=request):
                before = len(calls)
                output = io.BytesIO()
                self.worker.serve(engine, io.BytesIO((json.dumps(request) + "\n").encode()), output)
                self.assertIn("error", json.loads(output.getvalue()))
                self.assertEqual(len(calls), before)
                self.assertTrue(engine.ready)
                self.assertFalse(engine.failed)
                output = io.BytesIO()
                self.worker.serve(engine, io.BytesIO((json.dumps(valid) + "\n").encode()), output)
                response = json.loads(output.getvalue())
                self.assertIn("result", response)
                self.assertEqual(base64.b64decode(response["result"]["pcm"]), struct.pack("<h", 8192))

    def test_allowlisted_but_unavailable_voice_has_actionable_error_without_fallback(self):
        calls = []
        model = types.SimpleNamespace(
            create=lambda text, **kwargs: calls.append(kwargs) or (Samples([.25]), 24000),
            get_voices=lambda: ["af_heart"])
        engine = self.worker.Worker(self.assets, mode="synthesis")
        engine.ready, engine.kokoro = True, self.worker.KokoroEngine(model)
        output = io.BytesIO()
        request = {"id": 1, "method": "synthesize", "text": "Hello.",
                   "voiceId": "bm_george", "personality": "natural"}
        self.worker.serve(engine, io.BytesIO((json.dumps(request) + "\n").encode()), output)
        response = json.loads(output.getvalue())
        self.assertIn("bm_george", response["error"])
        self.assertIn("unavailable", response["error"])
        self.assertRegex(response["error"], "[Rr]einstall|[Ss]etup")
        self.assertEqual(calls, [])

    def test_protocol_bounds_lines_and_rejects_duplicate_json_keys(self):
        engine = self.worker.Worker(self.assets)
        output = io.BytesIO()
        self.worker.serve(engine, io.BytesIO(b'{"id":1,"id":2,"method":"warm"}\n'), output)
        self.assertIn("error", json.loads(output.getvalue()))
        for payload in (b"x" * 2_000_001, b'{"id":1,"method":"warm"}'):
            output = io.BytesIO()
            self.worker.serve(engine, io.BytesIO(payload), output)
            self.assertLess(len(output.getvalue()), 2000)
            self.assertIn("error", json.loads(output.getvalue()))

    def test_actual_subprocess_boots_without_dependencies_and_reports_missing_assets(self):
        request = b'{"id":1,"method":"warm"}\n'
        for mode in ("both", "recognition", "synthesis", "vad"):
            with self.subTest(mode=mode):
                child = subprocess.run([sys.executable, "-B", str(WORKER), "--assets",
                                        str(self.assets / "missing"), "--mode", mode],
                                       input=request, capture_output=True, timeout=5)
                self.assertEqual(child.returncode, 0, child.stderr.decode())
                response = json.loads(child.stdout)
                self.assertEqual(response["id"], 1)
                self.assertIn("asset", response["error"].lower())
                self.assertNotIn("ModuleNotFoundError", response["error"])

    def test_native_and_python_dependency_logs_cannot_corrupt_jsonl(self):
        code = """
import os, sys
sys.path.insert(0, sys.argv.pop(1))
import worker
worker.read_manifest = lambda: {"assets": []}
worker.verify_assets = lambda path, manifest: {}
def load(paths):
    print("python dependency log", flush=True)
    os.write(1, b"native dependency log\\n")
    return object(), object()
worker.load_engines = load
worker.main()
"""
        child = subprocess.run([sys.executable, "-B", "-c", code, str(HERE),
                                "--assets", str(self.assets)],
                               input=b'{"id":1,"method":"warm"}\n', capture_output=True, timeout=5)
        self.assertEqual(child.returncode, 0, child.stderr.decode())
        self.assertEqual(json.loads(child.stdout), {"id": 1, "result": {"ready": True}})
        self.assertIn(b"python dependency log", child.stderr)
        self.assertIn(b"native dependency log", child.stderr)


class FloatInput:
    def __init__(self, pcm):
        self.pcm = pcm
    def astype(self, dtype):
        return self
    def __truediv__(self, divisor):
        return self


class Tensor:
    """Tiny numeric boundary double; model inference is never invoked."""
    def __init__(self, values, shape=None, dtype="float32"):
        self.values = list(values)
        self.shape = shape if shape is not None else (len(self.values),)
        self.dtype = dtype
    def astype(self, dtype):
        return Tensor(self.values, self.shape, dtype)
    def reshape(self, *shape):
        return Tensor(self.values, shape, self.dtype)
    def __truediv__(self, divisor):
        return Tensor([value / divisor for value in self.values], self.shape, self.dtype)
    def __getitem__(self, key):
        if key == (0, 0):
            return self.values[0]
        return Tensor(self.values[key[1]], (1, len(self.values[key[1]])), self.dtype)
    def copy(self):
        return Tensor(self.values, self.shape, self.dtype)


class Numpy:
    float32 = "float32"
    int64 = "int64"
    @staticmethod
    def zeros(shape, dtype):
        return Tensor([0.] * math.prod(shape), shape, dtype)
    @staticmethod
    def frombuffer(pcm, dtype):
        return Tensor(struct.unpack("<" + "h" * (len(pcm) // 2), pcm))
    @staticmethod
    def array(value, dtype):
        return Tensor([value], (), dtype)
    @staticmethod
    def concatenate(tensors, axis):
        values = [value for tensor in tensors for value in tensor.values]
        return Tensor(values, (1, len(values)))
    @staticmethod
    def isfinite(tensor):
        return types.SimpleNamespace(all=lambda: all(math.isfinite(x) for x in tensor.values))


class Samples(list):
    def __init__(self, samples, ndim=1, length=None):
        super().__init__(samples)
        self.ndim = ndim
        self.length = length
    def __len__(self):
        return super().__len__() if self.length is None else self.length


if __name__ == "__main__":
    unittest.main()
