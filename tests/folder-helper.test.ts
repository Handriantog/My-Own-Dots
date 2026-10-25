import { folderPython } from '../src/server/folder-python.js';
import { afterEach, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dots-folder-helper-'));
  roots.push(root);
  const result = call({ action: 'inspect', root });
  expect(result.ok).toBe(true);
  return {
    root: result.result.path as string,
    identity: result.result.identity,
  };
}
function call(request: unknown) {
  const child = spawnSync(
    folderPython(),
    ['-I', resolve('scripts/folder-access.py')],
    {
      input: JSON.stringify(request),
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 524288,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  return JSON.parse(child.stdout);
}

it('rejects unknown operations and malformed paths without returning absolute paths', async () => {
  const f = await fixture();
  for (const action of ['delete', 'mkdir', 'shell']) {
    const result = call({ action, ...f, path: 'file' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(f.root);
  }
  for (const path of ['/etc/passwd', '..', 'x//y', 'x/./y', 'x/../y', 'x\0y']) {
    expect(call({ action: 'read', ...f, path }).ok).toBe(false);
  }
  expect(call({ action: 'inspect', root: '.' }).ok).toBe(false);
});

it('caps directory results at 200 and does not recursively enumerate subfolders', async () => {
  const f = await fixture();
  await mkdir(join(f.root, 'subfolder'));
  await writeFile(join(f.root, 'subfolder', 'nested-secret.txt'), 'private');
  await Promise.all(
    Array.from({ length: 205 }, (_, i) =>
      writeFile(join(f.root, `entry-${i}.txt`), ''),
    ),
  );
  const result = call({ action: 'list', ...f, path: '.' });
  expect(result.ok).toBe(true);
  expect(result.result.entries).toHaveLength(200);
  expect(result.result.truncated).toBe(true);
  expect(JSON.stringify(result.result)).not.toContain('nested-secret');
});

it('rejects FIFOs without hanging and rejects invalid UTF-8 writes', async () => {
  const f = await fixture();
  const fifo = spawnSync('mkfifo', [join(f.root, 'pipe')]);
  expect(fifo.status).toBe(0);
  expect(call({ action: 'read', ...f, path: 'pipe' }).ok).toBe(false);
  expect(
    call({
      action: 'write',
      ...f,
      path: 'bad.txt',
      content: '\ud800',
      expectedHash: 'new',
    }).ok,
  ).toBe(false);
  expect(await readdir(f.root)).toEqual(['pipe']);
});

it('cleans atomic-write temporary files if the destination changes during commit', async () => {
  const f = await fixture();
  // Fault injection at the OS commit boundary exercises the real cleanup path.
  const script = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('folder_helper',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
request=json.loads(sys.stdin.read())
def fail(*args,**kwargs): raise FileExistsError('concurrent creation')
m.os.link=fail
try: m.execute(request)
except FileExistsError: pass
else: raise AssertionError('write unexpectedly succeeded')
`;
  const child = spawnSync(
    folderPython(),
    ['-I', '-c', script, resolve('scripts/folder-access.py')],
    {
      input: JSON.stringify({
        action: 'write',
        ...f,
        path: 'new.txt',
        content: 'new',
        expectedHash: 'new',
      }),
      encoding: 'utf8',
      timeout: 3000,
    },
  );
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  expect(await readdir(f.root)).toEqual([]);
});

it('cancels an in-flight write and removes its temporary file when the server parent exits', async () => {
  const f = await fixture();
  const output = join(f.root, 'helper-output.json');
  const marker = join(f.root, 'write-started');
  const childScript = `import importlib.util,sys,time
spec=importlib.util.spec_from_file_location('folder_helper',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def pause(fd):
 open(sys.argv[2],'w').close()
 time.sleep(1)
m.os.fsync=pause
m.main()
`;
  const parentScript = `import json,os,subprocess,sys,time
request=json.loads(sys.stdin.read());request['parentPid']=os.getpid()
with open(sys.argv[3],'w') as output:
 child=subprocess.Popen([sys.executable,'-I','-c',sys.argv[4],sys.argv[1],sys.argv[2]],stdin=subprocess.PIPE,stdout=output,stderr=output)
 child.stdin.write(json.dumps(request).encode());child.stdin.close()
 deadline=time.monotonic()+2
 while not os.path.exists(sys.argv[2]) and time.monotonic()<deadline: time.sleep(.01)
os._exit(0)
`;
  const parent = spawnSync(
    folderPython(),
    [
      '-I',
      '-c',
      parentScript,
      resolve('scripts/folder-access.py'),
      marker,
      output,
      childScript,
    ],
    {
      input: JSON.stringify({
        action: 'write',
        ...f,
        path: 'new.txt',
        content: 'new',
        expectedHash: 'new',
      }),
      encoding: 'utf8',
      timeout: 3000,
    },
  );
  expect(parent.status).toBe(0);
  let result = '';
  for (let attempt = 0; attempt < 100 && !result; attempt++) {
    result = await readFile(output, 'utf8').catch(() => '');
    if (!result) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(JSON.parse(result)).toMatchObject({
    ok: false,
    error: expect.stringMatching(/cancel/i),
  });
  expect(await readdir(f.root)).toEqual(
    expect.arrayContaining(['helper-output.json', 'write-started']),
  );
  expect(
    (await readdir(f.root)).filter(
      (name) => name === 'new.txt' || name.startsWith('.dots-write-'),
    ),
  ).toEqual([]);
});

it('serializes separate helper processes writing the same directory', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'shared.txt'), 'original');
  const script = `import importlib.util,sys,time
spec=importlib.util.spec_from_file_location('folder_helper',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original=m.os.replace
def delay(*args,**kwargs):
 time.sleep(.3)
 return original(*args,**kwargs)
m.os.replace=delay
m.main()
`;
  const run = (content: string) =>
    new Promise<{ ok: boolean }>((resolveResult, reject) => {
      const child = spawn(
        folderPython(),
        ['-I', '-c', script, resolve('scripts/folder-access.py')],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let output = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Helper timed out'));
      }, 3000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) return reject(new Error('Helper failed'));
        resolveResult(JSON.parse(output));
      });
      child.stdin.end(
        JSON.stringify({
          action: 'write',
          ...f,
          path: 'shared.txt',
          content,
          expectedHash: createHash('sha256').update('original').digest('hex'),
          parentPid: process.pid,
        }),
      );
    });
  const results = await Promise.all([run('first'), run('second')]);
  expect(results.map((result) => result.ok).sort()).toEqual([false, true]);
  expect(['first', 'second']).toContain(
    await readFile(join(f.root, 'shared.txt'), 'utf8'),
  );
  expect(
    (await readdir(f.root)).filter((name) => name.startsWith('.dots-write-')),
  ).toEqual([]);
});

it.skipIf(process.platform !== 'darwin')(
  'reports unsupported system Python as a runtime problem, not an invalid folder',
  () => {
    const child = spawnSync(
      '/usr/bin/python3',
      ['-I', resolve('scripts/folder-access.py')],
      {
        input: JSON.stringify({ action: 'inspect', root: '/tmp' }),
        encoding: 'utf8',
        timeout: 3000,
      },
    );
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      ok: false,
      code: 'unsupported_python',
      pythonVersion: expect.any(String),
    });
    expect(JSON.parse(child.stdout).error).toContain('Python 3.12');
  },
);
