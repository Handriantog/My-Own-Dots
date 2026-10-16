import { _electron as electron } from 'playwright';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'artifacts/desktop');
const data = path.join(out, 'live-test-data');
await mkdir(data, { recursive: true });
await writeFile(
  path.join(data, 'preferences.json'),
  JSON.stringify({
    version: 1,
    color: '#45a7ff',
    volume: 0.4,
    muted: true,
    paused: false,
    reducedMotion: false,
    displayId: null,
    placement: null,
  }),
);
const executablePath = path.resolve(
  process.argv[2] ??
    path.join(
      root,
      'release/My Own Dots-darwin-arm64/My Own Dots.app/Contents/MacOS/My Own Dots',
    ),
);
const minutes = Number(process.argv[3] ?? 30);
const app = await electron.launch({
  executablePath,
  cwd: tmpdir(),
  env: { ...process.env, DOTS_DESKTOP_DATA: data },
});
const samples = [],
  errors = [];
app
  .process()
  .on('exit', (code, signal) =>
    console.log('APP_EXIT', { code, signal, at: Date.now() }),
  );
app.process().stderr.on('data', (data) => {
  const message = String(data);
  if (!message.includes('Debugger') && !message.includes('For help'))
    errors.push(message.trim());
});
const page = await app.firstWindow();
page.on('close', () => console.log('PAGE_CLOSED', Date.now()));
page.on('crash', () => console.log('PAGE_CRASHED', Date.now()));
page.on('pageerror', (error) => errors.push(error.message));
const started = Date.now();
console.log(
  `Live companion PID ${app.process().pid}; sampling for ${minutes} minutes; roaming active with sound muted.`,
);
try {
  await page.waitForFunction(() => window.dotDiagnostics?.frames > 5, null, {
    timeout: 20000,
  });
  while (Date.now() - started < minutes * 60000) {
    const state = await page.evaluate(() => window.dotDiagnostics);
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
    const children = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm='], {
      encoding: 'utf8',
    })
      .stdout.split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter(
        (parts) =>
          Number(parts[1]) === app.process().pid &&
          parts.slice(4).join(' ').endsWith('desktop-observer'),
      )
      .map((parts) => ({
        pid: Number(parts[0]),
        rssKiB: Number(parts[2]),
        cpuPercent: Number(parts[3]),
      }));
    const sample = {
      atMs: Date.now() - started,
      renderMs: state.renderMs,
      frames: state.frames,
      action: state.frame.simulation.action,
      root: state.frame.simulation.root,
      grip: state.frame.simulation.grip,
      cursor: await page.evaluate(() => document.body.style.cursor),
      audio: state.audio,
      preferences: state.frame.preferences,
      processes: metrics.map((m) => ({
        pid: m.pid,
        type: m.type,
        cpuPercent: m.cpu.percentCPUUsage,
        workingSetKiB: m.memory.workingSetSize,
      })),
      helper: children,
    };
    samples.push(sample);
    await writeFile(
      path.join(out, 'live-current.json'),
      JSON.stringify(sample, null, 2),
    );
    await appendFile(
      path.join(out, 'live-samples.jsonl'),
      JSON.stringify(sample) + '\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
} finally {
  const times = samples.map((s) => s.renderMs).sort((a, b) => a - b);
  const rss = samples.map(
    (s) =>
      s.processes.reduce((sum, p) => sum + p.workingSetKiB, 0) +
      s.helper.reduce((sum, p) => sum + p.rssKiB, 0),
  );
  const report = {
    kind: 'live packaged application resource samples',
    durationMinutes: (Date.now() - started) / 60000,
    samples: samples.length,
    sampledRenderP95Ms: times[Math.floor(times.length * 0.95)] ?? null,
    firstWorkingSetMiB: rss[0] / 1024,
    lastWorkingSetMiB: rss.at(-1) / 1024,
    peakWorkingSetMiB: Math.max(...rss) / 1024,
    peakActiveAudioVoices: Math.max(
      ...samples.map((s) => s.audio?.voices ?? 0),
    ),
    actions: [...new Set(samples.map((s) => s.action))],
    errors,
    note: 'Five-second samples of renderer JS work and host/renderer/GPU/utility/helper resources. Native QA may change pause/mute. This does not measure compositor frame delivery or acoustic latency.',
  };
  await writeFile(
    path.join(out, 'live-soak.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await app.close();
}
