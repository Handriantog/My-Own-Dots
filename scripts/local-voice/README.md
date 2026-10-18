# Local speech workers

These private subprocesses host multilingual Whisper base, buffered English
Kokoro synthesis, and Silero VAD. They have no microphone, playback, HTTP server, reasoning model,
auto-download, or worker-managed restart. The live call supervisor may replace a failed recognizer once per call. The existing Dot runtime remains the only
reasoning/tool/history path. Live calls use a separate process for each engine,
so cancelling synthesis does not unload recognition or VAD.

## Reviewable setup choice

Metadata was checked on October 18, 2026. The owner subsequently authorized
installation and generated file-audio testing. All pinned assets/wheels were
downloaded and hash/size verified, then wheels were installed without index
access in `~/Library/Application Support/My Own Dots/local-voice/venv`.
The real pipeline and a network-denied speech/cancellation check passed; see
[the measured results](../../docs/desktop/local-voice-prototype.md).
Silero VAD was separately authorized and installed with its size/SHA-256 verified.
Its generated-PCM smoke passed under an OS network-denial sandbox, including
state reset. No microphone, live provider or speaker playback was used. Installation on
another machine and additional real-audio checks still need appropriate consent.

| Item                                            |  Download bytes |               Installed bytes |
| ----------------------------------------------- | --------------: | ----------------------------: |
| Multilingual Whisper base, GGML                 |     147,951,465 |                   147,951,465 |
| Kokoro v1.0 float32 ONNX                        |     325,505,369 |                   325,505,369 |
| Kokoro v1.0 voice archive, selecting `af_heart` |      28,214,398 |                    28,214,398 |
| Silero VAD 6.2.1 ONNX                           |       2,327,524 |                     2,327,524 |
| 21 pinned Python wheels                         |      42,495,033 |                   138,373,676 |
| Total download                                  | **546,493,789** | Models alone: **503,998,756** |

Before the additional 2.33 MB VAD model, the evaluated setup used about 700 MB of allocated disk including retained
wheels, within the approved 3 GB disk limit. The package sizes above sum installed
distribution file lengths; filesystem allocation differs. Cold warmup was 13.2 s
and two file-end-to-PCM results were 1.72/1.20 s with fixture reasoning. Sustained
RAM use, Indonesian recognition quality and listening quality remain unmeasured.
The output voice is an upstream preset, not a proprietary voice
clone. No Indonesian synthesis capability is promised.

The lock targets **Python 3.12, macOS 14+ on arm64**. It reuses an existing Python
interpreter; it does not include or download Python itself. The model manifest
pins exact SHA-256 checksums, byte counts and sources. `runtime-lock.json` records
the selected wheel filenames, sizes, hashes, declared licenses and transitive
dependency metadata; `requirements.txt` enables mandatory hashes and wheels only.
No extras such as microphone packages or GPU distributions are selected.

## Commands after consent

Run from the repository root. Locate an existing Python 3.12 interpreter with
`uv python find --no-python-downloads 3.12` (or `command -v python3.12`) and use
its absolute path for `VOICE_PYTHON` below. The path shown is the evaluated uv
installation; other installations may differ. Use a separate environment so
this prototype does not alter Dots' installed Integrator environment:

```sh
VOICE_ROOT="$HOME/Library/Application Support/My Own Dots/local-voice"
VOICE_PYTHON="$HOME/.local/share/uv/python/cpython-3.12-macos-aarch64-none/bin/python3.12"
mkdir -p "$VOICE_ROOT/assets"
uv venv --no-python-downloads --python "$VOICE_PYTHON" "$VOICE_ROOT/venv"
uv pip install --python "$VOICE_ROOT/venv/bin/python" --require-hashes \
  --only-binary=:all: -r scripts/local-voice/requirements.txt
```

Download only the consented `sourceUrl` entries in `manifest.json`, saving each with
its exact `filename` inside `$VOICE_ROOT/assets`. These URLs are reviewable;
Whisper is pinned to a Hugging Face revision and the Kokoro release artifacts
are content-pinned even if a release tag later moves. Silero is pinned to upstream
commit `7e30209a3e901f9842f81b225f3e93d8199902b1`; its checksum came from the
official PyPI wheel's RECORD metadata and was then verified against the downloaded
file. VAD uses the existing NumPy/ONNX Runtime packages; do not install the
`silero-vad`, Torch or torchaudio packages. The default file prototype only needs
Whisper, Kokoro and voices; live calls additionally require Silero. Download to `.partial`
files, compare both byte count and SHA-256 with the manifest, then rename each
verified file into place. Cancel/failed setup must leave partial files unusable;
the worker rejects partial, missing, wrong-sized, changed and symlinked assets.
Never replace a failed hash with a newly observed checksum without a fresh
inventory review. `curl --fail --location --output FILE.partial URL`,
`wc -c FILE.partial` and `shasum -a 256 FILE.partial` provide explicit progress,
failure and verification without involving a model loader.

Keep the asset directory private to its owner and unchanged while workers use
it. Files are hashed before loading; this process is not a filesystem sandbox
against another local process rewriting a verified file afterward.

This warmup command loads real models and is also permission-gated:

```sh
printf '%s\n' '{"id":1,"method":"warm"}' | \
  "$VOICE_ROOT/venv/bin/python" -B scripts/local-voice/worker.py \
  --assets "$VOICE_ROOT/assets"
```

After both setup and real file-audio verification are authorized, the repository
prototype can use this same worker:

```sh
node --env-file-if-exists=.env --import tsx scripts/local-voice-prototype.mjs \
  --local-speech --python "$VOICE_ROOT/venv/bin/python" --assets "$VOICE_ROOT/assets"
```

That harness uses fixture reasoning, a disposable workspace and generated/file
audio. It is not a real-provider, microphone, playback or physical-latency test.
Refer to the main prototype guide for database prerequisites and artifacts.
After stopping every worker, deleting only the chosen `VOICE_ROOT` directory
removes this dedicated environment/models; no owner conversation data is stored
there. Package-manager cache files may remain separately.

## Protocol and offline boundary

Launch `python -B worker.py --assets ABSOLUTE_DIRECTORY --mode MODE`. Modes are
`recognition`, `synthesis`, `vad`, or `both` (the default for the file prototype).
Each mode verifies and imports only its required model(s); all modes verify the
same pinned runtime package versions. There is no startup
message or model import. Send one request at a time as UTF-8 JSON followed by LF,
at most 2,000,000 bytes including the LF. IDs are non-negative safe integers.
Extra fields and duplicate JSON keys are rejected. Stdout contains only
`{"id":ID,"result":VALUE}` or `{"id":ID,"error":"MESSAGE"}`; malformed
requests without a valid ID return `null` as the error ID. Python and native
dependency logs are redirected to stderr. The parent drains stderr and owns
request deadlines, SIGTERM/SIGKILL, reaping, and rejection of late output.

- `{"id":1,"method":"warm"}` verifies the selected assets and dependency versions before
  loading the models. It returns `{"ready":true}`. Later warm calls reuse them.
- `{"id":2,"method":"transcribe","pcm":"BASE64","language":"auto"}` accepts
  PCM16LE mono 16 kHz, 1–960,000 bytes, in complete two-byte samples. Language is
  `en`, `id` or `auto` for file-prototype compatibility; live calls always pass `en`. There is no resampling, translation or implicit carried STT context. An optional `context` string (up to 600 characters, no control characters, English only) supplies recent conversation vocabulary as part of the explicit `initial_prompt`. Each request replaces the hint; other language modes clear it. Decoder output is never rewritten from the hint. Small timestamp overshoots (at most 200 ms) are clamped to the input duration. Larger segment anomalies return `code: "recognition_input"` without poisoning the warm engine; the call asks the user to repeat.
  Results contain `text`, detected `language` (or `und` if unavailable), and
  `segments` with `startMs`, `endMs`, `text`. Times are converted from Whisper's
  10 ms ticks. Text is bounded to 4,000 characters and 300 segments.
- `{"id":3,"method":"synthesize","text":"Hello."}` accepts 1–400 nonblank
  characters and returns base64 `pcm`: PCM16LE mono 24 kHz, at most 1,440,000
  bytes. It uses `af_heart`, speed 1.0, `en-us`. Audio is fully buffered, checked
  for finite samples/shape/rate/duration, then returned in one JSON response.
- In `vad` mode, `{"id":4,"method":"vad","pcm":"BASE64"}` accepts exactly
  1,024 bytes: 512 PCM16LE mono samples at 16 kHz (32 ms). It returns
  `{"probability":0.5}`, a finite value between zero and one. The adapter preserves
  the model's recurrent state and 64 preceding samples between frames.
- In `vad` mode, `{"id":5,"method":"reset"}` clears recurrent state and context,
  returning `{"ready":true}`. Reset at independent call/generation boundaries;
  do not reset between ordinary consecutive frames. `warm` does not reset state.

Methods for another mode are rejected. Recognition and synthesis have no VAD
dependency. The TypeScript wrapper exposes `detect(pcm, signal)` and
`reset(signal)`; its caller supplies the mode in the launch arguments.

Warmup or inference failure invalidates the worker. Recovery requires a new
session/process. Cancellation kills this worker; there is no cancellation
request on stdin and no auto-reacquisition or restart. Closing the session
releases the models; there is no independent worker idle timer.

Inference uses verified local files and the locked eSpeak library/data; no
language/tokenizer downloads are needed. Whisper's download fallback is disabled,
ONNX telemetry is disabled, offline environment flags are set, and a Python audit
hook rejects socket connection/DNS attempts. Those measures are not an OS-level
network sandbox. A separate check launched this worker under macOS
`sandbox-exec` with `(deny network*)`; recognition, synthesis and cancellation
passed. Upstream eSpeak/tokenizer data and
vocabulary ship inside the pinned wheel, not as separately fetched models.
Installed license/notice file paths and package sizes are recorded in the lock;
exact embedded native source correspondence remains a redistribution gate.

Only speech can operate locally. Normal subscription reasoning still sends its
authorized context to the selected provider and needs that provider's access.
There is no paid speech fallback.

## Deterministic checks

```sh
python3 -B scripts/local-voice/test_worker.py
```

These stdlib tests use tiny temporary fake assets and fake model outputs. They
check hash/size/symlink rejection, warm reuse, malformed/oversized JSONL, bounded
PCM, mode isolation, VAD context/reset/output validation, timestamp/language conversion,
log isolation and the real missing-assets
subprocess path. They do not establish runtime binary/model compatibility.
`npx vitest run tests/local-voice-worker.test.ts` additionally exercises the real
subprocess transport with synthetic engines, including separate-process cancellation.

Primary APIs inspected: [pywhispercpp 1.5.1 source](https://github.com/absadiki/pywhispercpp/blob/v1.5.1/pywhispercpp/model.py)
and [Kokoro source declaring 0.6.1](https://github.com/thewh1teagle/kokoro-onnx/tree/3596b26764286a7de9d90c363e988d50578918e5),
plus the [pinned Silero ONNX wrapper](https://github.com/snakers4/silero-vad/blob/7e30209a3e901f9842f81b225f3e93d8199902b1/src/silero_vad/utils_vad.py).
The Kokoro repository has no 0.6.1 release tag; the wheel itself is pinned by
PyPI version and hash. Basic compatibility passed on the evaluation Mac;
this is not a cross-platform or distribution certification.
