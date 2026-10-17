import {
  Assets,
  Container,
  Graphics,
  MeshPlane,
  Rectangle,
  Sprite,
  Texture,
} from 'pixi.js';
import {
  deformFurVertex,
  hitTestRig,
  layerTint,
  parseRig,
  armTransform,
  type RigDefinition,
} from '../core/rig-model.js';
import type { Point, SimulationFrame } from '../shared/contracts.js';

type Part = keyof RigDefinition['layers'];
export class PlushRig {
  readonly container = new Container();
  private torso = new Container();
  private headphones = new Container();
  private sprites = {} as Record<Part, Sprite>;
  private body: MeshPlane;
  private restVertices: Float32Array;
  private mouthOpen = new Graphics();
  private brows = new Graphics();
  private bodyMask: Graphics;
  private legs: Sprite[] = [];
  private constructor(
    private definition: RigDefinition,
    textures: Record<Part, Texture>,
  ) {
    this.container.addChild(this.torso);
    for (const name of ['leftFoot', 'rightFoot'] as const) {
      const leg = new Sprite(textures[name]);
      leg.anchor.set(0.5, 0);
      this.legs.push(leg);
      this.torso.addChild(leg);
    }
    for (const name of [
      'leftFoot',
      'rightFoot',
      'leftArm',
      'rightArm',
      'body',
      'headphones',
      'eyes',
      'mouth',
      'tuft',
    ] as Part[]) {
      const part = definition.layers[name],
        sprite = new Sprite(textures[name]);
      sprite.anchor.set(part.pivot.x, part.pivot.y);
      sprite.width = part.size.x;
      sprite.height = part.size.y;
      sprite.position.set(part.position.x, part.position.y);
      this.sprites[name] = sprite;
      if (name === 'headphones') {
        this.headphones.addChild(sprite);
        this.torso.addChild(this.headphones);
      } else if (name !== 'body') this.torso.addChild(sprite);
    }
    const part = definition.layers.body;
    this.body = new MeshPlane({
      texture: textures.body,
      verticesX: 16,
      verticesY: 16,
    });
    this.body.position.set(-part.size.x / 2, part.position.y - part.size.y);
    this.body.scale.set(
      part.size.x / part.frame.width,
      part.size.y / part.frame.height,
    );
    this.restVertices = new Float32Array(
      this.body.geometry.getAttribute('aPosition').buffer.data,
    );
    this.torso.addChildAt(this.body, 6);
    // Authored silhouettes trim disconnected generation debris at render time.
    // The original atlas is preserved; these masks also define the intended anatomy.
    this.bodyMask = new Graphics()
      .moveTo(0, -105)
      .bezierCurveTo(26, -105, 33, -99, 36, -80)
      .bezierCurveTo(39, -63, 47, -44, 46, -27)
      .bezierCurveTo(46, -12, 36, -7, 0, -7)
      .bezierCurveTo(-36, -7, -46, -12, -46, -27)
      .bezierCurveTo(-47, -44, -39, -63, -36, -80)
      .bezierCurveTo(-33, -99, -26, -105, 0, -105)
      .fill(0xffffff);
    this.torso.addChild(this.bodyMask);
    this.body.mask = this.bodyMask;
    const headphonesMask = new Graphics()
      .moveTo(-43, -76)
      .bezierCurveTo(-42, -116, 42, -116, 43, -76)
      .stroke({ color: 0xffffff, width: 12 })
      .ellipse(-43, -62, 13, 22)
      .ellipse(43, -62, 13, 22)
      .fill(0xffffff);
    this.headphones.addChild(headphonesMask);
    this.headphones.pivot.set(0, -76);
    this.headphones.position.set(0, -76);
    this.sprites.headphones.mask = headphonesMask;
    this.mouthOpen
      .ellipse(0, 0, 3.2, 4.3)
      .fill(0x281d1d)
      .ellipse(0, 2, 1.9, 1)
      .fill(0xb77d78);
    this.torso.addChild(this.mouthOpen);
    this.brows
      .moveTo(-20, -79)
      .quadraticCurveTo(-15, -81, -9, -77)
      .moveTo(20, -79)
      .quadraticCurveTo(15, -81, 9, -77)
      .stroke({ color: 0x46332c, width: 1.7, cap: 'round' });
    this.torso.addChild(this.brows);
  }
  static async create(assetBase: string): Promise<PlushRig> {
    Assets.setPreferences({ preferWorkers: false });
    const response = await fetch(`${assetBase}/rig.json`);
    if (!response.ok)
      throw new Error(`Plush rig unavailable (${response.status})`);
    const definition = parseRig(await response.json());
    const atlas = await Assets.load<Texture>(
      `${assetBase}/${definition.atlas}`,
    );
    if (
      atlas.width !== definition.atlasWidth ||
      atlas.height !== definition.atlasHeight
    )
      throw new Error('Plush atlas dimensions do not match its rig.');
    const textures = {} as Record<Part, Texture>;
    for (const name of Object.keys(definition.layers) as Part[]) {
      const r = definition.layers[name].frame;
      textures[name] = new Texture({
        source: atlas.source,
        frame: new Rectangle(r.x, r.y, r.width, r.height),
      });
    }
    return new PlushRig(definition, textures);
  }
  update(frame: SimulationFrame, color: string): void {
    const p = frame.pose;
    this.container.position.set(frame.root.x, frame.root.y);
    const arrival = Math.min(1, frame.actionAge / 0.65);
    this.container.alpha =
      frame.action === 'appear' ? arrival * arrival * (3 - 2 * arrival) : 1;
    this.torso.rotation = p.lean;
    this.torso.scale.set(p.squash, p.stretch);
    // The plush deforms around a rigid accessory attached at the head center.
    this.headphones.scale.set(1 / p.squash, 1 / p.stretch);
    for (const name of Object.keys(this.sprites) as Part[])
      this.sprites[name].tint = layerTint(this.definition.layers[name], color);
    this.body.tint = layerTint(this.definition.layers.body, color);
    this.sprites.leftFoot.position.set(p.leftFoot.x, p.leftFoot.y);
    this.sprites.rightFoot.position.set(p.rightFoot.x, p.rightFoot.y);
    for (const [index, foot] of [p.leftFoot, p.rightFoot].entries()) {
      const leg = this.legs[index],
        attachX = index === 0 ? -20 : 20;
      const dx = foot.x - attachX,
        dy = foot.y + 12;
      leg.position.set(attachX, -19);
      leg.width = 12;
      leg.height = Math.hypot(dx, dy) + 8;
      leg.rotation = Math.atan2(-dx, dy);
      leg.tint = this.body.tint;
    }
    for (const side of [-1, 1] as const) {
      const transform = armTransform(frame, side);
      const arm = this.sprites[side === -1 ? 'leftArm' : 'rightArm'];
      arm.rotation = transform.rotation;
      arm.height = transform.height;
    }
    // A shallow three-quarter turn is one master seen from a different facing;
    // never mirror or replace the identity with another generated frame.
    this.sprites.eyes.x = p.facing * 3;
    this.sprites.eyes.scale.x =
      (this.definition.layers.eyes.size.x /
        this.definition.layers.eyes.frame.width) *
      0.97;
    this.sprites.eyes.scale.y =
      (this.definition.layers.eyes.size.y /
        this.definition.layers.eyes.frame.height) *
      Math.max(0.06, p.eyeOpen);
    this.sprites.mouth.x = p.facing * 3;
    this.sprites.mouth.alpha = 1 - p.mouth;
    this.mouthOpen.position.set(p.facing * 3, -48);
    this.mouthOpen.alpha = p.mouth;
    this.mouthOpen.scale.set(1 - p.effort * 0.25, 1 - p.effort * 0.4);
    this.brows.x = p.facing * 3;
    this.brows.alpha = p.effort;
    const vertices = this.body.geometry.getAttribute('aPosition').buffer;
    const part = this.definition.layers.body;
    for (let i = 0; i < this.restVertices.length; i += 2) {
      const local = {
        x:
          (this.restVertices[i] / part.frame.width) * part.size.x -
          part.size.x / 2,
        y:
          (this.restVertices[i + 1] / part.frame.height) * part.size.y +
          part.position.y -
          part.size.y,
      };
      const deformed = deformFurVertex(
        local,
        frame.grip?.local ?? null,
        p.pinch,
      );
      const breath =
        Math.sin(((local.y + 105) / 98) * Math.PI) * p.breathing * 0.35;
      vertices.data[i] =
        ((deformed.x + part.size.x / 2 + Math.sign(local.x) * breath) /
          part.size.x) *
        part.frame.width;
      vertices.data[i + 1] =
        ((deformed.y - part.position.y + part.size.y) / part.size.y) *
        part.frame.height;
    }
    vertices.update();
    const tuft = this.sprites.tuft;
    tuft.visible = !!frame.grip;
    tuft.alpha = p.pinch;
    if (frame.grip) {
      tuft.position.set(frame.grip.local.x, frame.grip.local.y - 2);
      tuft.rotation = -p.lean;
    }
  }
  hitTest(point: Point, frame: SimulationFrame): boolean {
    return hitTestRig(point, frame);
  }
  destroy(): void {
    this.container.destroy({ children: true });
  }
}
