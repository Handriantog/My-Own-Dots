"""Seal three independently authored fixtures without importing the host."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile

source = Path(__file__).resolve().parent
out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True)
subprocess.run(["/usr/bin/xcrun", "clang", "-Wall", "-Wextra", "-Werror", "-O2", str(source / "native.c"), "-o", str(out / "native")], check=True)
empty = {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
artifacts = []
for runtime, filename in [("javascript", "node.mjs"), ("python", "python.py"), ("native", "native")]:
    manifest = {
        "formatVersion": 1, "apiVersion": 1, "id": "fixture-" + runtime,
        "name": "Sealed fixture", "description": "Disposable packaging check.",
        "publisher": "Dot tests", "source": {"owner": "example", "repository": "abilities"},
        "version": "0.1.0", "license": "MIT", "platforms": ["darwin-arm64"],
        "entrypoint": {"runtime": runtime, "path": filename}, "helpers": [],
        "settings": empty, "permissions": [],
        "tools": [{"id": "run", "description": "Verify private state and runtime.", "input": empty,
                   "output": {"type": "integer", "minimum": 42, "maximum": 42}, "visibility": "model-visible"}],
    }
    files = {"ability.json": json.dumps(manifest, separators=(",", ":")).encode(), filename: (out / filename if runtime == "native" else source / filename).read_bytes()}
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, data in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.mode = 0o755 if name == "native" else 0o644
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    data = gzip.compress(raw.getvalue(), mtime=0)
    artifact = out / (runtime + ".tar.gz")
    artifact.write_bytes(data)
    descriptor = {"formatVersion": 1, "manifest": manifest, "sourceCommit": "a" * 40,
                  "releaseTag": "fixture/v0.1.0", "asset": {"id": 1, "name": artifact.name,
                  "sha256": hashlib.sha256(data).hexdigest(), "compressedBytes": len(data),
                  "extractedBytes": sum(map(len, files.values())), "fileCount": len(files)}}
    artifact.with_suffix(".json").write_text(json.dumps(descriptor))
    artifacts.append(str(artifact))
print(json.dumps(artifacts))
