#!/usr/bin/env python3
"""One warm, local-only speech process. Stdout is reserved for bounded JSONL.

No model imports at startup. The supervisor owns deadlines and cancellation by
terminating/reaping this process; there is no background queue or auto-restart.
"""

import argparse
from array import array
import base64
import binascii
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import stat
import sys
import unicodedata

HERE = Path(__file__).resolve().parent
MAX_LINE = 2_000_000
MAX_INPUT_PCM = 960_000
MAX_OUTPUT_SAMPLES = 720_000
MAX_TEXT = 400
DEFAULT_VOICE = "af_heart"
ENGLISH_VOICES = frozenset({
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
    "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
})
VOICE_PERSONALITIES = {
    "natural": {"speed": 1.0, "sentence_pause": .25, "clause_pause": .1},
    "cheerful": {"speed": 1.06, "sentence_pause": .18, "clause_pause": .08},
    "calm": {"speed": .94, "sentence_pause": .32, "clause_pause": .14},
    "serious": {"speed": .98, "sentence_pause": .28, "clause_pause": .12},
}
MODE_ASSETS = {"both": {"whisper", "kokoro", "voices"}, "recognition": {"whisper"},
               "synthesis": {"kokoro", "voices"}, "vad": {"vad"}}


class WorkerError(Exception):
    """An actionable error safe to return without transcript/audio content."""


class RecognitionInputError(WorkerError):
    """An unusable utterance, not a failed engine; the next input may proceed."""

    def __init__(self, message, reason="unknown"):
        super().__init__(message)
        self.reason = reason
        self.fallback_reason = None


def read_manifest():
    return json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))


def verify_assets(asset_dir, manifest, required=None):
    required = MODE_ASSETS["both"] if required is None else required
    if not asset_dir.is_absolute():
        raise WorkerError("Asset directory must be absolute")
    if not asset_dir.is_dir():
        raise WorkerError("Local speech assets are missing; complete consented setup first")
    root = asset_dir.resolve(strict=True)
    verified = {}
    for item in manifest["assets"]:
        if item["id"] not in required:
            continue
        if item["id"] in verified:
            raise WorkerError("Duplicate bundled asset manifest entry")
        name = item["filename"]
        if Path(name).name != name or name in (".", ".."):
            raise WorkerError("Invalid bundled asset manifest")
        path = root / name
        try:
            # Refuse symlinks, directories and devices. Hash in bounded chunks.
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as source:
                before = os.fstat(source.fileno())
                if not stat.S_ISREG(before.st_mode) or before.st_size != item["downloadBytes"]:
                    raise WorkerError(f"Local asset size mismatch: {name}")
                digest = hashlib.file_digest(source, "sha256").hexdigest()
                after = os.fstat(source.fileno())
                if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                        after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                    raise WorkerError(f"Local asset changed during verification: {name}")
                if digest != item["sha256"]:
                    raise WorkerError(f"Local asset checksum mismatch: {name}")
        except OSError as error:
            raise WorkerError(f"Local asset missing or unreadable: {name}") from error
        verified[item["id"]] = str(path)
    if set(verified) != required:
        raise WorkerError("Incomplete bundled asset manifest")
    return verified


def deny_download(*args, **kwargs):
    raise WorkerError("Automatic speech-model downloads are disabled")


def verify_runtime(modes=None):
    if sys.version_info[:2] != (3, 12):
        raise WorkerError("Local speech runtime requires Python 3.12")
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise WorkerError("Pinned speech runtime requires macOS arm64")
    lock = json.loads((HERE / "runtime-lock.json").read_text(encoding="utf-8"))
    required = None if modes is None else set().union(*(lock["modes"][mode] for mode in modes))
    if required is not None and not required.issubset({p["name"] for p in lock["packages"]}):
        raise WorkerError("Incomplete pinned runtime dependency group")
    for package in lock["packages"]:
        if required is not None and package["name"] not in required:
            continue
        try:
            installed = importlib.metadata.version(package["name"])
        except importlib.metadata.PackageNotFoundError as error:
            raise WorkerError(f"Missing pinned speech dependency: {package['name']}") from error
        if installed != package["version"]:
            raise WorkerError(f"Speech dependency version mismatch: {package['name']}")


def load_engines(paths):
    verify_runtime([mode for key, mode in (("whisper", "recognition"), ("kokoro", "synthesis")) if key in paths])
    # Each process imports only its selected engine after local assets hash.
    whisper = load_recognition(paths["whisper"]) if "whisper" in paths else None
    kokoro = load_synthesis(paths) if "kokoro" in paths else None
    return whisper, kokoro


def load_recognition(path):
    import numpy as np
    import _pywhispercpp as whisper_bindings
    import pywhispercpp.utils as whisper_utils
    from pywhispercpp.model import Model

    whisper_utils.download_model = deny_download
    model = Model(path, n_threads=4, no_context=True, translate=False,
                  print_progress=False, print_realtime=False, print_timestamps=False,
                  redirect_whispercpp_logs_to=sys.stderr)
    return WhisperEngine(model, np, whisper_bindings)


def load_synthesis(paths):
    import ctypes
    import espeakng_loader
    import onnxruntime as ort
    from kokoro_onnx import Kokoro
    from kokoro_onnx.config import EspeakConfig

    ort.disable_telemetry_events()
    # Pin CPU execution rather than inheriting optional/system-wide providers.
    os.environ["ONNX_PROVIDER"] = "CPUExecutionProvider"
    # Never let an ambient library override silently select a different eSpeak.
    os.environ.pop("PHONEMIZER_ESPEAK_LIBRARY", None)
    library = espeakng_loader.get_library_path()
    data = espeakng_loader.get_data_path()
    if not Path(library).is_file() or not Path(data).is_dir():
        raise WorkerError("Bundled eSpeak library or pronunciation data is missing")
    ctypes.CDLL(library)  # Fail before Kokoro's system-library fallback is reached.
    kokoro = Kokoro(paths["kokoro"], paths["voices"],
                    espeak_config=EspeakConfig(lib_path=library, data_path=data))
    if DEFAULT_VOICE not in kokoro.get_voices():
        raise WorkerError("Pinned English voice af_heart is unavailable; reinstall the local voice assets")
    return KokoroEngine(kokoro)


def load_vad(path):
    verify_runtime(["vad"])
    import numpy as np
    import onnxruntime as ort

    ort.disable_telemetry_events()
    options = ort.SessionOptions()
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = 1
    session = ort.InferenceSession(path, providers=["CPUExecutionProvider"], sess_options=options)
    return SileroEngine(session, np)


class SileroEngine:
    """Silero 6.2.1's 16 kHz ONNX state/context contract, without torch."""

    def __init__(self, session, numpy):
        self.session, self.numpy = session, numpy
        self.reset()

    def reset(self):
        self.state = self.numpy.zeros((2, 1, 128), dtype=self.numpy.float32)
        self.context = self.numpy.zeros((1, 64), dtype=self.numpy.float32)

    def detect(self, pcm):
        if len(pcm) != 1024:
            raise WorkerError("VAD requires exactly 512 PCM16 samples")
        np = self.numpy
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32).reshape(1, 512) / 32768.0
        window = np.concatenate((self.context, samples), axis=1)
        probability, state = self.session.run(None, {
            "input": window, "state": self.state, "sr": np.array(16000, dtype=np.int64)})
        if (getattr(probability, "shape", None) != (1, 1)
                or getattr(state, "shape", None) != (2, 1, 128)
                or getattr(state, "dtype", None) != np.float32
                or not np.isfinite(state).all()):
            raise WorkerError("VAD returned invalid probability or state")
        value = float(probability[0, 0])
        if not math.isfinite(value) or not 0 <= value <= 1:
            raise WorkerError("VAD returned invalid probability")
        self.state = state
        self.context = samples[:, -64:].copy()
        return {"probability": value}


class WhisperEngine:
    def __init__(self, model, numpy, bindings):
        self.model, self.numpy, self.bindings = model, numpy, bindings
        native_decode = getattr(bindings, "whisper_full", None)
        if callable(native_decode):
            # pywhispercpp 1.5.1 ignores whisper_full's status before reading
            # context segments. One process owns one model, so fail at that
            # binding boundary before any stale context can become a result.
            def checked_decode(*args, **kwargs):
                status = native_decode(*args, **kwargs)
                if status != 0:
                    raise WorkerError("Whisper native decode failed")
                return status
            bindings.whisper_full = checked_decode

    def transcribe(self, pcm, language, context=""):
        try:
            return self._transcribe(pcm, language, context)
        except RecognitionInputError as first:
            if language != "en":
                raise
            # Long prompts can make the pinned decoder place otherwise valid
            # short-clip words at the end of its 30-second padded window. Retry
            # this uncommitted audio once with only the known Dot-name hint.
            # If that fixed hint was already in use, retry with no prompt: it
            # also corrects a reproducible quiet-clip timestamp overshoot.
            # Validate the fresh result normally; never clamp/forward the first
            # suspect result or retry an engine failure here.
            try:
                result = self._transcribe(pcm, language, use_prompt=bool(context))
            except RecognitionInputError as second:
                second.fallback_reason = first.reason
                raise
            result["fallbackReason"] = first.reason
            return result

    def _transcribe(self, pcm, language, context="", use_prompt=True):
        samples = self.numpy.frombuffer(pcm, dtype="<i2").astype(self.numpy.float32) / 32768.0
        # A short transcription context helps distinguish the assistant's name
        # from similar words. Keep the decoder's actual words (including "dad")
        # and never carry implicit decoder state. The host may supply bounded
        # recent conversation prose as vocabulary, not a correction to output.
        # Overrides persist in pywhispercpp; clear hints on every other mode.
        prompt = "A conversation with an AI assistant named Dot." if language == "en" and use_prompt else ""
        if language == "en" and use_prompt and context:
            prompt += " " + context
        raw = self.model.transcribe(samples, language="" if language == "auto" else language,
                                    translate=False, no_context=True, detect_language=False,
                                    initial_prompt=prompt,
                                    print_progress=False, print_realtime=False, print_timestamps=False)
        if len(raw) > 300:
            raise RecognitionInputError("Recognition returned too many segments", "segment_limit")
        segments = []
        duration_ms = math.ceil(len(pcm) / 32)
        for segment in raw:
            start, end = segment.t0 * 10, segment.t1 * 10
            if (not isinstance(start, (int, float)) or not isinstance(end, (int, float))
                    or not math.isfinite(start) or not math.isfinite(end)
                    or not 0 <= start < duration_ms
                    or not start <= end <= duration_ms + 200):
                raise RecognitionInputError("Recognition returned an invalid timestamp", "invalid_timestamp")
            if not isinstance(segment.text, str) or len(segment.text) > 4000:
                raise RecognitionInputError("Recognition returned invalid segment text", "invalid_segment_text")
            # whisper.cpp timestamps can extend into its padded final frame:
            # the pinned runtime returns 840 ms for an 800 ms English fixture.
            # Permit a small bounded margin, never expose time outside input,
            # and reject larger anomalies rather than forwarding suspect text.
            segments.append({"startMs": min(start, duration_ms),
                             "endMs": min(end, duration_ms), "text": segment.text.strip()})
        text = " ".join(segment["text"] for segment in segments).strip()
        if len(text) > 4000:
            raise RecognitionInputError("Recognition text exceeds limit", "text_limit")
        detected = "und"
        get_id = getattr(self.bindings, "whisper_full_lang_id", None)
        get_name = getattr(self.bindings, "whisper_lang_str", None)
        context = getattr(self.model, "_ctx", None)
        if callable(get_id) and callable(get_name) and context is not None:
            name = get_name(get_id(context))
            if isinstance(name, bytes):
                name = name.decode("ascii", errors="strict")
            if isinstance(name, str) and 2 <= len(name) <= 16:
                detected = name
        return {"text": text, "language": detected, "segments": segments}


def validate_voice_settings(voice_id, personality):
    if not isinstance(voice_id, str) or voice_id not in ENGLISH_VOICES:
        raise WorkerError("Select a supported English voice")
    if not isinstance(personality, str) or personality not in VOICE_PERSONALITIES:
        raise WorkerError("Select a supported voice personality")


class KokoroEngine:
    def __init__(self, model):
        self.model = model

    def synthesize(self, text, voice_id=None, personality=None):
        # Deliberately buffered. No first-audio/streaming claim is made here.
        options = {"voice": DEFAULT_VOICE, "speed": 1.0, "lang": "en-us"}
        if voice_id is not None or personality is not None:
            validate_voice_settings(voice_id, personality)
            if voice_id not in self.model.get_voices():
                raise WorkerError(f"Selected English voice {voice_id} is unavailable; "
                                  "reinstall the local voice assets")
            # These profiles use Kokoro's supported pacing controls, not an
            # emotion instruction or a pitch transformation of generated audio.
            options = {"voice": voice_id, "lang": "en-gb" if voice_id.startswith("b") else "en-us",
                       **VOICE_PERSONALITIES[personality]}
        samples, rate = self.model.create(text, **options)
        if (rate != 24000 or getattr(samples, "ndim", None) != 1
                or not 0 < len(samples) <= MAX_OUTPUT_SAMPLES):
            raise WorkerError("Synthesis returned an invalid sample rate, shape or duration")
        output = array("h")
        for sample in samples:
            value = float(sample)
            if not math.isfinite(value):
                raise WorkerError("Synthesis returned non-finite audio")
            output.append(max(-32768, min(32767, round(value * 32768))))
        if sys.byteorder != "little":
            output.byteswap()
        return {"pcm": base64.b64encode(output.tobytes()).decode("ascii")}


def valid_id(value):
    return type(value) is int and 0 <= value <= 9_007_199_254_740_991


class Worker:
    def __init__(self, asset_dir, mode="both"):
        if mode not in MODE_ASSETS:
            raise WorkerError("Invalid speech worker mode")
        self.mode = mode
        self.asset_dir = Path(asset_dir)
        self.whisper = self.kokoro = self.vad = None
        self.ready = False
        self.failed = False

    def handle(self, request):
        if not isinstance(request, dict) or not valid_id(request.get("id")):
            raise WorkerError("Invalid request id")
        method = request.get("method")
        fields = {"warm": {"id", "method"}, "transcribe": {"id", "method", "pcm", "language"},
                  "synthesize": {"id", "method", "text"}, "vad": {"id", "method", "pcm"},
                  "reset": {"id", "method"}}
        selected_voice = method == "synthesize" and ("voiceId" in request or "personality" in request)
        if selected_voice:
            fields["synthesize"] |= {"voiceId", "personality"}
        if method == "transcribe" and "context" in request:
            fields["transcribe"].add("context")
        if not isinstance(method, str) or method not in fields or set(request) != fields[method]:
            raise WorkerError("Invalid request method or fields")
        if self.failed:
            raise WorkerError("Speech worker failed; start a new session")
        allowed = {"both": {"warm", "transcribe", "synthesize"},
                   "recognition": {"warm", "transcribe"}, "synthesis": {"warm", "synthesize"},
                   "vad": {"warm", "vad", "reset"}}
        if method not in allowed[self.mode]:
            raise WorkerError("Request is not available in this worker mode")
        if method in ("transcribe", "vad"):
            encoded = request["pcm"]
            limit = 1024 if method == "vad" else MAX_INPUT_PCM
            if method == "transcribe":
                language = request["language"]
                if language not in ("en", "id", "auto"):
                    raise WorkerError("Invalid input language")
                context = request.get("context", "")
                if (not isinstance(context, str) or len(context) > 600
                        or any(unicodedata.category(char) in ("Cc", "Cf", "Cs") for char in context)
                        or (language != "en" and context)):
                    raise WorkerError("Invalid recognition context")
            if (not isinstance(encoded, str)
                    or not 0 < len(encoded) <= ((limit + 2) // 3) * 4):
                raise WorkerError("Invalid input PCM or language")
            try:
                pcm = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as error:
                raise WorkerError("Invalid base64 PCM") from error
            if (not pcm or len(pcm) % 2 or len(pcm) > limit
                    or (method == "vad" and len(pcm) != 1024)
                    or base64.b64encode(pcm).decode("ascii") != encoded):
                raise WorkerError("Invalid PCM16 input length or encoding")
        if method == "synthesize":
            text = request["text"]
            if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
                raise WorkerError("Speech text must contain 1 to 400 characters")
            if selected_voice:
                validate_voice_settings(request["voiceId"], request["personality"])
        if method != "warm" and not self.ready:
            raise WorkerError("Speech worker must warm before inference")
        try:
            if method == "warm":
                if not self.ready:
                    if self.mode == "both":
                        paths = verify_assets(self.asset_dir, read_manifest())
                    else:
                        paths = verify_assets(self.asset_dir, read_manifest(), MODE_ASSETS[self.mode])
                    if self.mode == "vad":
                        self.vad = load_vad(paths["vad"])
                    else:
                        self.whisper, self.kokoro = load_engines(paths)
                    self.ready = True
                return {"ready": True}
            if method == "reset":
                self.vad.reset()
                return {"ready": True}
            if method == "vad":
                return self.vad.detect(pcm)
            if method == "transcribe":
                if "context" in request:
                    return self.whisper.transcribe(pcm, language, context)
                return self.whisper.transcribe(pcm, language)
            if selected_voice:
                return self.kokoro.synthesize(text, request["voiceId"], request["personality"])
            return self.kokoro.synthesize(text)
        except RecognitionInputError:
            raise
        except Exception:
            self.failed = True
            self.whisper = self.kokoro = self.vad = None
            self.ready = False
            raise


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise WorkerError("Duplicate JSON field")
        result[key] = value
    return result


def serve(worker, source, output):
    while True:
        line = source.readline(MAX_LINE + 1)
        if not line:
            return
        request_id = None
        fatal = len(line) > MAX_LINE or not line.endswith(b"\n")
        try:
            if fatal:
                raise WorkerError("Worker request line is too large or incomplete")
            request = json.loads(line.decode("utf-8"), object_pairs_hook=unique_object,
                                 parse_constant=lambda value: (_ for _ in ()).throw(
                                     WorkerError("Invalid JSON number")))
            if isinstance(request, dict) and valid_id(request.get("id")):
                request_id = request["id"]
            response = {"id": request_id, "result": worker.handle(request)}
        except RecognitionInputError as error:
            response = {"id": request_id, "error": str(error), "code": "recognition_input", "reason": error.reason}
            if error.fallback_reason:
                response["fallbackReason"] = error.fallback_reason
        except (WorkerError, UnicodeError, json.JSONDecodeError) as error:
            message = str(error) if isinstance(error, WorkerError) else "Malformed JSON request"
            response = {"id": request_id, "error": message}
        except Exception as error:
            # Do not expose exception strings, which can include text or audio.
            response = {"id": request_id, "error": f"Speech engine failed ({type(error).__name__})"}
        encoded = (json.dumps(response, ensure_ascii=True, separators=(",", ":"), allow_nan=False) + "\n").encode()
        if len(encoded) > MAX_LINE:
            encoded = (json.dumps({"id": request_id, "error": "Worker response exceeds limit"}) + "\n").encode()
            fatal = True
        output.write(encoded)
        output.flush()
        if fatal:
            return


def deny_network(event, args):
    # Defense against Python dependency download fallbacks, not an OS sandbox.
    if event in ("socket.connect", "socket.getaddrinfo"):
        raise WorkerError("Network access is disabled in the speech worker")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--mode", choices=tuple(MODE_ASSETS), default="both")
    args = parser.parse_args()
    if not args.assets.is_absolute():
        parser.error("--assets must be an absolute directory")
    # Native printf and Python prints both go to stderr; protocol owns a dup of
    # original stdout. Keep it open for the full process lifetime.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    sys.stdout.flush()
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.addaudithook(deny_network)
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1")
    try:
        serve(Worker(args.assets, args.mode), sys.stdin.buffer, protocol)
    except BrokenPipeError:
        pass
    finally:
        protocol.close()


if __name__ == "__main__":
    main()
