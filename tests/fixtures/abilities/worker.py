import json
import os
import sys

for line in sys.stdin:
    value = json.loads(line)
    result = {"apiVersion": 1} if value.get("method") == "initialize" else {
        "status": "success", "value": {"isolated": sys.flags.isolated, "noSite": sys.flags.no_site,
        "injected": os.environ.get("ABILITY_FIXTURE_SECRET"), "cwdInPath": os.getcwd() in sys.path}}
    print(json.dumps({"jsonrpc": "2.0", "id": value["id"], "result": result}), flush=True)
