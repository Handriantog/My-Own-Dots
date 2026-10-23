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

describe('bounded native activity transport', () => {
  function fixture() {
    const c = child(),
      physical = vi.fn(),
      status = vi.fn(),
      commands: Record<string, unknown>[] = [];
    c.stdin.on('data', (chunk) => {
      for (const line of String(chunk).trim().split('\n'))
        if (line.startsWith('{')) commands.push(JSON.parse(line));
    });
    const helper = new HelperSupervisor(
      '/helper',
      { scene: () => {}, status, pointer: () => {}, physical },
      () => c,
    );
    helper.start();
    c.stdout.emit('data', Buffer.from(JSON.stringify(snapshot()) + '\n'));
    const reply = (value: unknown) =>
      c.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
    const sample = {
      point: { x: 30, y: 40 },
      down: false,
      revision: 8,
      sampledAtMs: 2000,
      idleMs: 6000,
    };
    return { c, helper, commands, reply, sample, physical, status };
  }
  it('does not finish stop until native retirement is acknowledged', async () => {
    const f = fixture();
    const beginning = f.helper.begin(1);
    const begin = f.commands.at(-1)!;
    f.reply({
      kind: 'activity-ack',
      helperSession: 'a',
      generation: 1,
      requestId: begin.requestId,
      ok: true,
      physical: f.sample,
    });
    await beginning;
    const moving = f.helper.move(1, { x: 20, y: 20 }, f.sample);
    const rejected = expect(moving).rejects.toThrow(/stopped/);
    let stopped = false;
    const stopping = Promise.resolve(f.helper.end(1)).then(() => {
      stopped = true;
    });
    await rejected;
    await Promise.resolve();
    expect(stopped).toBe(false);
    const end = f.commands.at(-1)!;
    expect(end.op).toBe('end');
    f.reply({
      kind: 'activity-ack',
      helperSession: 'a',
      generation: 1,
      requestId: end.requestId,
      ok: true,
    });
    await stopping;
    expect(stopped).toBe(true);
    f.helper.stop();
  });
  it('waits for confirmed process exit if retirement acknowledgement times out', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const beginning = f.helper.begin(1);
    const begin = f.commands.at(-1)!;
    f.reply({
      kind: 'activity-ack',
      helperSession: 'a',
      generation: 1,
      requestId: begin.requestId,
      ok: true,
      physical: f.sample,
    });
    await beginning;
    let stopped = false;
    const stopping = f.helper.end(1).then(() => {
      stopped = true;
    });
    const result = expect(stopping).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(260);
    expect(f.c.kill).toHaveBeenCalledWith('SIGKILL');
    expect(stopped).toBe(false);
    f.c.emit('exit', 0);
    await result;
    expect(stopped).toBe(true);
    f.helper.stop();
  });
  it('reuses confirmed retirement when old cleanup races a newer pending start', async () => {
    const f = fixture();
    const beginning = f.helper.begin(1);
    let command = f.commands.at(-1)!;
    f.reply({
      kind: 'activity-ack',
      helperSession: 'a',
      generation: 1,
      requestId: command.requestId,
      ok: true,
      physical: f.sample,
    });
    await beginning;
    const ended = f.helper.end(1);
    command = f.commands.at(-1)!;
    f.reply({
      kind: 'activity-ack',
      helperSession: 'a',
      generation: 1,
      requestId: command.requestId,
      ok: true,
    });
    await ended;
    const replacement = f.helper.begin(2);
    command = f.commands.at(-1)!;
    const cleanup = f.helper.end(1);
    await Promise.resolve();
    expect(f.c.kill).not.toHaveBeenCalled();
    f.reply({
      kind: 'activity-ack',
      helperSession: 'a',
      generation: 2,
      requestId: command.requestId,
      ok: true,
      physical: f.sample,
    });
    await cleanup;
    expect(await replacement).toEqual(f.sample);
    f.helper.stop();
  });
  it('correlates acknowledgements and passes native freshness through unchanged', async () => {
    const f = fixture();
    const begin = f.helper.begin(1),
      cmd = f.commands.at(-1)!;
    f.reply({
      kind: 'activity-ack',
      helperSession: 'wrong',
      requestId: cmd.requestId,
      ok: true,
      physical: f.sample,
    });
    f.reply({
      kind: 'activity-ack',
      helperSession: 'a',
      requestId: cmd.requestId,
      generation: 1,
      ok: true,
      physical: f.sample,
    });
    expect(await begin).toEqual(f.sample);
    const move = f.helper.move(1, { x: -50, y: 25 }, f.sample);
    const m = f.commands.at(-1)!;
    expect(m).toMatchObject({
      kind: 'activity',
      op: 'move',
      generation: 1,
      revision: 8,
      sampledAtMs: 2000,
      x: -50,
      y: 25,
    });
    f.reply({
      kind: 'activity-ack',
      helperSession: 'a',
      requestId: m.requestId,
      generation: 1,
      ok: false,
    });
    expect(await move).toBe(false);
    f.helper.stop();
  });
  it('bounds moves, invalidates pending generations and rejects late replies', async () => {
    const f = fixture();
    const begin = f.helper.begin(1);
    const cmd = f.commands.at(-1)!;
    f.reply({
      kind: 'activity-ack',
      helperSession: 'a',
      requestId: cmd.requestId,
      generation: 1,
      ok: true,
      physical: f.sample,
    });
    await begin;
    const move = f.helper.move(1, { x: 20, y: 20 }, f.sample);
    const rejected = expect(move).rejects.toThrow(/stopped/);
    await expect(f.helper.move(1, { x: 21, y: 20 }, f.sample)).rejects.toThrow(
      /pending/,
    );
    f.helper.end(1);
    await rejected;
    await expect(f.helper.move(1, { x: 22, y: 20 }, f.sample)).rejects.toThrow(
      /inactive/,
    );
    f.helper.stop();
  });
  it('times out and terminates the helper so no queued move can execute later', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const begin = f.helper.begin(1);
    const rejected = expect(begin).rejects.toThrow(/timeout/);
    vi.advanceTimersByTime(300);
    await rejected;
    expect(f.c.kill).toHaveBeenCalled();
    expect(f.helper.current(performance.now())).toBeNull();
    f.helper.stop();
  });
  it('rejects malformed physical samples and releases requests on process loss', async () => {
    const f = fixture();
    const begin = f.helper.begin(1);
    const rejected = expect(begin).rejects.toThrow(/lost/);
    f.reply({
      kind: 'activity-input',
      helperSession: 'a',
      generation: 1,
      physical: { ...f.sample, revision: -1 },
    });
    expect(f.physical).not.toHaveBeenCalled();
    f.c.emit('exit', 1);
    await rejected;
    f.helper.stop();
  });
});
