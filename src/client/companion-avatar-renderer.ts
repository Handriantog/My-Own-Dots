import { Application } from 'pixi.js';
// The workspace uses the same strict CSP as the desktop renderer.
import 'pixi.js/unsafe-eval';
import { PlushRig } from '../desktop/renderer/rig';
import { initialPose } from '../desktop/core/pose';

export async function renderCompanionAvatar(color: string) {
  const app = new Application();
  await app.init({
    width: 128,
    height: 128,
    resolution: 2,
    autoDensity: true,
    backgroundAlpha: 0,
    preference: 'webgl',
    autoStart: false,
  });
  const destroy = () =>
    app.destroy(true, { children: true, texture: false, textureSource: false });
  try {
    const rig = await PlushRig.create('/desktop-dot');
    app.stage.addChild(rig.container);
    rig.update(
      {
        atMs: 0,
        root: { x: 64, y: 123 },
        velocity: { x: 0, y: 0 },
        action: 'idle',
        actionAge: 0,
        actionId: 1,
        facing: 1,
        displayId: 'avatar',
        support: null,
        grip: null,
        climb: null,
        pose: initialPose(),
        hearts: [],
      },
      color,
    );
    app.render();
    app.canvas.setAttribute('aria-hidden', 'true');
    app.canvas.dataset.color = color;
    return { canvas: app.canvas, destroy };
  } catch (error) {
    destroy();
    throw error;
  }
}
