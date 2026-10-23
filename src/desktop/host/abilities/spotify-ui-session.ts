import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AbilityFailure } from '../../../shared/abilities/bridge.js';
import { errorCodeSchema } from '../../../shared/abilities/protocol.js';
import type { SpotifyNode, SpotifySurface } from './spotify-ui.js';
const nodeSchema = z.strictObject({
  id: z.number().int().positive().max(1_000_000),
  parent: z.number().int().min(0),
  role: z.string().max(100),
  label: z.string().max(2048),
  value: z.string().max(2048).optional(),
  url: z.string().max(2048).optional(),
});
const replySchema = z.union([
  z.strictObject({ ok: z.literal(true), ready: z.literal(true) }),
  z.strictObject({ ok: z.literal(true), nodes: z.array(nodeSchema).max(3000) }),
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: errorCodeSchema }),
]);
type Reply = z.infer<typeof replySchema>;
/** A short-lived, app-scoped session; none of its messages cross the worker wire. */
export async function openSpotifySurface(
  helper: string,
  signal: AbortSignal,
): Promise<SpotifySurface & { close(): void }> {
  if (signal.aborted) throw new AbilityFailure('cancelled');
  const child = spawn(helper, ['--ui'], {
    shell: false,
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '',
    closed: AbilityFailure | undefined,
    known = new Map<number, SpotifyNode>();
  let pending:
    | { resolve: (reply: Reply) => void; reject: (e: AbilityFailure) => void }
    | undefined;
  const abort = () => stop(new AbilityFailure('cancelled'));
  const stop = (error: AbilityFailure) => {
    if (closed) return;
    closed = error;
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
    child.kill('SIGKILL');
    const request = pending;
    pending = undefined;
    request?.reject(error);
    known.clear();
    buffer = '';
  };
  const deadline = setTimeout(
    () => stop(new AbilityFailure('timeout')),
    28_000,
  );
  deadline.unref?.();
  const next = () =>
    new Promise<Reply>((resolve, reject) => {
      if (closed) reject(closed);
      else if (pending) reject(new AbilityFailure('busy'));
      else pending = { resolve, reject };
    });
  const ready = next();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (closed) return;
    if (
      Buffer.byteLength(buffer) + Buffer.byteLength(chunk) >
      2 * 1024 * 1024
    ) {
      stop(new AbilityFailure('invalid_response'));
      return;
    }
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const reply = replySchema.parse(JSON.parse(line));
        if (!reply.ok) {
          stop(new AbilityFailure(reply.code));
          return;
        }
        const request = pending;
        if (!request) {
          stop(new AbilityFailure('invalid_response'));
          return;
        }
        pending = undefined;
        request.resolve(reply);
      } catch {
        stop(new AbilityFailure('invalid_response'));
        return;
      }
    }
  });
  // Never include private app metadata or helper diagnostics in logs/errors.
  child.stderr.resume();
  child.on('error', () => stop(new AbilityFailure('setup_needed')));
  child.on('close', () => stop(new AbilityFailure('setup_needed')));
  child.stdin.on('error', () => stop(new AbilityFailure('setup_needed')));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const request = async (input: unknown) => {
    const promise = next();
    if (!closed) child.stdin.write(JSON.stringify(input) + '\n');
    return promise;
  };
  const action = async (
    op: 'press' | 'set' | 'enter' | 'menu',
    node: SpotifyNode,
    value?: string,
  ) => {
    if (known.get(node.id) !== node) throw new AbilityFailure('setup_needed');
    if (
      value !== undefined &&
      (value.length > 200 ||
        [...value].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ))
    )
      throw new AbilityFailure('permission_denied');
    known.clear();
    const reply = await request({
      op,
      id: node.id,
      ...(value !== undefined ? { value } : {}),
    });
    if (!reply.ok || 'ready' in reply || 'nodes' in reply)
      throw new AbilityFailure('invalid_response');
  };
  try {
    const hello = await ready;
    if (!hello.ok || !('ready' in hello))
      throw new AbilityFailure('invalid_response');
    return {
      snapshot: async () => {
        known.clear();
        const reply = await request({ op: 'snapshot' });
        if (!reply.ok || !('nodes' in reply))
          throw new AbilityFailure('invalid_response');
        const nodes = reply.nodes;
        const ids = new Set(nodes.map((n) => n.id));
        if (
          ids.size !== nodes.length ||
          nodes.some((n) => n.parent !== 0 && !ids.has(n.parent))
        )
          throw new AbilityFailure('invalid_response');
        known = new Map(nodes.map((n) => [n.id, n]));
        return nodes;
      },
      menu: (node) => action('menu', node),
      press: (node) => action('press', node),
      set: (node, value) => action('set', node, value),
      enter: (node) => action('enter', node),
      wait: async () => {
        try {
          await delay(150, undefined, { signal });
        } catch {
          throw new AbilityFailure('cancelled');
        }
      },
      close: () => stop(new AbilityFailure('cancelled')),
    };
  } catch (error) {
    stop(
      error instanceof AbilityFailure
        ? error
        : new AbilityFailure('invalid_response'),
    );
    throw closed;
  }
}
