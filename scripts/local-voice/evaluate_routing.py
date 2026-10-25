"""Explicit offline router evaluation. No audio, provider, tools, or task execution."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import native_worker as worker


def cases_from(path):
    worker.require(path.stat().st_size <= 2_000_000)
    cases = json.loads(path.read_text())
    worker.require(type(cases) is list and 0 < len(cases) <= 200)
    identities = set()
    for case in cases:
        worker.require(type(case) is dict and worker.plain(case.get("id"), 100))
        worker.require(case["id"] not in identities)
        identities.add(case["id"])
        worker.require(worker.plain(case.get("utterance")))
        worker.require(case.get("route") in ("chat", "clarify", "clock", "status", "delegate"))
        worker.validate_history(case.get("history", []))
        worker.require(case.get("taskStatus", "none") in (
            "none", "queued", "running", "approval", "completed", "failed", "cancelled", "interrupted"))
    return cases


def evaluate(runtime_root, cases):
    # Match the production Qwen loader, without loading LFM or any audio engine.
    manifest = json.loads((SCRIPTS / "native-models.json").read_text())["router"]
    model = runtime_root / "models" / manifest["revision"]
    worker.verify_assets(model, manifest["files"])
    import mlx.core as mx
    from transformers import AutoTokenizer
    from mlx_audio.lm.models import qwen3
    from mlx_audio.lm.generate import generate_step
    from mlx_audio.utils import apply_quantization, load_weights

    engine = object.__new__(worker.LfmRuntime)
    engine.mx = mx
    engine.generate_step = generate_step
    engine.router_tokenizer = AutoTokenizer.from_pretrained(
        str(model), trust_remote_code=False, local_files_only=True)
    config = json.loads((model / "config.json").read_text())
    engine.router = qwen3.Model(qwen3.ModelArgs.from_dict(config))
    weights = load_weights(model)
    apply_quantization(engine.router, config, weights)
    engine.router.load_weights(list(engine.router.sanitize(weights).items()))
    mx.eval(engine.router.parameters())
    for case in cases:
        started = time.monotonic()
        actual = engine.route(case["utterance"], case.get("history", []), case.get("taskStatus", "none"))
        print(json.dumps({**case, "actual": actual, "pass": actual == case["route"],
                          "seconds": round(time.monotonic() - started, 3)}), flush=True)
        mx.clear_cache()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--fixtures", type=Path,
                        default=SCRIPTS.parents[1] / "tests/fixtures/native-voice-routing.json")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    runtime = args.runtime_root.resolve(strict=True)
    cases = cases_from(args.fixtures.resolve(strict=True))
    if args.worker:
        evaluate(runtime, cases)
        return 0
    if sys.platform != "darwin" or args.output_dir is None:
        parser.error("Use macOS and supply a new --output-dir.")
    from native_launcher import environment, sandbox_profile
    import setup_native

    # Verify the already-installed, pinned wheel contents before importing them.
    # This path never installs packages or downloads missing files.
    runtime = setup_native.validate_root(runtime)
    wheels, _ = setup_native.load_manifests()
    receipt = json.loads((runtime / "native-ready.json").read_text())
    setup_native.verify_ready(runtime, wheels, receipt["python"])
    output = args.output_dir.resolve()
    output.mkdir()  # Do not overwrite another evaluation.
    code = output / "code"
    code.mkdir()
    for filename in ("native_worker.py", "native-models.json", "evaluate_routing.py"):
        shutil.copyfile(SCRIPTS / filename, code / filename)
    fixtures = output / "cases.json"
    fixtures.write_text(json.dumps(cases, indent=2) + "\n")
    cache = output / "cache"
    for name in ("tmp", "module-cache", "huggingface"):
        (cache / name).mkdir(parents=True)
    command = [
        "/usr/bin/sandbox-exec", "-p", sandbox_profile(runtime, output, cache),
        str(runtime / "venv/bin/python"), "-I", "-B", str(code / "evaluate_routing.py"),
        "--worker", "--runtime-root", str(runtime), "--fixtures", str(fixtures),
    ]
    result = subprocess.run(command, cwd=cache, env=environment(cache),
                            text=True, capture_output=True, timeout=300)
    (output / "stdout.jsonl").write_text(result.stdout)
    (output / "stderr.log").write_text(result.stderr)
    result.check_returncode()
    rows = [json.loads(line) for line in result.stdout.splitlines() if line]
    passed = len(rows) == len(cases) and all(row["pass"] for row in rows)
    (output / "report.json").write_text(json.dumps({
        "microphone": False, "playback": False, "provider": False, "tasks": False,
        "model": json.loads((SCRIPTS / "native-models.json").read_text())["router"],
        "results": rows, "pass": passed,
    }, indent=2) + "\n")
    print(f"{sum(row['pass'] for row in rows)}/{len(cases)} routing cases passed. Report: {output / 'report.json'}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
