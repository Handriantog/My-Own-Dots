/** All desktop coordinates are global logical pixels, top-left origin. */
export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point {
  width: number;
  height: number;
}
export interface DesktopDisplay {
  id: string;
  bounds: Rect;
  workArea: Rect;
  scaleFactor: number;
}
export interface NativeWindow {
  id: number;
  ownerPid: number;
  generation: number;
  bounds: Rect;
  opaque: boolean;
}
export interface GeometrySnapshot {
  protocolVersion: 1;
  helperSession: string;
  seq: number;
  observedAtMs: number;
  sceneRevision: number;
  pollIntervalMs: number;
  accessibility: boolean;
  sceneValid: boolean;
  displays: DesktopDisplay[];
  windows: NativeWindow[];
}
export const BODY = {
  width: 104,
  height: 112,
  footHalf: 19,
  climbReach: 52,
} as const;
export const SOUND_NAMES = [
  'appear',
  'notice',
  'pat',
  'pickup',
  'carry',
  'release',
  'step',
  'turn',
  'jump',
  'grab',
  'climb',
  'pull_up',
  'slip',
  'fall',
  'land_soft',
  'land_hard',
  'bump',
  'sit',
  'stand',
  'stretch',
  'yawn',
  'sleep',
  'wake',
] as const;
export type SoundName = (typeof SOUND_NAMES)[number];
export type Action =
  | 'idle'
  | 'walk'
  | 'turn'
  | 'jump'
  | 'fall'
  | 'land'
  | 'climb'
  | 'hang'
  | 'pull_up'
  | 'held'
  | 'sit'
  | 'stretch'
  | 'yawn'
  | 'sleep'
  | 'wake'
  | 'notice'
  | 'pat'
  | 'appear';
export interface Platform {
  id: string;
  windowKey?: string;
  x1: number;
  x2: number;
  y: number;
  displayId: string;
}
export interface Wall {
  id: string;
  windowKey: string;
  x: number;
  y1: number;
  y2: number;
  side: -1 | 1;
  displayId: string;
}
export interface World {
  platforms: Platform[];
  walls: Wall[];
  displays: DesktopDisplay[];
  revision: string;
  tracking: 'windows' | 'floor';
}
export interface InteractionEvent {
  id: number;
  name: SoundName;
  atMs: number;
  actionId: number;
  intensity: number;
  position: Point;
  scope: string;
  cancelScopes?: string[];
}
export interface Grip {
  anchor: Point;
  local: Point;
  previous: Point;
  velocity: Point;
  age: number;
}
export interface RigPose {
  lean: number;
  stretch: number;
  squash: number;
  gait: number;
  leftArm: number;
  rightArm: number;
  leftArmLength: number;
  rightArmLength: number;
  leftFoot: Point;
  rightFoot: Point;
  eyeOpen: number;
  mouth: number;
  effort: number;
  pinch: number;
  facing: number;
  breathing: number;
}
export interface SimulationFrame {
  atMs: number;
  root: Point;
  velocity: Point;
  action: Action;
  actionId: number;
  actionAge: number;
  facing: -1 | 1;
  displayId: string;
  support: Platform | null;
  grip: Grip | null;
  climb: { wall: Wall; hand: Point } | null;
  pose: RigPose;
}
export interface PointerInput {
  kind: 'down' | 'move' | 'up' | 'cancel' | 'hover';
  point: Point;
  atMs: number;
}
export interface Preferences {
  version: 1;
  color: string;
  volume: number;
  muted: boolean;
  paused: boolean;
  reducedMotion: boolean;
  displayId: string | null;
  placement: Point | null;
}
export interface PresentationFrame {
  sequence: number;
  sentAtMs: number;
  origin: Point;
  simulation: SimulationFrame;
  events: InteractionEvent[];
  preferences: Preferences;
  hovered: boolean;
  visible: boolean;
  displayBounds: Rect;
}
export interface DesktopBridge {
  onFrame(callback: (frame: PresentationFrame) => void): () => void;
  ack(sequence: number): void;
  pointer(input: PointerInput): void;
  ready(): void;
  reportError(message: string): void;
}
