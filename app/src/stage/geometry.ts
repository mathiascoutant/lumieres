import * as THREE from 'three';

import { Fixture, Mount, Placement, Stage } from '../types';

/**
 * Room coordinates in metres: x = 0 on the centre line, y = 0 on the hall floor,
 * z = 0 on the back wall of the stage, growing toward the audience.
 */

export interface Bar {
  mount: Mount;
  y: number;
  z: number;
  xMin: number;
  xMax: number;
}

const TBAR_LENGTH = 1.2;
const TBAR_RISE = 0.35;
/** Fixtures hang under the bars. */
const HANG = 0.22;

/** The three bars of the LT3: central bar, and the T on top of each tripod. */
export function trussBars(stage: Stage): Bar[] {
  const t = stage.truss;
  const y = stage.stageHeight + t.height;
  const half = t.width / 2;
  const tbar = (mount: Mount, cx: number): Bar => ({
    mount, y: y + TBAR_RISE, z: t.z, xMin: cx - TBAR_LENGTH / 2, xMax: cx + TBAR_LENGTH / 2,
  });
  return [
    { mount: 'truss', y, z: t.z, xMin: t.x - half, xMax: t.x + half },
    tbar('tbar-left', t.x - half),
    tbar('tbar-right', t.x + half),
  ];
}

export function floorHeight(stage: Stage, x: number, z: number): number {
  return z <= stage.stageDepth && Math.abs(x) <= stage.stageWidth / 2 ? stage.stageHeight : 0;
}

export function fixturePosition(p: Placement, stage: Stage, out = new THREE.Vector3()): THREE.Vector3 {
  if (p.mount === 'floor') return out.set(p.x, floorHeight(stage, p.x, p.z) + 0.2, p.z);
  const bar = trussBars(stage).find((b) => b.mount === p.mount)!;
  return out.set(THREE.MathUtils.clamp(p.x, bar.xMin, bar.xMax), bar.y - HANG, bar.z);
}

/** Tilt 0 points down, 90 toward the audience, 180 up. Pan turns around the vertical. */
export function aimDirection(tiltDeg: number, panDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const t = THREE.MathUtils.degToRad(tiltDeg);
  const p = THREE.MathUtils.degToRad(panDeg);
  return out.set(Math.sin(t) * Math.sin(p), -Math.cos(t), Math.sin(t) * Math.cos(p)).normalize();
}

/** A sensible starting aim once a fixture lands somewhere. */
export function defaultAim(mount: Mount, category: Fixture['category']): { tilt: number; pan: number } {
  if (category === 'fog') return { tilt: 90, pan: 0 };
  if (category === 'laser') return { tilt: 80, pan: 0 };
  return mount === 'floor' ? { tilt: 150, pan: 0 } : { tilt: 42, pan: 0 };
}

/** Where a new fixture lands: in the widest free space of the central bar, so that fixtures never stack up. */
export function placementForNew(stage: Stage, category: Fixture['category'], taken: Placement[]): Placement {
  if (category === 'fog') {
    const n = taken.filter((p) => p.mount === 'floor').length;
    const side = n % 2 ? 1 : -1;
    return { mount: 'floor', x: stage.truss.x + side * Math.ceil(n / 2) * 0.8, z: stage.truss.z + 0.8, ...defaultAim('floor', category) };
  }
  const bar = trussBars(stage)[0];
  const edges = taken.filter((p) => p.mount === 'truss').map((p) => p.x).sort((a, b) => a - b);
  if (edges.length === 0) return { mount: 'truss', x: (bar.xMin + bar.xMax) / 2, z: bar.z, ...defaultAim('truss', category) };
  const stops = [bar.xMin, ...edges, bar.xMax];
  let best = 0;
  let gap = -1;
  for (let i = 0; i + 1 < stops.length; i++) {
    if (stops[i + 1] - stops[i] > gap) {
      gap = stops[i + 1] - stops[i];
      best = i;
    }
  }
  return { mount: 'truss', x: (stops[best] + stops[best + 1]) / 2, z: bar.z, ...defaultAim('truss', category) };
}
