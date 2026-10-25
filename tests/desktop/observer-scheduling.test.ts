import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')(
  'keeps native pointer, command and scene work responsive during slow AX reads',
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dots-observer-scheduling-'));
    try {
      // Compile production scheduling/cache code, but never instantiate DesktopObserver.
      // No Accessibility, screen, event, or cursor APIs run in this fixture.
      const source = readFileSync(
        'native/desktop-observer/main.swift',
        'utf8',
      ).split('// Geometry-only adapter.')[0];
      writeFileSync(
        path.join(dir, 'main.swift'),
        source +
          String.raw`
let work = AsyncObservation<Int>()
let started = DispatchSemaphore(value: 0)
let release = DispatchSemaphore(value: 0)
var received: [Int] = [], commandHandled = false, samples = 0, scenes = 0
precondition(work.request({
    precondition(!Thread.isMainThread)
    started.signal()
    release.wait()
    return 1
}, completion: { value in
    precondition(Thread.isMainThread)
    received.append(value)
}))
precondition(started.wait(timeout: .now() + 2) == .success)
let pointer = Timer(timeInterval: 1.0 / 120, repeats: true) { _ in samples += 1 }
let scene = Timer(timeInterval: 0.1, repeats: true) { _ in scenes += 1 }
RunLoop.main.add(pointer, forMode: .common)
RunLoop.main.add(scene, forMode: .common)
DispatchQueue.main.async { commandHandled = true }
RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.65))
precondition(commandHandled && samples > 10 && scenes >= 3)
precondition(received.isEmpty && work.busy)
for _ in 0..<100 {
    precondition(!work.request({ 2 }, completion: { received.append($0) }))
}
release.signal()
let limit = Date(timeIntervalSinceNow: 2)
while received.isEmpty && Date() < limit { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.01)) }
precondition(received == [1] && !work.busy)
precondition(work.request({ 3 }, completion: { received.append($0) }))
while received.count < 2 && Date() < limit { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.01)) }
precondition(received == [1, 3])
pointer.invalidate(); scene.invalidate()
let screens = [AccessibilityScreen(id: "a", bounds: CGRect(x: 0, y: 0, width: 100, height: 100))]
let dock = DockObservation(surfaces: [["id": "dock"]], observedAtMs: 1000, screens: screens, revision: 7)
precondition(dock.current(now: 1100, screens: screens, revision: 7).count == 1)
precondition(dock.current(now: 1501, screens: screens, revision: 7).isEmpty)
precondition(dock.current(now: 1100, screens: [], revision: 7).isEmpty)
precondition(dock.current(now: 1100, screens: screens, revision: 8).isEmpty)
print("slow AX stayed isolated; coalescing and stale Dock guards passed; OS/cursor effects=0")
`,
      );
      execFileSync(
        'swiftc',
        [path.join(dir, 'main.swift'), '-o', path.join(dir, 'probe')],
        { timeout: 60000, stdio: 'pipe' },
      );
      expect(
        execFileSync(path.join(dir, 'probe'), [], {
          timeout: 5000,
          encoding: 'utf8',
        }),
      ).toContain(
        'slow AX stayed isolated; coalescing and stale Dock guards passed; OS/cursor effects=0',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  65000,
);
