import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { Channel, Fixture } from '../types';

/** Fixture geometry: `base` stays with the mount, `head` turns with the aim (beam along -Y). */
export interface ModelParts {
  base: THREE.BufferGeometry | null;
  head: THREE.BufferGeometry;
  lens: THREE.BufferGeometry;
  /** Distance from the fixture origin to the lens, along the beam. */
  lensOffset: number;
}

const merged = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts.map((p) => p.toNonIndexed()));
const cylinder = (r: number, h: number, y = 0) => new THREE.CylinderGeometry(r, r, h, 20).translate(0, y, 0);
const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const disc = (r: number, y: number) => new THREE.CircleGeometry(r, 24).rotateX(Math.PI / 2).translate(0, y, 0);

export function buildModel(category: Fixture['category']): ModelParts {
  switch (category) {
    case 'bar':
      return {
        base: box(0.05, 0.1, 0.05, 0, 0.1, 0),
        head: box(1, 0.09, 0.11),
        lens: new THREE.PlaneGeometry(0.94, 0.08).rotateX(Math.PI / 2).translate(0, -0.047, 0),
        lensOffset: 0.05,
      };
    case 'moving':
      return {
        base: box(0.28, 0.1, 0.28, 0, 0.13, 0),
        head: merged([cylinder(0.11, 0.26, -0.03), box(0.28, 0.06, 0.06, 0, 0.08, 0)]),
        lens: disc(0.09, -0.161),
        lensOffset: 0.16,
      };
    case 'wash':
      return { base: box(0.05, 0.1, 0.05, 0, 0.12, 0), head: cylinder(0.15, 0.2), lens: disc(0.135, -0.101), lensOffset: 0.1 };
    case 'strobe':
      return { base: box(0.05, 0.1, 0.05, 0, 0.11, 0), head: box(0.38, 0.1, 0.16), lens: new THREE.PlaneGeometry(0.34, 0.13).rotateX(Math.PI / 2).translate(0, -0.051, 0), lensOffset: 0.05 };
    case 'laser':
      return { base: box(0.05, 0.08, 0.05, 0, 0.12, 0), head: box(0.24, 0.17, 0.2), lens: disc(0.025, -0.086), lensOffset: 0.09 };
    case 'fog':
      return {
        base: box(0.46, 0.26, 0.26, 0, -0.07, 0),
        head: cylinder(0.04, 0.1, -0.05).translate(0, -0.2, 0),
        lens: disc(0.032, -0.31),
        lensOffset: 0.31,
      };
    default:
      return { base: box(0.05, 0.1, 0.05, 0, 0.13, 0), head: cylinder(0.105, 0.26), lens: disc(0.09, -0.131), lensOffset: 0.13 };
  }
}

export interface FixtureOutput {
  /** Light colour multiplied by intensity, linear. */
  r: number;
  g: number;
  b: number;
  intensity: number;
  /** -1 to 1 around the channel centre, for pan and tilt. */
  pan: number;
  tilt: number;
  fog: number;
  pattern: number;
  speed: number;
  hasMotion: boolean;
}

type ChannelIndex = Partial<Record<Channel['type'], number>>;

export function indexChannels(f: Fixture): ChannelIndex {
  const out: ChannelIndex = {};
  f.channels.forEach((c, i) => {
    if (out[c.type] === undefined) out[c.type] = i;
  });
  return out;
}

const LASER_COLORS: [number, number, number][] = [
  [0.1, 1, 0.2], [1, 0.05, 0.05], [1, 0.8, 0.05], [0.1, 0.3, 1], [0.1, 1, 1], [1, 0.1, 0.9], [1, 1, 1],
];

function shutter(c: Channel | undefined, v: number, time: number): number {
  if (!c) return 1;
  let kind: string | undefined;
  let from = 10;
  let to = 255;
  if (c.ranges?.length) {
    const range = c.ranges.find((r) => v >= r.from && v <= r.to);
    kind = range?.kind;
    if (range) ({ from, to } = range);
  } else {
    kind = v < 10 ? 'open' : 'strobe';
  }
  if (kind === 'closed') return 0;
  if (kind !== 'strobe') return 1;
  const hz = 2 + ((v - from) / Math.max(1, to - from)) * 16;
  return (time * hz) % 1 < 0.25 ? 1 : 0;
}

/** Reads what a fixture is really doing from the DMX values that went out. */
export function readOutput(f: Fixture, idx: ChannelIndex, frame: Uint8Array, time: number, out: FixtureOutput): FixtureOutput {
  const raw = (i: number | undefined) => (i === undefined ? 0 : frame[f.address - 1 + i] ?? 0);
  const value = (t: Channel['type']) => raw(idx[t]) / 255;

  const white = value('white');
  const amber = value('amber');
  const uv = value('uv');
  let r = value('red') + white + amber;
  let g = value('green') + white + amber * 0.55;
  let b = value('blue') + white + uv * 0.6;
  r += uv * 0.25;

  const hasColor = idx.red !== undefined || idx.green !== undefined || idx.blue !== undefined ||
    idx.white !== undefined || idx.amber !== undefined || idx.uv !== undefined;
  const hasDimmer = idx.dimmer !== undefined;
  let level = hasDimmer ? value('dimmer') : 1;

  out.pattern = raw(idx.pattern);
  out.speed = value('speed');
  out.pan = idx.pan !== undefined ? value('pan') * 2 - 1 : 0;
  out.tilt = idx.tilt !== undefined ? value('tilt') * 2 - 1 : 0;
  out.hasMotion = idx.pan !== undefined || idx.tilt !== undefined;
  out.fog = value('fog');

  if (f.category === 'laser') {
    const on = hasDimmer ? level > 0 : raw(idx.mode) > 0 || raw(idx.pattern) > 0 || r + g + b > 0;
    level = on ? Math.max(level, hasDimmer ? level : 1) : 0;
    if (r + g + b === 0) {
      const macro = idx.color !== undefined ? Math.floor(raw(idx.color) / 37) % LASER_COLORS.length : 0;
      [r, g, b] = LASER_COLORS[macro];
    }
  } else if (!hasColor) {
    // A dimmer-only or colour-wheel fixture: warm white, or a strobe tube's cold white.
    const warm = f.category === 'strobe' ? [1, 1, 1] : [1, 0.86, 0.68];
    [r, g, b] = warm;
    if (!hasDimmer) level = 0;
  }

  const stepChannel = idx.strobe !== undefined ? f.channels[idx.strobe] : undefined;
  level *= shutter(stepChannel, raw(idx.strobe), time);
  out.r = r * level;
  out.g = g * level;
  out.b = b * level;
  out.intensity = Math.max(out.r, out.g, out.b);
  return out;
}
