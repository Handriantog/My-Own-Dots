#!/usr/bin/env node
// First-party, network-free fixture for the installed execution adapter.
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { log as output } from 'node:console';

if (process.argv.includes('--version')) {
  output('codex-cli 0.163.0');
  process.exit(0);
}
const logPath = join(dirname(fileURLToPath(import.meta.url)), 'requests.jsonl');
const log = (value) => appendFileSync(logPath, JSON.stringify(value) + '\n');
const send = (value) => output(JSON.stringify(value));
const config = {
  model_reasoning_effort: 'xhigh',
  mcp_servers: { inherited: { enabled: true } },
};
for (let index = 0; index < process.argv.length; index++) {
  if (process.argv[index] !== '-c') continue;
  const setting = process.argv[++index];
  const equal = setting.indexOf('=');
  const keys = setting.slice(0, equal).split('.');
  const value = JSON.parse(
    setting.slice(equal + 1).replace(/("(?:[^"\\]|\\.)*")=/g, '$1:'),
  );
  let target = config;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = value;
}
log({ spawn: process.pid, effectiveEffort: config.model_reasoning_effort });
let threads = 0;
let thread;
let turn;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!message.method) continue;
  const { method, params = {} } = message;
  log({ pid: process.pid, method, params });
  if (message.id === undefined) continue;
  const reply = (result) => send({ id: message.id, result });
  if (method === 'initialize') reply({ userAgent: 'fixture' });
  else if (method === 'account/read') reply({ account: { type: 'chatgpt' } });
  else if (method === 'configRequirements/read') reply({ requirements: null });
  else if (method === 'config/read') reply({ config, layers: [] });
  else if (method === 'thread/start') {
    thread = `thread-${process.pid}-${++threads}`;
    reply({
      thread: { id: thread },
      activePermissionProfile: { id: 'dots_execution' },
    });
  } else if (method === 'thread/unsubscribe') reply({ status: 'unsubscribed' });
  else if (method === 'turn/start') {
    turn = `turn-${threads}`;
    reply({ turn: { id: turn } });
    const input = JSON.parse(params.input[0].text);
    if (input.caption === 'STALL') continue;
    send({
      method: 'item/completed',
      params: {
        threadId: thread,
        turnId: turn,
        item: {
          type: 'agentMessage',
          id: `decision-${threads}`,
          phase:
            input.caption === 'COMMENTARY_ONLY' ? 'commentary' : 'final_answer',
          text: JSON.stringify({
            reply: 'Fixture response.',
            needsTask: input.caption === 'ACTION',
            usesTaskStatus: false,
          }),
        },
      },
    });
    send({
      method: 'turn/completed',
      params: { threadId: thread, turn: { id: turn, status: 'completed' } },
    });
  } else if (method === 'turn/interrupt') {
    reply({});
    send({
      method: 'turn/completed',
      params: { threadId: thread, turn: { id: turn, status: 'interrupted' } },
    });
  } else
    send({ id: message.id, error: { message: 'Unexpected fixture request.' } });
}
