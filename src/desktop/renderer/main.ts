import { Application } from 'pixi.js';
// Pixi's static uniform/UBO implementations support CSP without unsafe-eval.
import 'pixi.js/unsafe-eval';
import { PlushRig } from './rig.js';
import { CompanionAudio } from './audio.js';
import type {
  DesktopBridge,
  Point,
  PresentationFrame,
} from '../shared/contracts.js';
import './style.css';

declare global {
  interface Window {
    dot: DesktopBridge;
    dotDiagnostics?: {
      frame: PresentationFrame;
      renderMs: number;
      frames: number;
      audio: ReturnType<CompanionAudio['stats']> | null;
    };
  }
}

let latest: PresentationFrame | null = null;
let captured: number | null = null;
let frames = 0;
let audio: CompanionAudio | null = null;
let wasPaused = false;
const app = new Application();
try {
  await app.init({
    width: 320,
    height: 320,
    resolution: window.devicePixelRatio,
    autoDensity: true,
    backgroundAlpha: 0,
    antialias: true,
    preference: 'webgl',
    autoStart: false,
  });
  document.body.appendChild(app.canvas);
  const rig = await PlushRig.create('./desktop-dot');
  try {
    audio = new CompanionAudio();
    await audio.load('./audio');
  } catch (error) {
    audio?.dispose();
    audio = null;
    window.dot.reportError(
      `Audio: ${error instanceof Error ? error.message : 'Could not load effects'}`,
    );
  }
  app.stage.addChild(rig.container);
  document.body.style.cursor = 'default';
  app.canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    document.body.style.cursor = 'default';
    audio?.suspend();
    window.dot.reportError('Graphics context lost');
  });
  const point = (event: PointerEvent): Point => ({
    x: event.clientX + (latest?.origin.x ?? 0),
    y: event.clientY + (latest?.origin.y ?? 0),
  });
  app.canvas.addEventListener('pointerdown', (event) => {
    if (
      event.button !== 0 ||
      !latest ||
      !rig.hitTest(point(event), latest.simulation)
    )
      return;
    event.preventDefault();
    captured = event.pointerId;
    app.canvas.setPointerCapture(event.pointerId);
    window.dot.pointer({
      kind: 'down',
      point: point(event),
      atMs: performance.now(),
    });
  });
  app.canvas.addEventListener('pointermove', (event) => {
    if (captured !== null)
      window.dot.pointer({
        kind: 'move',
        point: point(event),
        atMs: performance.now(),
      });
  });
  const release = (event: PointerEvent, kind: 'up' | 'cancel') => {
    if (captured === null) return;
    captured = null;
    window.dot.pointer({ kind, point: point(event), atMs: performance.now() });
    if (app.canvas.hasPointerCapture(event.pointerId))
      app.canvas.releasePointerCapture(event.pointerId);
  };
  app.canvas.addEventListener('pointerup', (event) => release(event, 'up'));
  app.canvas.addEventListener('pointercancel', (event) =>
    release(event, 'cancel'),
  );
  app.canvas.addEventListener('lostpointercapture', (event) =>
    release(event, 'cancel'),
  );
  window.addEventListener('pagehide', () => {
    document.body.style.cursor = 'default';
    audio?.dispose();
  });
  window.dot.onFrame((frame) => {
    const started = performance.now();
    if (app.renderer.resolution !== window.devicePixelRatio) {
      app.renderer.resolution = window.devicePixelRatio;
      app.renderer.resize(320, 320);
    }
    latest = frame;
    const local = structuredClone(frame.simulation);
    local.root.x -= frame.origin.x;
    local.root.y -= frame.origin.y;
    if (local.grip) {
      local.grip.anchor.x -= frame.origin.x;
      local.grip.anchor.y -= frame.origin.y;
    }
    if (local.climb) {
      local.climb.hand.x -= frame.origin.x;
      local.climb.hand.y -= frame.origin.y;
    }
    rig.update(local, frame.preferences.color);
    app.stage.visible = frame.visible;
    app.render();
    const justPaused = frame.preferences.paused && !wasPaused;
    if (!frame.visible || justPaused) audio?.suspend();
    if (frame.visible)
      audio?.consume(
        justPaused ? [] : frame.events,
        frame.simulation,
        frame.preferences,
        frame.displayBounds,
      );
    wasPaused = frame.preferences.paused;
    window.dotDiagnostics = {
      frame,
      renderMs: performance.now() - started,
      frames: ++frames,
      audio: audio?.stats() ?? null,
    };
    window.dot.ack(frame.sequence);
  });
  window.dot.ready();
} catch (error) {
  document.body.style.cursor = 'default';
  window.dot.reportError(
    error instanceof Error
      ? error.message
      : 'Unable to load the plush character',
  );
}
