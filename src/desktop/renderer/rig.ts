import {
  Assets,
  AlphaFilter,
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
import type { VisibilityPose } from '../core/visibility.js';
import { rigPointToWorld } from '../core/pose.js';

type Part = keyof RigDefinition['layers'];
export class PlushRig {
  readonly container = new Container();
  private torso = new Container();
  private orb = new Container();
  private orbFur: Sprite;
  private bodyCenter: Point;
  private popCenter: Point = { x: 0, y: 0 };
  private morphFade = new AlphaFilter({ alpha: 1 });
  private headphones = new Container();
  private sprites = {} as Record<Part, Sprite>;
  private body: MeshPlane;
  private restVertices: Float32Array;
  private mouthOpen = new Graphics();
  private speechInterior = new Graphics();
  private speechRim: MeshPlane;
  private speechVertices: Float32Array;
  private brows = new Graphics();
  private happyEyes = new Graphics();
  private sleepingEyes = new Graphics();
  private cheeks = new Graphics();
  private hearts = new Graphics();
  private bodyMask: Graphics;
  private legs: Sprite[] = [];
  private constructor(
    private definition: RigDefinition,
    textures: Record<Part, Texture>,
  ) {
    const bodyLayer = definition.layers.body;
    this.bodyCenter = {
      x: bodyLayer.position.x,
      y: bodyLayer.position.y - bodyLayer.size.y / 2,
    };
    this.orbFur = new Sprite(textures.body);
    this.orbFur.anchor.set(0.5);
    this.orbFur.width = 128;
    this.orbFur.height = 136;
    const orbMask = new Graphics().circle(0, 0, 48).fill(0xffffff);
    this.orb.addChild(this.orbFur, orbMask);
    this.orbFur.mask = orbMask;
    this.orb.visible = false;
    this.container.addChild(this.orb, this.torso);
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
    // Forward paws remain visible against the lap in a seated pose; arms can
    // reach the cheeks/headphones instead of disappearing behind the torso.
    for (const name of [
      'leftFoot',
      'rightFoot',
      'leftArm',
      'rightArm',
    ] as const)
      this.torso.addChildAt(
        this.sprites[name],
        this.torso.getChildIndex(this.headphones),
      );
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
    // Bend the original textured smile into a slightly open smile. Its warm
    // brown material and rounded corners remain part of Dot's authored face.
    this.speechRim = new MeshPlane({
      texture: textures.mouth,
      verticesX: 20,
      verticesY: 4,
    });
    this.speechVertices = new Float32Array(
      this.speechRim.geometry.getAttribute('aPosition').buffer.data,
    );
    this.torso.addChild(this.speechInterior, this.speechRim);
    this.brows
      .moveTo(-20, -79)
      .quadraticCurveTo(-15, -81, -9, -77)
      .moveTo(20, -79)
      .quadraticCurveTo(15, -81, 9, -77)
      .stroke({ color: 0x46332c, width: 1.7, cap: 'round' });
    this.torso.addChild(this.brows);
    for (const x of [-14, 14]) {
      this.happyEyes.moveTo(x - 6, -62).quadraticCurveTo(x, -69, x + 6, -62);
      this.sleepingEyes.moveTo(x - 6, -63).quadraticCurveTo(x, -59, x + 6, -63);
      this.cheeks.ellipse(x * 1.45, -52, 5, 2.5);
    }
    this.happyEyes.stroke({ color: 0x46332c, width: 2.1, cap: 'round' });
    this.sleepingEyes.stroke({ color: 0x46332c, width: 1.7, cap: 'round' });
    this.cheeks.fill({ color: 0xf3a3b7, alpha: 0.48 });
    this.torso.addChild(this.happyEyes, this.sleepingEyes, this.cheeks);
    this.container.addChild(this.hearts);
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
    this.popCenter = rigPointToWorld(this.bodyCenter, frame.root, p);
    this.orb.position.set(
      this.popCenter.x - frame.root.x,
      this.popCenter.y - frame.root.y,
    );
    const arrival = Math.min(1, frame.actionAge / 0.65);
    this.container.alpha =
      frame.action === 'appear' ? arrival * arrival * (3 - 2 * arrival) : 1;
    this.torso.rotation = p.lean;
    this.torso.y = p.bodyY;
    this.torso.scale.set(p.squash, p.stretch);
    // The plush deforms around a rigid accessory attached at the head center.
    this.headphones.scale.set(1 / p.squash, 1 / p.stretch);
    for (const name of Object.keys(this.sprites) as Part[])
      this.sprites[name].tint = layerTint(this.definition.layers[name], color);
    this.body.tint = layerTint(this.definition.layers.body, color);
    this.orbFur.tint = this.body.tint;
    this.sprites.leftFoot.position.set(p.leftFoot.x, p.leftFoot.y);
    this.sprites.rightFoot.position.set(p.rightFoot.x, p.rightFoot.y);
    for (const name of ['leftFoot', 'rightFoot'] as const) {
      this.sprites[name].width = 27 + p.seated * 9;
      this.sprites[name].height = 15 + p.seated * 5;
    }
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
      leg.alpha = 1 - p.seated;
    }
    for (const side of [-1, 1] as const) {
      const transform = armTransform(frame, side);
      const arm = this.sprites[side === -1 ? 'leftArm' : 'rightArm'];
      arm.rotation = transform.rotation;
      arm.height = transform.height;
    }
    // A shallow three-quarter turn is one master seen from a different facing;
    // never mirror or replace the identity with another generated frame.
    const eyeX = p.facing * 2 + p.look.x * 4,
      eyeY = p.look.y * 2.5;
    this.sprites.eyes.position.set(eyeX, -63 + eyeY);
    const closed = Math.max(0, Math.min(1, (0.18 - p.eyeOpen) / 0.12));
    this.sprites.eyes.alpha = (1 - p.love) * (1 - closed);
    this.happyEyes.position.set(eyeX, eyeY);
    this.happyEyes.alpha = p.love;
    this.sleepingEyes.position.set(eyeX, eyeY);
    this.sleepingEyes.alpha = closed * (1 - p.love);
    this.cheeks.alpha = p.love;
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
    const opening = p.speech ?? 0;
    this.sprites.mouth.visible = opening < 0.001;
    this.speechRim.visible = this.speechInterior.visible = opening >= 0.001;
    if (this.speechRim.visible) {
      const part = this.definition.layers.mouth;
      const width = 1 - opening * 0.1;
      const vertices = this.speechRim.geometry.getAttribute('aPosition').buffer;
      const points = vertices.data as Float32Array;
      for (let i = 0; i < points.length; i += 2) {
        const x = (this.speechVertices[i] / part.frame.width) * 12 - 6;
        const y = (this.speechVertices[i + 1] / part.frame.height) * 5 - 2.5;
        points[i] = x * width;
        points[i + 1] = y + opening * 3.5 * Math.max(0, 1 - (x / 5.3) ** 2);
      }
      vertices.update();
      this.speechRim.position.set(p.facing * 3, -48);
      this.speechRim.alpha = this.speechInterior.alpha = 1 - p.mouth;
      this.speechInterior.position.set(p.facing * 3, -48);
      this.speechInterior.scale.x = width;
      this.speechInterior
        .clear()
        .moveTo(-4.65, -1.25)
        .quadraticCurveTo(0, 1.45, 4.65, -1.25)
        .quadraticCurveTo(0, 1.45 + opening * 7, -4.65, -1.25)
        .closePath()
        .fill(0x28170f);
    }
    this.mouthOpen.position.set(p.facing * 3, -48);
    this.mouthOpen.alpha = p.mouth;
    this.mouthOpen.scale.set(1 - p.effort * 0.25, 1 - p.effort * 0.4);
    this.brows.x = p.facing * 3;
    this.brows.alpha = p.effort;
    this.hearts.clear();
    for (const burst of frame.hearts ?? [])
      for (let i = 0; i < 3; i++) {
        const age = burst.age - i * 0.15;
        if (age < 0 || age > 1.45) continue;
        const t = age / 1.45;
        const alpha =
          Math.min(1, age / 0.12) * Math.min(1, (1.45 - age) / 0.4) * 0.85;
        const x =
          burst.origin.x -
          frame.root.x +
          i * 9 +
          (burst.still ? 0 : Math.sin(age * 3 + i) * 4);
        const y =
          burst.origin.y - frame.root.y - i * 6 - (burst.still ? 0 : age * 24);
        const size =
          (0.65 + i * 0.12) * (burst.still ? 1 : Math.min(1, 0.6 + t * 3));
        const point = (dx: number, dy: number) => ({
          x: x + dx * size,
          y: y + dy * size,
        });
        const a = point(0, 4),
          b = point(-11, -3),
          c = point(-6, -12),
          d = point(0, -6),
          e = point(6, -12),
          f = point(11, -3),
          g = point(0, 4);
        this.hearts
          .moveTo(a.x, a.y)
          .bezierCurveTo(b.x, b.y, c.x, c.y, d.x, d.y)
          .bezierCurveTo(e.x, e.y, f.x, f.y, g.x, g.y)
          .fill({ color: i % 2 ? 0xffb9d1 : 0xf382b0, alpha });
      }
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
  appearance(pose: VisibilityPose): Point {
    this.container.alpha = 1;
    // Scale toward the posed body's center instead of the feet/root, keeping
    // the circle in the same place as it shrinks away or unfolds into Dot.
    this.container.position.set(
      this.popCenter.x + (this.container.x - this.popCenter.x) * pose.scaleX,
      this.popCenter.y + (this.container.y - this.popCenter.y) * pose.scaleY,
    );
    this.container.scale.set(pose.scaleX, pose.scaleY);
    this.orb.visible = pose.circle > 0;
    this.orb.alpha = Math.min(1, pose.circle * 3);
    // Let the ball grow before facial details and headphones unfold; a tiny
    // translucent copy of the whole Dot otherwise reads as a ghost over it.
    const morph = Math.min(1, pose.circle / 0.65);
    this.morphFade.alpha = 1 - morph * morph * (3 - 2 * morph);
    this.torso.visible = this.morphFade.alpha > 0;
    this.torso.filters =
      pose.circle > 0 && pose.circle < 1 ? [this.morphFade] : [];
    return this.popCenter;
  }
  destroy(): void {
    this.container.destroy({ children: true });
  }
}
