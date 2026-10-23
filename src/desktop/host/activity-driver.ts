import {
  activityDefinitionSchema,
  ActivityDriverFailure,
  type ActivityDefinition,
  type ActivityDriver,
  type ActivityStatus,
} from '../../shared/abilities/activity.js';
import type {
  DesktopDisplay,
  Point,
  SimulationFrame,
} from '../shared/contracts.js';
import { approachActivity, sampleActivity } from '../core/activity.js';
import { palmPosition } from '../core/rig-model.js';

export interface PhysicalPointer {
  point: Point;
  down: boolean;
  revision: number;
  sampledAtMs: number;
  idleMs: number;
}
export interface ActivityPointerTransport {
  begin(generation: number): Promise<PhysicalPointer>;
  move(
    generation: number,
    point: Point,
    sample: PhysicalPointer,
  ): Promise<boolean>;
  end(generation: number): void | Promise<void>;
}
export interface ActivityEnvironment {
  now(): number;
  selectedDot(): string | undefined;
  available(): boolean;
  accessibility(): boolean;
  display(point: Point): DesktopDisplay;
  frame(): SimulationFrame;
  reducedMotion(): boolean;
  handoff(frame: SimulationFrame): void;
  changed(): void;
  sleep: {
    start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
    stop(id: number): void;
  };
  pointer: ActivityPointerTransport;
}
interface Session {
  generation: number;
  owner: { bindingId: string; dotId: string };
  definition: ActivityDefinition;
  status: ActivityStatus;
  assertion?: number;
  physical?: PhysicalPointer;
  anchor: Point;
  startedAt: number;
  from: SimulationFrame;
  last?: SimulationFrame;
  ready: boolean;
  pointerStarted: boolean;
  phase: number;
}

/** A single selected desktop Dot can own one activity. Native generations outlive async starts. */
export class DesktopActivityDriver implements ActivityDriver {
  private generation = 0;
  private retirement: Promise<void> = Promise.resolve();
  private session?: Session;
  private painted = new WeakMap<
    SimulationFrame,
    {
      session: Session;
      phase: number;
      sample?: PhysicalPointer;
      createdAt: number;
    }
  >();
  constructor(private env: ActivityEnvironment) {}
  get animating(): boolean {
    return (
      !!this.session && this.session.ready && this.session.status !== 'paused'
    );
  }
  get active(): boolean {
    return !!this.session;
  }
  status(bindingId: string): ActivityStatus {
    return this.session?.owner.bindingId === bindingId
      ? this.session.status
      : 'inactive';
  }
  async start(
    owner: { bindingId: string; dotId: string },
    input: ActivityDefinition,
  ): Promise<void> {
    const definition = activityDefinitionSchema.parse(input);
    if (owner.dotId !== this.env.selectedDot() || !this.env.available())
      throw new ActivityDriverFailure('host_unavailable');
    if (definition.pointer && !this.env.accessibility())
      throw new ActivityDriverFailure('setup_needed');
    const retirement = this.stop();
    const from = this.env.frame();
    const session: Session = {
      generation: ++this.generation,
      owner,
      definition,
      status: 'approaching',
      anchor: from.root,
      startedAt: this.env.now(),
      from,
      ready: false,
      pointerStarted: false,
      phase: 0,
    };
    this.session = session;
    try {
      await retirement;
      if (this.session !== session)
        throw Error('Activity stopped during start.');
      if (definition.keepAwake)
        session.assertion = this.env.sleep.start(
          definition.keepAwake === 'display'
            ? 'prevent-display-sleep'
            : 'prevent-app-suspension',
        );
      if (definition.pointer) {
        session.pointerStarted = true;
        let physical = await this.env.pointer.begin(session.generation);
        if (this.session !== session) {
          await this.env.pointer.end(session.generation);
          throw Error('Activity stopped during start.');
        }
        if (
          session.physical &&
          session.physical.sampledAtMs > physical.sampledAtMs
        )
          physical = session.physical;
        session.physical = physical;
        session.anchor = physical.point;
        if (physical.down || physical.idleMs < definition.pointer.idleMs)
          session.status = 'paused';
      }
      if (!this.authorized(session))
        throw Error('Desktop activity authority changed.');
      session.ready = true;
      session.startedAt = this.env.now();
      this.env.changed();
    } catch (error) {
      if (this.session === session) this.stop();
      throw error;
    }
  }
  stop(bindingId?: string): Promise<void> {
    const s = this.session;
    if (!s || (bindingId && bindingId !== s.owner.bindingId))
      return this.retirement;
    this.session = undefined;
    try {
      if (s.pointerStarted) {
        const native = this.env.pointer.end(s.generation);
        this.retirement = Promise.all([this.retirement, native]).then(() => {});
        void this.retirement.catch(() => {});
      }
    } finally {
      if (s.assertion !== undefined) this.env.sleep.stop(s.assertion);
      if (s.last) this.env.handoff(s.last);
      this.env.changed();
    }
    return this.retirement;
  }
  private authorized(s: Session): boolean {
    return (
      this.env.available() &&
      this.env.selectedDot() === s.owner.dotId &&
      (!s.definition.pointer || this.env.accessibility())
    );
  }
  physical(sample: PhysicalPointer): void {
    const s = this.session;
    if (!s || !s.definition.pointer) return;
    const previous = s.physical;
    s.physical = sample;
    if (sample.down || (previous && sample.revision !== previous.revision))
      this.pause(s);
  }
  private pause(s: Session): void {
    if (s.status === 'paused') return;
    s.status = 'paused';
    s.phase++;
    if (s.last) {
      this.env.handoff(s.last);
      s.last = undefined;
    }
    this.env.changed();
  }
  frame(base: SimulationFrame, now: number): SimulationFrame {
    const s = this.session;
    if (!s) return base;
    if (!this.authorized(s)) {
      this.stop();
      return this.env.frame();
    }
    if (!s.ready) return base;
    if (s.status === 'paused') {
      if (
        !s.physical ||
        s.physical.down ||
        s.physical.idleMs < s.definition.pointer!.idleMs
      )
        return base;
      s.status = 'approaching';
      s.from = base;
      s.anchor = s.physical.point;
      s.startedAt = now;
      this.env.changed();
    }
    const age = now - s.startedAt;
    if (
      !s.definition.loop &&
      age > s.definition.approachMs + s.definition.durationMs
    ) {
      this.stop();
      return this.env.frame();
    }
    const elapsed = Math.max(0, age - s.definition.approachMs);
    const target = sampleActivity(
      s.definition,
      elapsed,
      s.anchor,
      this.env.display(s.anchor).bounds,
      this.env.reducedMotion(),
    );
    const approaching = age < s.definition.approachMs;
    s.status = approaching ? 'approaching' : 'running';
    const sample = approaching
      ? approachActivity(s.from, target, age / s.definition.approachMs)
      : target;
    const frame: SimulationFrame = {
      ...base,
      root: sample.root,
      pose: {
        ...sample.pose,
        eyeOpen: base.pose.eyeOpen,
        mouth: base.pose.mouth,
        speech: base.pose.speech,
        look: { ...base.pose.look },
        breathing: base.pose.breathing,
        love: base.pose.love,
        facing: base.pose.facing,
      },
      atMs: now,
      action: 'idle',
      velocity: { x: 0, y: 0 },
      grip: null,
      climb: null,
      support: null,
      hearts: [],
      displayId: this.env.display(s.anchor).id,
    };
    this.painted.set(frame, {
      session: s,
      phase: s.phase,
      sample: !approaching && s.physical ? { ...s.physical } : undefined,
      createdAt: now,
    });
    return frame;
  }
  async presented(frame: SimulationFrame): Promise<void> {
    const token = this.painted.get(frame);
    this.painted.delete(frame);
    const s = this.session;
    if (!token || !s || token.session !== s || token.phase !== s.phase) return;
    // Remember presented poses only; a slow renderer must not hand off a future pose.
    if (token?.session === s && s && this.animating) s.last = frame;
    if (!token?.sample || token.session !== s || !s || s.status !== 'running')
      return;
    if (!this.authorized(s)) {
      this.stop();
      return;
    }
    if (this.env.now() - token.createdAt > 250) {
      this.stop();
      return;
    }
    try {
      const moved = await this.env.pointer.move(
        s.generation,
        palmPosition(frame.root, frame.pose, s.definition.pointer!.hand),
        token.sample,
      );
      if (this.session === s && !moved) this.pause(s);
    } catch {
      if (this.session === s) this.stop();
    }
  }
}
