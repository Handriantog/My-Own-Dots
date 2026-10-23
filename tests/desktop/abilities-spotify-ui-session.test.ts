import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
import { openSpotifySurface } from '../../src/desktop/host/abilities/spotify-ui-session.js';
function child() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  spawn.mockReturnValue(child);
  return child;
}
beforeEach(() => {
  spawn.mockReset();
});
describe('private Spotify UI helper transport', () => {
  it('frames split snapshots and sends only validated handles from the current snapshot', async () => {
    const c = child(),
      controller = new AbortController();
    const opening = openSpotifySurface(
      '/bundle/spotify-control',
      controller.signal,
    );
    c.stdout.write('{"ok":true,"ready":true}\n');
    const session = await opening;
    let wire = '';
    c.stdin.on('data', (chunk) => {
      wire += chunk.toString();
    });
    const snapshot = session.snapshot();
    c.stdout.write('{"ok":true,"nodes":[{"id":1,"parent":0,"role":"AXButton",');
    c.stdout.write('"label":"Create"}]}\n');
    const nodes = await snapshot;
    expect(nodes).toEqual([
      { id: 1, parent: 0, role: 'AXButton', label: 'Create' },
    ]);
    const press = session.press(nodes[0]!);
    c.stdout.write('{"ok":true}\n');
    await press;
    expect(wire).toBe('{"op":"snapshot"}\n{"op":"press","id":1}\n');
    expect(spawn.mock.calls[0]).toEqual([
      '/bundle/spotify-control',
      ['--ui'],
      expect.objectContaining({
        shell: false,
        cwd: '/',
        env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      }),
    ]);
    session.close();
    expect(c.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('propagates denied Accessibility without polling or retries', async () => {
    const c = child();
    const opening = openSpotifySurface(
      '/bundle/spotify-control',
      new AbortController().signal,
    );
    c.stdout.write('{"ok":false,"code":"permission_denied"}\n');
    await expect(opening).rejects.toMatchObject({ code: 'permission_denied' });
    expect(c.kill).toHaveBeenCalled();
  });
  it('kills the helper and rejects a pending read on cancellation', async () => {
    const c = child(),
      controller = new AbortController();
    const opening = openSpotifySurface(
      '/bundle/spotify-control',
      controller.signal,
    );
    c.stdout.write('{"ok":true,"ready":true}\n');
    const session = await opening;
    const read = session.snapshot();
    controller.abort();
    await expect(read).rejects.toMatchObject({ code: 'cancelled' });
    expect(c.kill).toHaveBeenCalled();
  });
  it('rejects oversized frames before accumulating arbitrary output', async () => {
    const c = child();
    const opening = openSpotifySurface(
      '/bundle/spotify-control',
      new AbortController().signal,
    );
    c.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));
    await expect(opening).rejects.toMatchObject({ code: 'invalid_response' });
    expect(c.kill).toHaveBeenCalled();
  });
});
it('preserves unicode labels split across pipe chunks', async () => {
  const c = child();
  const opening = openSpotifySurface(
    '/bundle/spotify-control',
    new AbortController().signal,
  );
  c.stdout.write('{"ok":true,"ready":true}\n');
  const session = await opening;
  const reading = session.snapshot(),
    frame = Buffer.from(
      '{"ok":true,"nodes":[{"id":1,"parent":0,"role":"AXButton","label":"音楽"}]}\n',
    );
  const split = frame.indexOf(Buffer.from('音')) + 1;
  c.stdout.write(frame.subarray(0, split));
  c.stdout.write(frame.subarray(split));
  expect((await reading)[0]!.label).toBe('音楽');
  session.close();
});
