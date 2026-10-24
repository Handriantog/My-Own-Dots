import {
  BODY,
  type Action,
  type InteractionEvent,
  type Platform,
  type Point,
  type PointerInput,
  type SimulationFrame,
  type SoundName,
  type Wall,
  type World,
} from '../shared/contracts.js';
import { chooseIntention, seededRandom, type Intention } from './behavior.js';
import {
  initialPose,
  rigPointToWorld,
  samplePose,
  worldPointToRig,
} from './pose.js';
import { applyClimbContact } from './rig-model.js';
import { climbTop, supportAt } from './world.js';
import { PettingGesture } from './affection.js';
import type { CompanionVoiceState } from '../shared/voice-contract.js';

const STEP = 1 / 120,
  GRAVITY = 850,
  MAX_FALL = 850;
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));
const approach = (a: number, b: number, speed: number) =>
  a + clamp(b - a, -speed, speed);
const length = (p: Point) => Math.hypot(p.x, p.y);
function bounded(p: Point, max: number): Point {
  const scale = Math.min(1, max / (length(p) || 1));
  return { x: p.x * scale, y: p.y * scale };
}

export class CompanionSimulation {
  private world: World;
  private state: SimulationFrame;
  private random: () => number;
  private options: {
    paused: boolean;
    reducedMotion: boolean;
    frozen?: boolean;
    voice?: CompanionVoiceState;
    activity?: boolean;
  } = { paused: false, reducedMotion: false };
  private lastTime: number | null = null;
  private accumulator = 0;
  private activityRelease = 0;
  private suspended = false;
  private events: InteractionEvent[] = [];
  private eventId = 0;
  private intention: Intention | null = null;
  private intentionUntil = 0;
  private pressed: { point: Point; local: Point; atMs: number } | null = null;
  private lastPointerTime = 0;
  private lastCarry = 0;
  private hoverUntil = 0;
  private pointerLook: Point | undefined;
  private pointerNear = false;
  private petting = new PettingGesture();
  private lovedUntil = 0;
  private heartId = 0;
  private distance = 0;
  private lastStep = 0;
  private nextClimbSound = 0;
  private supportMotion: Point = { x: 0, y: 0 };
  private sway = 0;
  private swayVelocity = 0;
  private pullFrom: Point | null = null;
  private pullTo: Platform | null = null;
  private pullTarget: Point | null = null;
  private fallCuePlayed = false;
  private climbStroke: {
    elapsed: number;
    rootY: number;
    handY: number;
    reach: number;
  } | null = null;

  constructor(
    world: World,
    seed = Date.now(),
    placement?: Point,
    preferredDisplayId?: string,
  ) {
    if (!world.displays.length)
      throw new Error('A display is required to introduce Dot.');
    this.world = world;
    this.random = seededRandom(seed);
    const d =
      world.displays.find(
        (d) =>
          d.id === preferredDisplayId &&
          placement &&
          placement.x >= d.bounds.x &&
          placement.x <= d.bounds.x + d.bounds.width &&
          placement.y >= d.bounds.y &&
          placement.y <= d.bounds.y + d.bounds.height,
      ) ??
      world.displays.find(
        (d) =>
          placement &&
          placement.x >= d.bounds.x &&
          placement.x < d.bounds.x + d.bounds.width &&
          placement.y >= d.bounds.y &&
          placement.y < d.bounds.y + d.bounds.height,
      ) ??
      world.displays.find(
        (d) =>
          placement &&
          world.platforms.some(
            (p) =>
              p.id === `floor:${d.id}` &&
              p.y === placement.y &&
              placement.x >= p.x1 &&
              placement.x <= p.x2,
          ),
      ) ??
      world.displays[0];
    const floor = world.platforms.find((p) => p.id === `floor:${d.id}`)!;
    const root = placement
      ? { ...placement }
      : { x: floor.x1 + 100, y: floor.y };
    this.state = {
      hearts: [],
      atMs: 0,
      root,
      velocity: { x: 0, y: 0 },
      action: 'appear',
      actionId: 1,
      actionAge: 0,
      facing: 1,
      displayId: d.id,
      support: supportAt(world, root.x, root.y, d.id),
      grip: null,
      climb: null,
      pose: initialPose(),
    };
    this.emit('appear');
  }
  frame(): SimulationFrame {
    return structuredClone(this.state);
  }
  /** Continue normal physics from the last presented activity pose. */
  adoptActivity(frame: SimulationFrame): void {
    this.state = structuredClone(frame);
    this.activityRelease = 0.25;
    this.state.grip = null;
    this.state.climb = null;
    this.state.velocity = { x: 0, y: 0 };
    this.state.support = supportAt(
      this.world,
      frame.root.x,
      frame.root.y,
      frame.displayId,
    );
    this.intention = null;
    this.climbStroke = null;
    this.pullFrom = this.pullTo = this.pullTarget = null;
    this.supportMotion = { x: 0, y: 0 };
    this.action(this.state.support ? 'idle' : 'fall');
  }
  drainEvents(): InteractionEvent[] {
    const result = this.events;
    this.events = [];
    return result;
  }
  setOptions(options: {
    paused: boolean;
    reducedMotion: boolean;
    frozen?: boolean;
    voice?: CompanionVoiceState;
    activity?: boolean;
  }): void {
    const endingVoice = this.options.voice && !options.voice;
    this.options = options;
    if (options.voice || options.activity) {
      this.intention = null;
      this.state.velocity = { x: 0, y: 0 };
      this.supportMotion = { x: 0, y: 0 };
    }
    if (endingVoice) {
      this.state.support = supportAt(
        this.world,
        this.state.root.x,
        this.state.root.y,
        this.state.displayId,
      );
      this.state.climb = null;
      this.climbStroke = null;
      this.pullFrom = this.pullTo = this.pullTarget = null;
      this.supportMotion = { x: 0, y: 0 };
      this.action(this.state.support ? 'idle' : 'fall');
    }
    if (
      (options.paused || options.reducedMotion) &&
      this.state.support &&
      !this.state.grip
    ) {
      this.intention = null;
      this.action('idle');
    }
  }
  setWorld(world: World): void {
    const old = this.state.support;
    this.world = world;
    if (this.options.voice) return;
    if (old) {
      const candidate = world.platforms.find(
        (p) =>
          p.displayId === old.displayId &&
          (old.windowKey ? p.windowKey === old.windowKey : p.id === old.id) &&
          this.state.root.x + (p.x1 - old.x1) >= p.x1 &&
          this.state.root.x + (p.x1 - old.x1) <= p.x2,
      );
      // Do not mistake occlusion-driven segment changes for actual window translation.
      const oldSpan = old.x2 - old.x1;
      if (
        !candidate ||
        Math.abs(candidate.x1 - old.x1) > 18 ||
        Math.abs(candidate.y - old.y) > 18 ||
        Math.abs(candidate.x2 - candidate.x1 - oldSpan) > 18
      )
        this.detach();
      else {
        this.supportMotion.x += candidate.x1 - old.x1;
        this.supportMotion.y += candidate.y - old.y;
        this.state.support = candidate;
      }
    }
    if (this.state.climb) {
      const oldWall = this.state.climb.wall;
      const wall = world.walls.find(
        (w) =>
          w.windowKey === oldWall.windowKey &&
          w.side === oldWall.side &&
          this.state.climb!.hand.y >= w.y1 - 1 &&
          this.state.climb!.hand.y <= w.y2 + 1,
      );
      if (
        !wall ||
        Math.abs(wall.x - oldWall.x) > 2 ||
        Math.abs(wall.y1 - oldWall.y1) > 2
      )
        this.detach();
      else this.state.climb.wall = wall;
    }
    if (this.pullTo && this.pullTarget) {
      const target = this.pullTarget;
      const platform = world.platforms.find(
        (p) =>
          p.windowKey === this.pullTo!.windowKey &&
          p.displayId === this.pullTo!.displayId &&
          p.y === target.y &&
          target.x >= p.x1 &&
          target.x <= p.x2,
      );
      // Keep the existing trajectory and its exact destination. Replanning a
      // pull mid-flight would snap the body; losing that footprint means fall.
      if (!platform) this.detach();
      else this.pullTo = platform;
    }
    const intent = this.intention;
    if (intent?.kind === 'climb') {
      const wall = world.walls.find((w) => w.id === intent.wall.id);
      const x = wall ? wall.x + (wall.side * BODY.width) / 2 : 0;
      const support = this.state.support;
      if (
        !wall ||
        !climbTop(world, wall) ||
        (support &&
          (x < support.x1 ||
            x > support.x2 ||
            wall.y1 >= this.state.root.y - 65 ||
            wall.y2 < this.state.root.y - 215))
      )
        this.intention = null;
      else this.intention = { kind: 'climb', wall, x };
    }
  }
  suspend(): void {
    this.suspended = true;
    this.cancelGrip();
    this.events = [];
    this.pressed = null;
    this.accumulator = 0;
    this.state.hearts = [];
    this.petting.reset();
    this.pointerLook = undefined;
    this.pointerNear = false;
    this.lovedUntil = 0;
  }
  resume(nowMs: number): void {
    const firstArrival = this.lastTime === null;
    this.suspended = false;
    this.lastTime = nowMs;
    this.state.atMs = nowMs;
    this.events = firstArrival
      ? this.events.map((event) => ({ ...event, atMs: nowMs }))
      : [];
    this.accumulator = 0;
  }
  advance(nowMs: number): void {
    if (!Number.isFinite(nowMs)) return;
    if (
      this.lastTime === null ||
      this.suspended ||
      (this.options.frozen && !this.options.voice)
    ) {
      this.lastTime = nowMs;
      this.state.atMs = nowMs;
      this.accumulator = 0;
      return;
    }
    const elapsed = (nowMs - this.lastTime) / 1000;
    this.lastTime = nowMs;
    if (elapsed < 0 || elapsed > 0.25) {
      this.accumulator = 0;
      this.state.atMs = nowMs;
      this.events = [];
      return;
    }
    this.accumulator = Math.min(this.accumulator + elapsed, 0.1);
    while (this.accumulator >= STEP) {
      this.state.atMs += STEP * 1000;
      this.step(STEP);
      this.accumulator -= STEP;
    }
  }
  pointer(input: PointerInput): void {
    if (
      this.options.voice ||
      this.suspended ||
      !Number.isFinite(input.point.x + input.point.y + input.atMs)
    )
      return;
    const s = this.state;
    if (input.kind === 'hover') {
      const distance = length({
        x: input.point.x - s.root.x,
        y: input.point.y - (s.root.y - 63),
      });
      this.pointerLook = distance < 260 ? { ...input.point } : undefined;
      if (distance < 130) {
        if (
          !this.pointerNear &&
          s.support &&
          !s.grip &&
          !this.pressed &&
          s.action !== 'pet'
        ) {
          this.intention = null;
          this.action('notice', 'notice');
          this.hoverUntil = s.atMs + 800;
        }
      }
      this.pointerNear = distance < 130;
      const local = worldPointToRig(input.point, s.root, s.pose);
      const stroking =
        !!s.support &&
        !s.grip &&
        !this.pressed &&
        (local.x / 40) ** 2 + ((local.y + 62) / 40) ** 2 <= 1;
      if (this.petting.sample(input.point, input.atMs, stroking)) {
        this.intention = null;
        this.lovedUntil = s.atMs + 1700;
        this.hoverUntil = this.lovedUntil;
        this.intentionUntil = this.lovedUntil;
        this.action('pet', 'pat');
        s.hearts.push({
          id: ++this.heartId,
          origin: rigPointToWorld({ x: 35, y: -94 }, s.root, s.pose),
          age: 0,
          still: this.options.reducedMotion,
        });
        s.hearts = s.hearts.slice(-3);
      }
      return;
    }
    if (input.kind === 'down' && !this.pressed) {
      this.petting.reset();
      this.lovedUntil = 0;
      this.pressed = {
        point: { ...input.point },
        local: worldPointToRig(input.point, s.root, s.pose),
        atMs: input.atMs,
      };
      this.lastPointerTime = input.atMs;
      this.intention = null;
      return;
    }
    if (input.kind === 'move' && this.pressed) {
      this.pointerLook = { ...input.point };
      if (
        !s.grip &&
        length({
          x: input.point.x - this.pressed.point.x,
          y: input.point.y - this.pressed.point.y,
        }) >= 4
      ) {
        s.grip = {
          anchor: { ...input.point },
          previous: { ...this.pressed.point },
          local: { ...this.pressed.local },
          velocity: { x: 0, y: 0 },
          age: 0,
        };
        s.support = null;
        s.climb = null;
        this.supportMotion = { x: 0, y: 0 };
        this.action('held', 'pickup', ['fall']);
        this.sway = s.pose.lean;
        this.swayVelocity = 0;
      }
      if (s.grip) {
        const delta = {
          x: input.point.x - s.grip.anchor.x,
          y: input.point.y - s.grip.anchor.y,
        };
        const dt = clamp(
          (input.atMs - this.lastPointerTime) / 1000,
          1 / 240,
          0.1,
        );
        const velocity = bounded({ x: delta.x / dt, y: delta.y / dt }, 650);
        s.grip.velocity = {
          x: s.grip.velocity.x * 0.4 + velocity.x * 0.6,
          y: s.grip.velocity.y * 0.4 + velocity.y * 0.6,
        };
        this.swayVelocity += clamp(-delta.x * 0.004, -0.4, 0.4);
        s.grip.previous = { ...s.grip.anchor };
        s.grip.anchor = { ...input.point };
        this.lastPointerTime = input.atMs;
        this.updateHeldRoot();
        const d = this.world.displays.find(
          (d) =>
            input.point.x >= d.bounds.x &&
            input.point.x <= d.bounds.x + d.bounds.width &&
            input.point.y >= d.bounds.y &&
            input.point.y <= d.bounds.y + d.bounds.height,
        );
        if (d) s.displayId = d.id;
        if (length(delta) > 3 && s.atMs - this.lastCarry > 450) {
          this.emit('carry', 0.4);
          this.lastCarry = s.atMs;
        }
      }
    }
    if (input.kind === 'up' || input.kind === 'cancel') {
      if (s.grip) this.cancelGrip();
      else if (this.pressed && input.kind === 'up') {
        this.action('pat', 'pat');
        this.intentionUntil = s.atMs + 600;
      }
      this.pressed = null;
    }
  }
  private cancelGrip(): void {
    if (!this.state.grip) return;
    const s = this.state;
    s.velocity = bounded(s.grip!.velocity, 650);
    s.grip = null;
    this.pressed = null;
    this.action('fall', 'release');
    this.intention = null;
    this.state.support = null;
  }
  private updateHeldRoot(): void {
    const s = this.state;
    if (!s.grip) return;
    const offset = rigPointToWorld(s.grip.local, { x: 0, y: 0 }, s.pose);
    s.root = { x: s.grip.anchor.x - offset.x, y: s.grip.anchor.y - offset.y };
  }
  private action(
    action: Action,
    sound?: SoundName,
    cancelScopes?: string[],
  ): void {
    if (this.state.action !== action) {
      this.state.action = action;
      this.state.actionAge = 0;
      this.state.actionId++;
    }
    if (sound) this.emit(sound, 1, cancelScopes);
  }
  private emit(name: SoundName, intensity = 1, cancelScopes?: string[]): void {
    this.events.push({
      id: ++this.eventId,
      name,
      atMs: this.state.atMs,
      actionId: this.state.actionId,
      intensity: clamp(intensity, 0.1, 1),
      position: { ...this.state.root },
      scope:
        name === 'fall'
          ? 'fall'
          : name === 'carry'
            ? 'carry'
            : `action:${this.state.actionId}`,
      cancelScopes,
    });
    if (this.events.length > 64) this.events.shift();
  }
  private detach(): void {
    this.state.support = null;
    this.state.climb = null;
    this.climbStroke = null;
    this.supportMotion = { x: 0, y: 0 };
    this.pullFrom = null;
    this.pullTo = null;
    this.pullTarget = null;
    this.intention = null;
    if (!this.state.grip) this.action('fall', 'slip');
  }
  private easeActivityRelease(previousBodyY: number, dt: number): void {
    if (this.activityRelease <= 0) return;
    const blend = Math.min(1, dt / this.activityRelease);
    this.state.pose.bodyY =
      previousBodyY + (this.state.pose.bodyY - previousBodyY) * blend;
    this.activityRelease = Math.max(0, this.activityRelease - dt);
  }
  private step(dt: number): void {
    const s = this.state;
    const previousBodyY = s.pose.bodyY;
    s.actionAge += dt;
    s.hearts = s.hearts.filter((heart) => (heart.age += dt) < 1.8);
    if (this.options.voice || this.options.activity) {
      s.pose = samplePose(
        s.pose,
        {
          action: 'idle',
          age: s.actionAge,
          speed: 0,
          distance: 0,
          facing: s.facing,
          time: s.atMs / 1000,
          sway: 0,
          reducedMotion: this.options.reducedMotion,
          voice: this.options.voice,
        },
        dt,
      );
      this.easeActivityRelease(previousBodyY, dt);
      return;
    }
    if (s.action === 'pet' && s.atMs >= this.lovedUntil) this.action('idle');
    if (s.grip || s.climb || s.support) this.fallCuePlayed = false;
    if (s.grip) {
      s.grip.age += dt;
      this.swayVelocity += (-this.sway * 24 - this.swayVelocity * 7) * dt;
      this.sway = clamp(this.sway + this.swayVelocity * dt, -0.32, 0.32);
      if (s.atMs - this.lastPointerTime > 90) {
        s.grip.velocity.x *= Math.exp(-dt * 15);
        s.grip.velocity.y *= Math.exp(-dt * 15);
      }
    } else if (s.climb) this.climbing(dt);
    else if (s.support) this.grounded(dt);
    else this.airborne(dt);
    const previousPose = s.pose;
    const gaze = this.pointerLook
      ? worldPointToRig(this.pointerLook, s.root, s.pose)
      : undefined;
    s.pose = samplePose(
      s.pose,
      {
        action: s.action,
        age: s.actionAge,
        speed: s.velocity.x,
        distance: this.distance,
        facing: s.facing,
        time: s.atMs / 1000,
        sway: this.sway,
        reducedMotion: this.options.reducedMotion,
        look:
          gaze && s.action !== 'sleep'
            ? {
                x: clamp(gaze.x / 100, -1, 1),
                y: clamp((gaze.y + 63) / 100, -1, 1),
              }
            : undefined,
        loved: s.atMs < this.lovedUntil,
      },
      dt,
    );
    this.easeActivityRelease(previousBodyY, dt);
    applyClimbContact(s, previousPose, dt);
    if (s.grip) this.updateHeldRoot();
  }
  private grounded(dt: number): void {
    const s = this.state;
    const carry = {
      x: clamp(this.supportMotion.x, -120 * dt, 120 * dt),
      y: clamp(this.supportMotion.y, -120 * dt, 120 * dt),
    };
    s.root.x += carry.x;
    s.root.y += carry.y;
    this.supportMotion.x -= carry.x;
    this.supportMotion.y -= carry.y;
    if (Math.abs(this.supportMotion.y) < 0.01) s.root.y = s.support!.y;
    const still =
      this.options.paused ||
      this.options.reducedMotion ||
      this.pressed ||
      this.hoverUntil > s.atMs;
    if (still) this.intention = null;
    if (
      !still &&
      !this.intention &&
      s.atMs >= this.intentionUntil &&
      (s.action !== 'land' || s.actionAge > 0.35) &&
      (s.action !== 'appear' || s.actionAge > 0.7)
    )
      this.beginIntention(chooseIntention(s, this.world, this.random));
    if (!s.support) return;
    if (this.intention?.kind === 'rest' && s.atMs >= this.intentionUntil) {
      if (s.action === 'sleep') this.action('wake', 'wake');
      else if (s.action === 'sit') this.action('idle', 'stand');
      this.intention = null;
      this.intentionUntil = s.atMs + 500;
    }
    const intent = this.intention;
    const target =
      intent?.kind === 'walk' || intent?.kind === 'climb' ? intent.x : s.root.x;
    const distance = target - s.root.x;
    const desired =
      still || !intent || intent.kind === 'rest'
        ? 0
        : Math.sign(distance) *
          Math.min(66, Math.sqrt(2 * 190 * Math.abs(distance)));
    s.velocity.x = approach(s.velocity.x, desired, 190 * dt);
    s.velocity.y = 0;
    if (Math.abs(s.velocity.x) > 0.5) {
      if (s.action !== 'walk' && s.action !== 'pet') this.action('walk');
      const dir = s.velocity.x > 0 ? 1 : -1;
      if (s.facing !== dir) {
        s.facing = dir;
        this.emit('turn', 0.5);
      }
    } else if (s.action === 'walk') this.action('idle');
    const dx = s.velocity.x * dt;
    s.root.x += dx;
    this.distance += Math.abs(dx);
    if (this.distance - this.lastStep >= 20) {
      this.emit('step', 0.45);
      this.lastStep = this.distance;
    }
    if (s.root.x < s.support!.x1 || s.root.x > s.support!.x2) {
      this.detach();
      return;
    }
    if (
      intent &&
      (intent.kind === 'walk' || intent.kind === 'climb') &&
      Math.abs(distance) < 1.5 &&
      Math.abs(s.velocity.x) < 25
    ) {
      if (intent.kind === 'climb') {
        if (s.root.y - 65 <= intent.wall.y2) this.attachWall(intent.wall);
        else {
          s.support = null;
          s.velocity = { x: 0, y: -470 };
          this.action('jump', 'jump');
        }
      } else {
        this.intention = null;
        this.intentionUntil = s.atMs + 500;
      }
    }
  }
  private beginIntention(intent: Intention): void {
    const s = this.state;
    this.intention = intent;
    if (intent.kind === 'rest') {
      if (intent.action === 'peek' && s.support)
        s.facing = s.root.x - s.support.x1 < s.support.x2 - s.root.x ? -1 : 1;
      this.intentionUntil = s.atMs + intent.duration * 1000;
      this.action(
        intent.action,
        (
          {
            sit: 'sit',
            stretch: 'stretch',
            yawn: 'yawn',
            sleep: 'sleep',
            wave: 'notice',
            groom: 'pat',
            headphones: 'stretch',
            look_around: 'notice',
          } as Partial<Record<Action, SoundName>>
        )[intent.action],
      );
    }
    if (intent.kind === 'jump') {
      s.support = null;
      s.velocity = {
        x: clamp((intent.x - s.root.x) / ((2 * 390) / GRAVITY), -170, 170),
        y: -390,
      };
      this.action('jump', 'jump');
    }
  }
  private airborne(dt: number): void {
    const s = this.state,
      before = { ...s.root };
    s.velocity.y = Math.min(MAX_FALL, s.velocity.y + GRAVITY * dt);
    s.root.x += s.velocity.x * dt;
    s.root.y += s.velocity.y * dt;
    const d = this.world.displays.find((d) => d.id === s.displayId);
    if (d) {
      const lo = d.bounds.x + BODY.width / 2,
        hi = d.bounds.x + d.bounds.width - BODY.width / 2;
      if (
        (s.root.x < lo && s.velocity.x < 0) ||
        (s.root.x > hi && s.velocity.x > 0)
      ) {
        s.velocity.x *= -0.25;
        this.emit('bump', 0.5);
      }
      // Position recovery from an off-edge release uses bounded travel, never a jump.
      if (s.root.x < lo) s.velocity.x = Math.max(s.velocity.x, 180);
      if (s.root.x > hi) s.velocity.x = Math.min(s.velocity.x, -180);
    }
    if (this.intention?.kind === 'climb') {
      const wall = this.intention.wall;
      const handY = s.root.y - 65;
      if (
        handY >= wall.y1 &&
        handY <= wall.y2 &&
        Math.abs(s.root.x - (wall.x + (wall.side * BODY.width) / 2)) < 5
      ) {
        this.attachWall(wall);
        return;
      }
    }
    if (s.velocity.y > 80) {
      this.action('fall');
      if (!this.fallCuePlayed) {
        this.emit('fall', 0.65);
        this.fallCuePlayed = true;
      }
    }
    if (s.velocity.y < 0) return;
    let hit: Platform | null = null,
      fraction = Infinity;
    for (const p of this.world.platforms) {
      if (
        p.displayId !== s.displayId ||
        before.y > p.y + 0.01 ||
        s.root.y < p.y
      )
        continue;
      const t = (p.y - before.y) / (s.root.y - before.y || 1);
      const x = before.x + (s.root.x - before.x) * t;
      if (x >= p.x1 && x <= p.x2 && t < fraction) {
        hit = p;
        fraction = t;
      }
    }
    // If released below the work-area floor, settle upward at bounded speed.
    const floor = this.world.platforms.find(
      (p) => p.id === `floor:${s.displayId}`,
    );
    if (
      !hit &&
      floor &&
      before.y > floor.y &&
      s.root.x >= floor.x1 &&
      s.root.x <= floor.x2
    ) {
      s.velocity.y = -150;
      s.root.y = approach(before.y, floor.y, 150 * dt);
      if (s.root.y === floor.y) hit = floor;
    }
    if (hit) {
      const impact = Math.abs(s.velocity.y);
      s.root.y = hit.y;
      s.support = hit;
      s.velocity = { x: 0, y: 0 };
      this.intention = null;
      this.action('land');
      this.emit(
        impact > 500 ? 'land_hard' : 'land_soft',
        Math.max(0.25, impact / 800),
        ['fall', 'carry'],
      );
      this.intentionUntil = s.atMs + 500;
    }
  }
  private attachWall(wall: Wall): void {
    const s = this.state;
    s.support = null;
    s.velocity = { x: 0, y: 0 };
    s.facing = wall.side === -1 ? 1 : -1;
    s.climb = {
      wall,
      hand: { x: wall.x, y: clamp(s.root.y - 65, wall.y1, wall.y2) },
    };
    this.climbStroke = null;
    this.action('climb', 'grab', ['fall']);
    this.nextClimbSound = s.atMs + 500;
  }
  private climbing(dt: number): void {
    const s = this.state,
      contact = s.climb!,
      wall = contact.wall;
    if (
      s.action === 'pull_up' &&
      this.pullFrom &&
      this.pullTo &&
      this.pullTarget
    ) {
      const t = clamp(s.actionAge / 1.4, 0, 1);
      const smooth = (v: number) => v * v * (3 - 2 * v);
      s.root.y =
        this.pullFrom.y +
        (this.pullTarget.y - this.pullFrom.y) * smooth(Math.min(1, t / 0.65));
      s.root.x =
        this.pullFrom.x +
        (this.pullTarget.x - this.pullFrom.x) *
          smooth(clamp((t - 0.3) / 0.7, 0, 1));
      // Once the shoulder crosses the corner, the palm slides inward along
      // the same exposed top. Keeping it on the outside corner would tear the
      // short plush arm away from its contact at the end of a pull-up.
      contact.hand.x =
        wall.side === 1
          ? Math.min(wall.x, s.root.x)
          : Math.max(wall.x, s.root.x);
      if (t === 1) {
        s.support = this.pullTo;
        s.climb = null;
        this.pullFrom = null;
        this.pullTo = null;
        this.pullTarget = null;
        this.intention = null;
        this.intentionUntil = s.atMs + 2800;
        this.action('land');
        this.emit('land_soft', 0.3);
      }
      return;
    }
    if (s.action === 'hang') {
      if (s.actionAge > 0.8) {
        const atTop = contact.hand.y <= wall.y1 + 1 && s.root.y <= wall.y1 + 66;
        if (!atTop && !this.options.paused && !this.options.reducedMotion) {
          // A pause can leave us hanging midway through a stroke. Finish that
          // same stroke rather than treating a distant ledge as a pull-up.
          this.action('climb');
          return;
        }
        const top = atTop ? climbTop(this.world, wall) : undefined;
        if (top && !this.options.paused && !this.options.reducedMotion) {
          this.pullFrom = { ...s.root };
          this.pullTo = top;
          this.pullTarget = {
            x: wall.side === -1 ? top.x1 + 5 : top.x2 - 5,
            y: top.y,
          };
          this.action('pull_up', 'pull_up');
        } else {
          this.detach();
          s.velocity.x = wall.side * 70;
        }
      }
      return;
    }
    // Finish establishing the first grip even if roaming is paused mid-reach.
    // Switching to hang sooner would replace the blended arm with instant IK.
    if (s.actionAge < 0.55) return;
    if (this.options.paused || this.options.reducedMotion) {
      this.action('hang');
      return;
    }
    // Reach while the body waits, then pull against a planted palm. A new
    // stroke starts from the exact previous endpoint, including the last short
    // reach to the ledge; neither the body nor the hand resets between cycles.
    this.climbStroke ??= {
      elapsed: 0,
      rootY: s.root.y,
      handY: contact.hand.y,
      reach: Math.min(28, Math.max(0, contact.hand.y - wall.y1)),
    };
    const stroke = this.climbStroke;
    stroke.elapsed += dt;
    const t = clamp(stroke.elapsed / 0.8, 0, 1);
    const smooth = (v: number) => v * v * (3 - 2 * v);
    contact.hand.y =
      stroke.handY - stroke.reach * smooth(Math.min(1, t / 0.28));
    s.root.y =
      stroke.rootY - stroke.reach * smooth(clamp((t - 0.28) / 0.62, 0, 1));
    if (s.atMs >= this.nextClimbSound && t > 0.28) {
      this.emit('climb', 0.4);
      this.nextClimbSound = s.atMs + 800;
    }
    if (t === 1) {
      this.climbStroke = null;
      if (contact.hand.y <= wall.y1) this.action('hang');
    }
  }
}
