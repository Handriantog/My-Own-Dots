import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HelperSupervisor,
  type HelperProcess,
} from '../../src/desktop/host/helper.js';
import { snapshot } from './fixtures.js';

function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  }) as unknown as HelperProcess;
}
afterEach(() => vi.useRealTimers());
describe('native helper supervision', () => {
  it('rejects late frames from a retired process and allows the new session', () => {
    vi.useFakeTimers();
    const children: HelperProcess[] = [];
    const scene = vi.fn();
    const supervisor = new HelperSupervisor(
      '/helper',
      { scene, status: vi.fn(), pointer: vi.fn() },
      () => {
        const c = child();
        children.push(c);
        return c;
      },
    );
    supervisor.start();
    children[0].stdout.emit(
      'data',
      Buffer.from(JSON.stringify(snapshot()) + '\n'),
    );
    expect(scene).toHaveBeenCalledTimes(1);
    children[0].emit('exit', 1);
    vi.advanceTimersByTime(500);
    children[0].stdout.emit(
      'data',
      Buffer.from(JSON.stringify(snapshot([], { seq: 2 })) + '\n'),
    );
    children[1].stdout.emit(
      'data',
      Buffer.from(JSON.stringify(snapshot([], { helperSession: 'b' })) + '\n'),
    );
    expect(scene).toHaveBeenCalledTimes(2);
    expect(supervisor.current(performance.now())?.helperSession).toBe('b');
    supervisor.stop();
  });
  it('bounds retries and leaves the caller in limited mode', () => {
    vi.useFakeTimers();
    const children: HelperProcess[] = [];
    const status = vi.fn();
    const supervisor = new HelperSupervisor(
      '/helper',
      { scene: vi.fn(), status, pointer: vi.fn() },
      () => {
        const c = child();
        children.push(c);
        return c;
      },
    );
    supervisor.start();
    for (let i = 0; i < 8; i++) {
      children.at(-1)!.emit('exit', 1);
      vi.advanceTimersByTime(10000);
    }
    expect(children).toHaveLength(6);
    expect(supervisor.current(performance.now())).toBeNull();
    expect(status.mock.calls.some(([s]) => s.includes('Retry'))).toBe(true);
    supervisor.stop();
    vi.advanceTimersByTime(60000);
    expect(children).toHaveLength(6);
  });
  it('terminates oversized output, clears session on stop, and only accepts matching pointer sessions', () => {
    vi.useFakeTimers();
    const c = child(),
      pointer = vi.fn();
    const supervisor = new HelperSupervisor(
      '/helper',
      { scene: vi.fn(), status: vi.fn(), pointer },
      () => c,
    );
    supervisor.start();
    c.stdout.emit('data', Buffer.from(JSON.stringify(snapshot()) + '\n'));
    c.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          kind: 'pointer',
          helperSession: 'old',
          point: { x: 10, y: 20 },
          down: true,
        }) + '\n',
      ),
    );
    expect(pointer).not.toHaveBeenCalled();
    c.stdout.emit('data', Buffer.from('x'.repeat(1_100_000)));
    expect(c.kill).toHaveBeenCalled();
    supervisor.stop();
    expect(supervisor.current(performance.now())).toBeNull();
  });
});
