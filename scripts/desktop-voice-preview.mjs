import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  initialPose,
  samplePose,
  rigPointToWorld,
} from '../src/desktop/core/pose.ts';
import { DEFAULT_CATEGORY_VOLUMES } from '../src/desktop/core/sound-categories.ts';
import { CompanionVisibility } from '../src/desktop/core/visibility.ts';

// Preview the built overlay without a native window, microphone, or AI call.
const root = fileURLToPath(new URL('..', import.meta.url));
const renderer = path.join(root, 'dist/desktop/renderer');
const visibilityPreview = process.argv.includes('--visibility');
const output = path.join(
  root,
  'artifacts/desktop',
  visibilityPreview ? 'visibility' : 'voice',
);
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(
      renderer,
      `.${pathname === '/' ? '/index.html' : pathname}`,
    );
    if (!file.startsWith(renderer + path.sep)) throw Error('Invalid path');
    res.setHeader(
      'content-type',
      file.endsWith('.html')
        ? 'text/html'
        : file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : file.endsWith('.png')
              ? 'image/png'
              : file.endsWith('.json')
                ? 'application/json'
                : 'audio/wav',
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 320, height: 320 },
    deviceScaleFactor: 2,
    recordVideo: { dir: output, size: { width: 640, height: 640 } },
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.dot = {
      onFrame: (callback) => {
        window.renderFrame = callback;
      },
      ack: () => {},
      pointer: () => {},
      ready: () => {
        window.previewReady = true;
      },
      reportError: (message) => {
        throw Error(message);
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.previewReady);
  await page.evaluate(() => {
    document.body.style.background = '#353c48';
  });
  let pose = initialPose();
  let sequence = 0;
  const frameAt = (phase, time, position = { x: 160, y: 265 }) => {
    pose = samplePose(
      pose,
      {
        action: 'idle',
        age: 2,
        speed: 0,
        distance: 0,
        facing: 1,
        time,
        sway: 0,
        reducedMotion: false,
        voice: phase,
      },
      1 / 60,
    );
    return {
      sequence: ++sequence,
      sentAtMs: time * 1000,
      origin: { x: 0, y: 0 },
      simulation: {
        atMs: time * 1000,
        root: position,
        velocity: { x: 0, y: 0 },
        action: 'idle',
        actionAge: 2,
        actionId: 1,
        facing: 1,
        displayId: 'preview',
        support: null,
        grip: null,
        climb: null,
        pose,
        hearts: [],
      },
      events: [],
      preferences: {
        color: '#45a7ff',
        muted: true,
        paused: false,
        reducedMotion: false,
        volume: 0,
        categoryVolumes: DEFAULT_CATEGORY_VOLUMES,
      },
      hovered: false,
      visible: true,
      displayBounds: { x: 0, y: 0, width: 320, height: 320 },
      voiceActive: !!phase,
      voiceState: phase,
    };
  };
  const draw = (frame) =>
    page.evaluate((frame) => window.renderFrame(frame), frame);
  let frames;
  if (visibilityPreview) {
    const motion = new CompanionVisibility();
    let visible = true;
    let reduced = false;
    frames = Array.from({ length: 360 }, (_, n) => {
      const time = (n / 60) * 1000;
      if ([0, 90, 150, 210, 216, 270, 306].includes(n)) {
        visible = [0, 150, 216, 306].includes(n);
        reduced = n >= 270;
        motion.setVisible(visible, time, reduced);
      }
      return {
        ...frameAt(visible ? 'listening' : null, time / 1000),
        visible,
        appearance: motion.sample(time),
      };
    });
    for (const [name, n] of [
      ['show-circle', 6],
      ['show-stretch', 12],
      ['shown', 50],
      ['hide-blink', 94],
      ['hide-fade', 98],
      ['hide-circle', 106],
      ['pop', 109],
      ['hidden', 116],
      ['reversed', 222],
      ['reduced-fade', 274],
    ]) {
      await draw(frames[n]);
      const opacity = Number(
        await page
          .locator('.voice-status')
          .evaluate((el) => getComputedStyle(el).opacity),
      );
      assert.ok(
        Math.abs(
          opacity -
            frames[n].appearance.alpha * (1 - frames[n].appearance.circle),
        ) < 0.00001,
      );
      assert.equal(
        await page
          .locator('canvas')
          .evaluate((el) => getComputedStyle(el).opacity),
        String(Number(frames[n].appearance.alpha.toFixed(6))),
      );
      await page.screenshot({ path: path.join(output, `${name}.png`) });
    }
    // Read the rendered pixels: the circle and ripple must share the body's
    // center throughout both transitions, including leaning and seated poses.
    for (const n of [1, 6, 106, 109]) {
      for (const poseChange of [{}, { lean: 0.5, stretch: 0.85, bodyY: 7 }]) {
        const frame = structuredClone(frames[n]);
        Object.assign(frame.simulation.pose, poseChange);
        const center = rigPointToWorld(
          { x: 0, y: -56 },
          frame.simulation.root,
          frame.simulation.pose,
        );
        const bounds = await page.evaluate((frame) => {
          window.renderFrame(frame);
          const canvas = document.querySelector('canvas');
          const copy = new OffscreenCanvas(canvas.width, canvas.height);
          const context = copy.getContext('2d');
          context.drawImage(canvas, 0, 0);
          const pixels = context.getImageData(
            0,
            0,
            copy.width,
            copy.height,
          ).data;
          let left = copy.width,
            top = copy.height,
            right = -1,
            bottom = -1;
          for (let y = 0; y < copy.height; y++) {
            for (let x = 0; x < copy.width; x++) {
              if (pixels[(y * copy.width + x) * 4 + 3] > 5) {
                left = Math.min(left, x);
                right = Math.max(right, x);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
              }
            }
          }
          return {
            x: (left + right + 1) / 2 / devicePixelRatio,
            y: (top + bottom + 1) / 2 / devicePixelRatio,
            visible: right >= left,
          };
        }, frame);
        assert.ok(bounds.visible);
        assert.ok(
          Math.hypot(bounds.x - center.x, bounds.y - center.y) < 1,
          `Frame ${n}: pop center ${JSON.stringify(bounds)} differs from body center ${JSON.stringify(center)}`,
        );
      }
    }
    assert.equal(frames[116].appearance.alpha, 0);
  } else {
    for (const phase of ['listening', 'thinking', 'speaking', null]) {
      for (let n = 0; n < 60; n++) await draw(frameAt(phase, n / 60 + 1));
      const bubble = page.locator('.voice-status');
      if (phase === 'listening' || phase === 'thinking') {
        assert.equal(await bubble.isVisible(), true);
        assert.equal(
          await bubble.textContent(),
          phase === 'listening' ? 'Listening' : 'Thinking',
        );
        assert.equal(await bubble.getAttribute('data-side'), 'right');
        assert.equal(
          await bubble.evaluate((el) => getComputedStyle(el).pointerEvents),
          'none',
        );
      } else assert.equal(await bubble.isVisible(), false);
      await page.screenshot({
        path: path.join(output, `${phase ?? 'idle'}.png`),
      });
    }
    await draw(frameAt('listening', 2, { x: 268, y: 320 }));
    assert.equal(
      await page.locator('.voice-status').getAttribute('data-side'),
      'left',
    );
    const box = await page.locator('.voice-status').boundingBox();
    assert.ok(
      box.x >= 0 && box.x + box.width <= 320 && box.y + box.height <= 320,
    );
    await page.screenshot({ path: path.join(output, 'screen-edge.png') });
    await page.evaluate(() =>
      window.renderFrame({ ...window.dotDiagnostics.frame, visible: false }),
    );
    assert.equal(await page.locator('.voice-status').isVisible(), false);
    // Record actual timed motion and retain a sequence for inspecting mouth shape.
    pose = initialPose();
    frames = Array.from({ length: 540 }, (_, n) =>
      frameAt(
        n < 120
          ? 'listening'
          : n < 210
            ? 'thinking'
            : n < 480
              ? 'speaking'
              : 'listening',
        n / 60,
      ),
    );
  }
  await page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        const start = performance.now();
        const tick = () => {
          const n = Math.min(
            frames.length - 1,
            Math.floor(((performance.now() - start) / 1000) * 60),
          );
          window.renderFrame(frames[n]);
          if (n < frames.length - 1) requestAnimationFrame(tick);
          else resolve();
        };
        tick();
      }),
    frames,
  );
  for (const n of visibilityPreview ? [] : [227, 232, 237, 242, 247, 252]) {
    await draw(frames[n]);
    await page.screenshot({ path: path.join(output, `speech-${n}.png`) });
  }
  assert.deepEqual(errors, []);
  const video = page.video();
  await page.close();
  await video.saveAs(
    path.join(
      output,
      visibilityPreview ? 'visibility-motion.webm' : 'voice-motion.webm',
    ),
  );
  console.log(`Renderer checks passed; previews: ${output}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
