import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('disables SDK telemetry before static imports capture configuration', () => {
  const env = { ...process.env };
  delete env.DO_NOT_TRACK;
  delete env.COPILOTKIT_TELEMETRY_DISABLED;
  env.CONVERSATION_BACKEND = 'local';
  const script = `
    import './src/server/local-defaults.ts';
    import '@copilotkit/runtime/v2';
    import telemetry from './node_modules/@copilotkit/runtime/dist/v2/runtime/telemetry/telemetry-client.mjs';
    const calls=[];
    globalThis.fetch=async(url)=>{calls.push(String(url));return new Response('{}',{status:200})};
    await telemetry.capture('oss.runtime.agent_execution_stream_started',{});
    console.log(JSON.stringify(calls));
  `;
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { env, encoding: 'utf8' },
  );
  expect(JSON.parse(output.trim())).toEqual([]);
  expect(
    readFileSync('src/server/index.ts', 'utf8')
      .trimStart()
      .startsWith("import './local-defaults.js';"),
  ).toBe(true);
});
