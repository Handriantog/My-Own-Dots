"""Independent author fixture using only Python's standard library."""
import json
from pathlib import Path
import sys

for line in sys.stdin:
    message = json.loads(line)
    if message.get("method") == "initialize":
        result = {"apiVersion": 1}
    elif message.get("method") == "invoke":
        Path("verified").write_text("python")
        result = {"status": "success", "value": 42}
    else:
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
