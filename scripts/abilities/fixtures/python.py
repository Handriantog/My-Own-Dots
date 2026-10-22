"""First-party, disposable sandbox probes; no external services or real data."""
import json
import os
import signal
import socket
import sys

op, *args = sys.argv[1:]
result, error = -1, 0
try:
    if op == "race":
        result = 0
        for _ in range(5000):
            try:
                with open(args[0], "r+b") as file:
                    result += file.write(b"x")
            except OSError:
                pass
    elif op == "read":
        with open(args[0], "rb") as file:
            result = len(file.read(1))
    elif op == "write":
        with open(args[0], "wb") as file:
            result = file.write(b"x")
    elif op == "hardlink":
        os.link(args[0], args[1])
        result = 0
    elif op in ("network", "unix"):
        with socket.socket(socket.AF_INET if op == "network" else socket.AF_UNIX) as connection:
            connection.connect(("127.0.0.1", int(args[0])) if op == "network" else args[0])
            result = 0
    elif op == "fork":
        child = os.fork()
        if child == 0:
            os._exit(0)
        os.waitpid(child, 0)
        result = child
    elif op == "signal":
        os.kill(int(args[0]), signal.SIGUSR1)
        result = 0
    elif op == "fd":
        result = len(os.read(int(args[0]), 1))
    elif op == "env":
        result = int(any(key in os.environ for key in ("ABILITY_TEST_SECRET", "NODE_OPTIONS", "PYTHONPATH")))
    elif op == "linger":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        print(json.dumps({"pid": os.getpid()}), flush=True)
        while True:
            signal.pause()
    else:
        raise ValueError("unknown probe")
except OSError as failure:
    error = failure.errno
print(json.dumps({"result": result, "errno": error, "pid": os.getpid()}), flush=True)
