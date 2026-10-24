import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { setTimeout, setInterval } from 'node:timers';
const send = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const pending = new Map();
const capability = (params) =>
  new Promise((resolve) => {
    pending.set('cap', resolve);
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'cap',
        method: 'capability',
        params,
      }) + '\n',
    );
  });
createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (pending.has(message.id)) {
    pending.get(message.id)(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'initialize') {
    send(message.id, { apiVersion: 1 });
    return;
  }
  if (message.method !== 'invoke') return;
  appendFileSync('started', String(process.pid) + '\n');
  const op = message.params.arguments.op;
  if (op === 'writing') {
    setInterval(() => appendFileSync('writes', 'state\n'), 10);
    return;
  }
  if (op === 'hold') {
    setInterval(() => {}, 1000);
    return;
  }
  if (op.startsWith('activity-')) {
    const action =
      op === 'activity-stop'
        ? 'stop'
        : op === 'activity-status'
          ? 'status'
          : 'start';
    const reply = await capability({
      kind: 'companion-activity',
      ruleId: 'motion',
      command: { action, activityId: 'orbit' },
    });
    if (op === 'activity-hold') return;
    send(
      message.id,
      op === 'activity-invalid'
        ? { status: 'invalid' }
        : !reply.ok
          ? { status: 'error', code: reply.code }
          : op === 'activity-fail'
            ? { status: 'error', code: 'cancelled' }
            : {
                status: 'success',
                owner: { kind: 'text', text: reply.status },
              },
    );
    return;
  }
  const owner = { kind: 'text', text: 'OWNER_ONLY_SENTINEL' };
  if (op === 'raw-error') {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: 'provider_error', message: 'OWNER_ONLY_SENTINEL' },
      }) + '\n',
    );
    return;
  }
  if (op === 'stderr') process.stderr.write('OWNER_ONLY_SENTINEL\n');
  if (op === 'late') {
    process.on('SIGTERM', () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (op === 'selection') {
    send(message.id, {
      status: 'selection_needed',
      owner: {
        kind: 'list',
        title: 'OWNER_ONLY_SENTINEL',
        items: [
          {
            label: 'OWNER_ONLY_SENTINEL',
            action: { target: 'OWNER_ONLY_SENTINEL' },
          },
        ],
      },
    });
    return;
  }
  if (op === 'selected') {
    send(message.id, {
      status: 'success',
      owner: {
        kind: 'text',
        text: message.params.selection?.target ?? 'missing',
      },
    });
    return;
  }
  if (op === 'account' || op === 'identity') {
    const reply = await capability({
      kind: 'account',
      accountId: 'account',
      ...(op === 'identity' ? { dotId: 'other-dot' } : {}),
    });
    send(message.id, {
      status: 'success',
      owner: { kind: 'text', text: JSON.stringify(reply) },
    });
    return;
  }
  if (op === 'http') {
    const reply = await capability({
      kind: 'https',
      ruleId: 'search',
      pathValues: {},
      query: { q: 'fixture', limit: 5 },
    });
    send(message.id, {
      status: 'success',
      owner: { kind: 'text', text: reply.ok ? reply.body : reply.code },
    });
    return;
  }
  if (op === 'model') {
    send(message.id, { status: 'success', value: 42 });
    return;
  }
  if (op === 'model-invalid') {
    send(message.id, { status: 'success', value: 'OWNER_ONLY_SENTINEL' });
    return;
  }
  if (op === 'model-oversize') {
    send(message.id, { status: 'success', value: 'X'.repeat(1024 * 1024 + 1) });
    return;
  }
  send(message.id, {
    status: op === 'partial' ? 'uncertain' : 'success',
    owner,
  });
});
