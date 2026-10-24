import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')(
  'compiles native pointer parsing and freshness guards with all OS effects replaced',
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dots-pointer-guards-'));
    try {
      // The production observer is never instantiated. No screen, event, AX or warp APIs run.
      const source = readFileSync(
        'native/desktop-observer/main.swift',
        'utf8',
      ).split('let observer = DesktopObserver()')[0];
      writeFileSync(
        path.join(dir, 'main.swift'),
        source +
          String.raw`
var now = 1000.0, revision = 7.0, down = false, trusted = true, warps = 0
let pointer = ActivityPointerSession(session: "fixture", sample: {
    NativePointerSample(point: CGPoint(x: -20, y: 40), down: down, revision: revision, sampledAtMs: now, idleMs: 5000)
}, allowed: { trusted }, bounds: { [CGRect(x: -1000, y: -300, width: 1000, height: 800)] }, warp: { _ in warps += 1; return true })
func command(_ op: String, _ generation: Int = 1, _ extras: [String: Any] = [:]) -> [String: Any] {
    var data: [String: Any] = ["kind":"activity", "op":op, "generation":generation, "requestId":1, "helperSession":"fixture"]
    for (key,value) in extras { data[key]=value }
    return data
}
func accepted(_ data: [String: Any]) -> Bool {
    let json = try! JSONSerialization.data(withJSONObject: data)
    return pointer.command(String(data:json,encoding:.utf8)!)?["ok"] as? Bool ?? false
}
let move: [String:Any] = ["x":-50.0,"y":30.0,"revision":7.0,"sampledAtMs":1000.0]
precondition(accepted(command("begin")))
precondition(accepted(command("move",1,move)) && warps == 1)
revision = 8
precondition(!accepted(command("move",1,move)) && warps == 1) // physical drag after JS sampling
revision = 7; down = true
precondition(!accepted(command("move",1,move)) && warps == 1)
down = false; now = 1300
precondition(!accepted(command("move",1,move)) && warps == 1) // pipe backlog expired
now = 999
precondition(!accepted(command("move",1,move))) // future timestamp
now = 1000
precondition(!accepted(command("move",1,move.merging(["x":1.0]) { _,b in b }))) // outside actual display
precondition(!accepted(command("move",1,move.merging(["y":500.0]) { _,b in b })))
precondition(!accepted(command("move",1,move.merging(["revision":true]) { _,b in b })))
precondition(!accepted(command("begin",2,["extra":true])))
precondition(!accepted(command("begin",2,["helperSession":"old"])))
precondition(accepted(command("end")))
precondition(!accepted(command("move",1,move)))
precondition(!accepted(command("begin",1))) // cannot resurrect a retired generation
precondition(accepted(command("begin",2)))
precondition(accepted(command("end",1))) // stale cleanup cannot stop replacement
precondition(accepted(command("move",2,move)) && warps == 2)
trusted = false
precondition(!accepted(command("move",2,move)))
trusted = true
pointer.invalidate()
precondition(!accepted(command("move",2,move)))
precondition(pointer.command(String(repeating:"x", count:2049)) == nil)
func text(_ value: [String: Any]) -> String { String(data:try! JSONSerialization.data(withJSONObject:value),encoding:.utf8)! }
precondition(accepted(command("begin",3)))
precondition(pointer.submit(text(command("move",3,move))).isEmpty)
precondition(warps == 2) // receiving a move only buffers it
let retired = pointer.submit(text(command("end",3)))
precondition(retired.contains { $0["ok"] as? Bool == true })
precondition(pointer.flush().isEmpty && warps == 2) // stop before execution cancels buffered move
precondition(accepted(command("begin",4)))
_ = pointer.submit(text(command("move",4,move)))
precondition(pointer.flush().first?["ok"] as? Bool == true && warps == 3)
_ = pointer.submit(text(command("end",4)))
precondition(warps == 3) // already-executed movement cannot be undone retroactively
print("buffered cancellation probes passed; fake warp count=3")
`,
      );
      execFileSync(
        'swiftc',
        [path.join(dir, 'main.swift'), '-o', path.join(dir, 'probe')],
        { timeout: 60000, stdio: 'pipe' },
      );
      const output = execFileSync(path.join(dir, 'probe'), [], {
        timeout: 5000,
        encoding: 'utf8',
      });
      expect(output).toContain(
        'buffered cancellation probes passed; fake warp count=3',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  65000,
);
