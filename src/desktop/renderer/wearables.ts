import { Container, Graphics } from 'pixi.js';
import { accessoriesKey, type Accessories } from '../shared/accessories.js';
import type { RigPose } from '../shared/contracts.js';

/** Small authored vector pieces follow the plush rig, including squash and gaze. */
export class Wearables {
  readonly container = new Container();
  private head = new Graphics();
  private eyes = new Graphics();
  private neck = new Graphics();
  private key = '';
  constructor() {
    this.container.addChild(this.neck, this.head, this.eyes);
    this.head.pivot.set(0, -96);
    this.head.position.set(0, -96);
  }
  update(value: Accessories, pose: RigPose): void {
    const key = accessoriesKey(value);
    if (key !== this.key) {
      this.key = key;
      drawHeadwear(this.head.clear(), value.headwear);
      drawEyewear(this.eyes.clear(), value.eyewear);
      drawNeckwear(this.neck.clear(), value.neckwear);
      this.head.visible =
        value.headwear !== 'none' && value.headwear !== 'headphones';
      this.eyes.visible = value.eyewear !== 'none';
      this.neck.visible = value.neckwear !== 'none';
    }
    this.head.scale.set(1 / pose.squash, 1 / pose.stretch);
    this.eyes.position.set(
      pose.facing * 2 + pose.look.x * 4,
      pose.look.y * 2.5,
    );
  }
}

function drawHeadwear(g: Graphics, kind: Accessories['headwear']): void {
  if (kind === 'none' || kind === 'headphones') return;
  if (kind === 'beanie') {
    g.moveTo(-37, -94)
      .bezierCurveTo(-37, -125, 36, -125, 37, -94)
      .closePath()
      .fill(0x499b8a);
    g.moveTo(-25, -100)
      .quadraticCurveTo(-26, -115, -8, -118)
      .stroke({ color: 0x8cd0b8, width: 2, alpha: 0.7, cap: 'round' });
    g.circle(0, -121, 6).fill(0xb0decb).circle(-2, -123, 2).fill(0xd9f1e5);
    g.roundRect(-39, -100, 78, 15, 5)
      .fill(0x286e62)
      .roundRect(-39, -100, 78, 12, 5)
      .fill(0x65b7a2);
    for (let x = -32; x <= 32; x += 7)
      g.moveTo(x, -97).lineTo(x, -90).stroke({ color: 0x3c8b79, width: 1.2 });
    g.roundRect(13, -98, 13, 8, 2)
      .fill(0xffe6ba)
      .star(19.5, -94, 5, 2.5, 1.2)
      .fill(0xbb844b);
  } else if (kind === 'cap') {
    g.moveTo(-35, -96)
      .bezierCurveTo(-34, -124, 27, -122, 33, -95)
      .closePath()
      .fill(0xd87358);
    g.moveTo(-8, -118)
      .quadraticCurveTo(5, -114, 8, -96)
      .stroke({ color: 0xffb090, width: 1.5, alpha: 0.8 });
    g.roundRect(-36, -99, 71, 9, 4).fill(0xb95545);
    g.moveTo(2, -96)
      .bezierCurveTo(21, -102, 52, -95, 53, -90)
      .bezierCurveTo(41, -83, 17, -84, 2, -91)
      .closePath()
      .fill(0x974438);
    g.moveTo(2, -98)
      .bezierCurveTo(21, -103, 52, -97, 53, -92)
      .bezierCurveTo(41, -87, 17, -87, 2, -93)
      .closePath()
      .fill(0xf09572);
    g.circle(-10, -108, 6)
      .fill(0xffe6c9)
      .star(-10, -108, 5, 3, 1.5)
      .fill(0xc46a4d);
  } else if (kind === 'crown') {
    g.poly([
      -34, -94, -38, -122, -18, -112, 0, -128, 18, -112, 38, -122, 34, -94,
    ])
      .fill(0xedb94e)
      .stroke({ color: 0xb57c24, width: 1.5, join: 'round' });
    g.poly([
      -30, -99, -33, -115, -17, -106, 0, -120, 17, -106, 33, -115, 30, -99,
    ]).fill(0xffd879);
    g.roundRect(-35, -102, 70, 11, 4)
      .fill(0xdca039)
      .roundRect(-34, -102, 68, 4, 2)
      .fill(0xffe7a4);
    for (const x of [-22, 0, 22]) {
      g.circle(x, -96, 3.5).fill(0x9d6b31);
      g.circle(x, -97, 2.8).fill(x === 0 ? 0xe66f84 : 0x6eb9b0);
      g.circle(x - 0.8, -98, 0.8).fill(0xffffff);
    }
  } else if (kind === 'wizard-hat') {
    g.ellipse(0, -98, 46, 8).fill(0x343367);
    g.moveTo(-31, -100)
      .quadraticCurveTo(-21, -124, -4, -145)
      .quadraticCurveTo(3, -148, 21, -132)
      .quadraticCurveTo(8, -135, 8, -129)
      .lineTo(33, -100)
      .closePath()
      .fill(0x7474b9);
    g.moveTo(-27, -101)
      .quadraticCurveTo(-21, -123, -4, -140)
      .lineTo(1, -135)
      .quadraticCurveTo(-8, -118, -9, -101)
      .closePath()
      .fill(0x9090ce);
    g.ellipse(0, -100, 45, 6).fill(0x6666a7);
    g.moveTo(-31, -104)
      .quadraticCurveTo(0, -98, 31, -104)
      .stroke({ color: 0xe6c57c, width: 5, cap: 'round' });
    g.star(-5, -120, 5, 6, 2.6)
      .fill(0xffdda0)
      .star(14, -112, 5, 3, 1.3)
      .fill(0xffdda0)
      .circle(2, -132, 1.3)
      .fill(0xffedc9);
  } else if (kind === 'party-hat') {
    g.poly([-26, -100, 0, -137, 26, -100])
      .fill(0xf1a5b8)
      .stroke({ color: 0xb96c86, width: 1, join: 'round' });
    g.poly([-22, -102, 0, -133, -4, -114]).fill(0xffc7d4);
    g.poly([-18, -111, -13, -118, 13, -118, 18, -111]).fill(0xffd77f);
    g.ellipse(0, -100, 28, 5).fill(0x8abbb1);
    g.circle(0, -140, 3)
      .fill(0xffd77f)
      .circle(8, -106, 2)
      .fill(0x92cfc4)
      .circle(-7, -123, 1.5)
      .fill(0xffffff);
  } else if (kind === 'flower') {
    g.moveTo(25, -95)
      .quadraticCurveTo(32, -90, 37, -84)
      .stroke({ color: 0x4c9a6e, width: 3, cap: 'round' });
    g.ellipse(37, -91, 7, 3).fill(0x85c599);
    for (let index = 0; index < 7; index++) {
      const angle = (index * Math.PI * 2) / 7;
      const x = 25 + Math.cos(angle) * 8,
        y = -100 + Math.sin(angle) * 8;
      g.circle(x + 0.7, y + 1, 4.5).fill(0xd7c0a6);
      g.circle(x, y, 4.5).fill(0xfff0d8);
    }
    g.circle(25, -100, 5).fill(0xe5ad40).circle(24, -101, 3).fill(0xffd875);
  }
}

function drawEyewear(g: Graphics, kind: Accessories['eyewear']): void {
  if (kind === 'round-glasses') {
    for (const x of [-16, 16]) {
      g.circle(x, -64, 12.5)
        .fill({ color: 0xaad9ef, alpha: 0.13 })
        .stroke({ color: 0x674b35, width: 2.8 });
      g.circle(x, -64.6, 12).stroke({ color: 0xe1bc7c, width: 1.6 });
      g.moveTo(x - 7, -68)
        .lineTo(x - 2, -73)
        .stroke({ color: 0xffffff, alpha: 0.45, width: 1.5, cap: 'round' });
    }
    g.moveTo(-3, -64)
      .quadraticCurveTo(0, -68, 3, -64)
      .moveTo(-29, -66)
      .lineTo(-35, -69)
      .moveTo(29, -66)
      .lineTo(35, -69)
      .stroke({ color: 0xb98f55, width: 2.2, cap: 'round' });
  } else if (kind === 'sunglasses') {
    for (const x of [-31, 3]) {
      g.roundRect(x, -75, 28, 23, 7)
        .fill(0x182b3d)
        .stroke({ color: 0x11202c, width: 2 });
      g.roundRect(x + 3, -72, 22, 17, 5).fill(0x355365);
      g.moveTo(x + 7, -58)
        .lineTo(x + 20, -70)
        .stroke({ color: 0x9cd6dc, width: 2.5, alpha: 0.55, cap: 'round' });
    }
    g.moveTo(-3, -67)
      .quadraticCurveTo(0, -70, 3, -67)
      .moveTo(-31, -70)
      .lineTo(-36, -72)
      .moveTo(31, -70)
      .lineTo(36, -72)
      .stroke({ color: 0x172a3b, width: 3.5, cap: 'round' });
  }
}

function drawNeckwear(g: Graphics, kind: Accessories['neckwear']): void {
  if (kind === 'scarf') {
    g.roundRect(16, -37, 16, 28, 4)
      .fill(0xa5465e)
      .roundRect(15, -38, 14, 27, 3)
      .fill(0xe08a9b);
    g.roundRect(-36, -41, 72, 15, 7)
      .fill(0xa34660)
      .roundRect(-36, -41, 71, 11, 5)
      .fill(0xd87790);
    g.moveTo(-29, -37)
      .lineTo(26, -37)
      .stroke({ color: 0xf2b1b9, width: 1.8, cap: 'round' });
    for (let x = 17; x <= 28; x += 4)
      g.moveTo(x, -12)
        .lineTo(x, -8)
        .stroke({ color: 0xf6bcc4, width: 2, cap: 'round' });
    g.roundRect(11, -40, 14, 14, 5).fill(0xc56783);
  } else if (kind === 'bow-tie') {
    g.poly([0, -35, -21, -44, -24, -39, -22, -24, -18, -24])
      .fill(0x8d3f5d)
      .stroke({ color: 0x703148, width: 1, join: 'round' });
    g.poly([0, -35, 21, -44, 24, -39, 22, -24, 18, -24])
      .fill(0xb75d7b)
      .stroke({ color: 0x703148, width: 1, join: 'round' });
    g.moveTo(-18, -39)
      .lineTo(-6, -35)
      .moveTo(18, -39)
      .lineTo(6, -35)
      .stroke({ color: 0xe699af, width: 2, cap: 'round' });
    g.roundRect(-5, -40, 10, 12, 3).fill(0xcf7b96);
  } else if (kind === 'bandana') {
    g.poly([-34, -40, 34, -40, 0, -11])
      .fill(0xe8a85c)
      .stroke({ color: 0xb67b41, width: 1, join: 'round' });
    g.poly([-29, -38, 29, -38, 0, -16]).fill(0xf3bd77);
    g.moveTo(-24, -35)
      .lineTo(0, -19)
      .lineTo(24, -35)
      .stroke({ color: 0xffe5b9, width: 1.4, cap: 'round', join: 'round' });
    for (const [x, y] of [
      [-10, -33],
      [10, -33],
      [0, -27],
    ])
      g.circle(x, y, 1.3).fill(0xfff2d6);
  } else if (kind === 'medal') {
    g.poly([-20, -41, -12, -43, 3, -23, -2, -19]).fill(0x527da7);
    g.poly([20, -41, 12, -43, -3, -23, 2, -19]).fill(0x8db3d4);
    g.circle(0, -20, 10)
      .fill(0xb67d2e)
      .circle(0, -21, 9)
      .fill(0xf1c76f)
      .circle(0, -21, 6.7)
      .stroke({ color: 0xffe8a8, width: 1 });
    g.star(0, -21, 5, 4.7, 2.2).fill(0xb17b2f);
  }
}
