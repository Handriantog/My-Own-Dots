# Speech prototype license inventory

Silero VAD 6.2.1 adds one optional ONNX artifact at upstream commit
`7e30209a3e901f9842f81b225f3e93d8199902b1`, under the
[upstream MIT license](https://github.com/snakers4/silero-vad/blob/7e30209a3e901f9842f81b225f3e93d8199902b1/LICENSE).
The corresponding notice is preserved in [silero-vad.LICENSE](silero-vad.LICENSE).
The adapter follows the pinned upstream recurrent-state/context contract using
the already inventoried NumPy and ONNX Runtime packages. The `silero-vad`, Torch
and torchaudio runtime packages are not installed or bundled. The SHA-256 was
obtained from the official PyPI wheel's RECORD metadata before download and
verified against the owner-consented official GitHub artifact afterward.

This is an artifact inventory, **not a cleared redistributable bundle**. Following
owner consent, all pinned wheels/models were downloaded and verified, the runtime
was installed, and installed package/license-file sizes and paths were recorded
in `runtime-lock.json`. Exact embedded native-library source versions and the
complete notices/source bundle still need review before packaging or redistribution. Keep separate
code, model, preset and phonemizer obligations; the combined application must not
be labeled wholly permissive or wholly MIT.

| Component                                                       | Declared license / source                                                                                                                                                                                                                                     | Current limit                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pywhispercpp==1.5.1`                                           | [MIT](https://github.com/absadiki/pywhispercpp/blob/v1.5.1/LICENSE)                                                                                                                                                                                           | Wheel hash is pinned; its embedded whisper.cpp revision/native notices have not been inspected.                                                                                                                                                    |
| whisper.cpp                                                     | [MIT](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE)                                                                                                                                                                                            | Exact bundled native revision remains a wheel inspection item.                                                                                                                                                                                     |
| Whisper model                                                   | [MIT upstream](https://github.com/openai/whisper/blob/main/LICENSE), [converted GGML model card](https://huggingface.co/ggerganov/whisper.cpp/blob/5359861c739e955e79d9a303bcbc70fb988958b1/README.md)                                                        | Exact converted artifact is checksum/revision pinned; conversion environment not reproduced.                                                                                                                                                       |
| `kokoro-onnx==0.6.1`                                            | [MIT runtime](https://github.com/thewh1teagle/kokoro-onnx/blob/3596b26764286a7de9d90c363e988d50578918e5/LICENSE)                                                                                                                                              | PyPI wheel pinned independently; no version release tag exists in this repository.                                                                                                                                                                 |
| Kokoro-82M v1.0 ONNX + voice archive                            | [Apache-2.0 model-card declaration](https://huggingface.co/hexgrad/Kokoro-82M/blob/f3ff3571791e39611d31c381e3a41a3af07b4987/README.md), [voice provenance](https://huggingface.co/hexgrad/Kokoro-82M/blob/f3ff3571791e39611d31c381e3a41a3af07b4987/VOICES.md) | Converted ONNX/archive pinned by release checksum. Check actual archive, attribution and preset provenance before shipping; selected preset is `af_heart`. No separate LICENSE file appears in this model repository's metadata.                   |
| `phonemizer==3.4.0`                                             | [GPL-3.0-or-later metadata](https://pypi.org/pypi/phonemizer/3.4.0/json), [source license](https://github.com/bootphon/phonemizer/blob/master/LICENSE)                                                                                                        | Required by this chosen Kokoro path; do not omit it from distribution review.                                                                                                                                                                      |
| `espeakng-loader==0.2.4` Python loader                          | [MIT loader source](https://github.com/thewh1teagle/espeakng-loader/blob/0ddc87adf77e5850d7eeb542ac8a87d421b64daa/LICENSE)                                                                                                                                    | The loader's license does not relicense the embedded eSpeak library/data.                                                                                                                                                                          |
| eSpeak NG native library/pronunciation data in the loader wheel | [GPL-3.0-or-later project](https://github.com/espeak-ng/espeak-ng/blob/master/COPYING)                                                                                                                                                                        | Repository snapshot points at eSpeak commit `4870adfa25b1a32b4361592f1be8a40337c58d6c`; correspondence to the selected wheel has not been established. Preserve source/notice obligations and inspect bundled data licenses before redistribution. |

The exact transitive package inventory is `runtime-lock.json`, with metadata URLs
and each selected wheel checksum. The current declarations are:

| Packages                                                              | Declared licenses                                  |
| --------------------------------------------------------------------- | -------------------------------------------------- |
| attrs, charset-normalizer, dlinfo, onnxruntime, platformdirs, urllib3 | MIT                                                |
| cloudpickle, idna, joblib, protobuf                                   | BSD-3-Clause                                       |
| flatbuffers, requests                                                 | Apache-2.0                                         |
| packaging                                                             | Apache-2.0 OR BSD-2-Clause                         |
| numpy                                                                 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| certifi                                                               | MPL-2.0                                            |
| tqdm                                                                  | MPL-2.0 AND MIT                                    |
| typing-extensions                                                     | PSF-2.0                                            |

These declarations are not a complete inventory of native dependencies inside
wheels. Installed package sizes and notice paths have been measured; full native
notice coverage, eSpeak native source correspondence, and required
source-distribution materials remain unresolved. This prototype makes no distribution
license conclusion. Dots' MIT license and installed Integrator's AGPL-3.0-only
license are separate application-level facts already documented in the main
voice brief.
