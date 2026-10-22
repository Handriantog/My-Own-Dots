import { Application } from 'pixi.js';
// The workspace uses the same strict CSP as the desktop renderer.
import 'pixi.js/unsafe-eval';
import { PlushRig } from './rig';
import { initialPose } from '../core/pose';
import {
  avatarHeight,
  DEFAULT_ACCESSORIES,
  type Accessories,
} from '../shared/accessories';

async function createRenderer() {
  const app = new Application();
  await app.init({
    width: 128,
    height: 128,
    resolution: 2,
    autoDensity: true,
    backgroundAlpha: 0,
    preference: 'webgl',
    autoStart: false,
    preserveDrawingBuffer: true,
  });
  const destroy = () =>
    app.destroy(true, { children: true, texture: false, textureSource: false });
  try {
    // Pixi resolves root-relative paths as hosts on the custom dots: scheme.
    const rig = await PlushRig.create(
      new URL('/desktop-dot', location.href).href,
    );
    app.stage.addChild(rig.container);
    return { app, rig };
  } catch (error) {
    destroy();
    throw error;
  }
}

let renderer: ReturnType<typeof createRenderer> | undefined;
export async function renderCompanionAvatar(
  color: string,
  accessories: Accessories = DEFAULT_ACCESSORIES,
): Promise<string> {
  renderer ??= createRenderer().catch((error) => {
    renderer = undefined;
    throw error;
  });
  const { app, rig } = await renderer;
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
    accessories,
  );
  rig.container.scale.set(Math.min(1, 116 / avatarHeight(accessories)));
  app.render();
  return app.canvas.toDataURL('image/png');
}
