import type {
  DesktopDisplay,
  GeometrySnapshot,
  NativeWindow,
} from '../../src/desktop/shared/contracts.js';
export const display: DesktopDisplay = {
  id: '1',
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 825 },
  scaleFactor: 2,
};
export function windowRect(
  id: number,
  x: number,
  y: number,
  width = 500,
  height = 400,
): NativeWindow {
  return {
    id,
    ownerPid: 42,
    generation: 1,
    bounds: { x, y, width, height },
    opaque: true,
  };
}
export function snapshot(
  windows: NativeWindow[] = [],
  overrides: Partial<GeometrySnapshot> = {},
): GeometrySnapshot {
  return {
    protocolVersion: 1,
    helperSession: 'a',
    seq: 1,
    observedAtMs: 0,
    sceneRevision: 1,
    pollIntervalMs: 100,
    accessibility: true,
    sceneValid: true,
    displays: [display],
    windows,
    ...overrides,
  };
}
