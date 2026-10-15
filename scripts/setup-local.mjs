import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';

let contents;
try {
  contents = await readFile('.env', 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  contents = await readFile('.env.example', 'utf8');
}
const value = (key) => parseEnv(contents)[key];
const setDefault = (key, fallback) => {
  if (value(key)) return;
  const line = `${key}=${fallback}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  contents = pattern.test(contents)
    ? contents.replace(pattern, () => line)
    : `${contents.trimEnd()}\n${line}\n`;
};
setDefault('CONVERSATION_BACKEND', 'local');
setDefault('LLM_BACKEND', 'subscription');
setDefault('LLM_PROVIDER', 'codex');
setDefault('LOCAL_POSTGRES_PASSWORD', randomBytes(24).toString('hex'));
setDefault('LOCAL_POSTGRES_PORT', '5434');
setDefault(
  'LOCAL_DATABASE_URL',
  `postgresql://dots:${encodeURIComponent(value('LOCAL_POSTGRES_PASSWORD'))}@127.0.0.1:${value('LOCAL_POSTGRES_PORT')}/dots`,
);
setDefault('AGENT_RUN_TIMEOUT_MS', '900000');
setDefault('DO_NOT_TRACK', '1');
await writeFile('.env', contents, { mode: 0o600 });
console.log('Local configuration saved to .env (existing values preserved).');
console.log('Next: npm run conversations:up && npm run setup:llm');
console.log(
  'Log in to your chosen provider CLI on this host, then npm run llm:check and npm run dev.',
);
