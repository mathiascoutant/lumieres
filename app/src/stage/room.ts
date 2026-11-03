import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { Stage } from '../types';
import { Pattern, surfaceMaterial } from './materials';

function plane(w: number, h: number, material: THREE.Material, pos: [number, number, number], rot: [number, number, number]) {
  // Finely subdivided because a triangle reaching behind the camera can vanish entirely on
  // some GPUs: small enough, the ones that do are out of the field of view anyway.
  const segments = (size: number) => Math.max(1, Math.ceil(size / 0.5));
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h, segments(w), segments(h)), material);
  mesh.position.set(...pos);
  mesh.rotation.set(...rot);
  return mesh;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

/** A cylinder between two points, for building tubes. */
export function tube(a: THREE.Vector3, b: THREE.Vector3, r: number, sides = 8) {
  const dir = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r, r, dir.length(), sides, 1, false);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  const mid = a.clone().add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

/** The BoomTone DJ LT3: two tripods, a 3 m ladder bar between them, a T-bar on each top. */
function buildTruss(stage: Stage): THREE.BufferGeometry {
  const { x, z, height, width } = stage.truss;
  const floor = stage.stageHeight;
  const top = floor + height;
  const half = width / 2;
  const v = (a: number, b: number, c: number) => new THREE.Vector3(a, b, c);
  const parts: THREE.BufferGeometry[] = [];

  for (const side of [-1, 1]) {
    const mx = x + side * half;
    parts.push(tube(v(mx, floor + 0.55, z), v(mx, top + 0.35, z), 0.024));
    // Tripod legs and braces.
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2 + Math.PI / 6;
      const fx = mx + Math.cos(angle) * 0.72;
      const fz = z + Math.sin(angle) * 0.72;
      parts.push(tube(v(mx, floor + 0.85, z), v(fx, floor + 0.015, fz), 0.018));
      parts.push(tube(v(mx, floor + 0.45, z), v(mx + Math.cos(angle) * 0.4, floor + 0.24, z + Math.sin(angle) * 0.4), 0.011));
    }
    // T-bar on top of the mast.
    parts.push(tube(v(mx - 0.6, top + 0.35, z), v(mx + 0.6, top + 0.35, z), 0.02));
    parts.push(box(0.1, 0.1, 0.1, mx, top + 0.35, z));
    parts.push(box(0.1, 0.34, 0.09, mx, top - 0.14, z));
  }
  // Ladder bar.
  const lowY = top - 0.3;
  const x0 = x - half;
  const x1 = x + half;
  parts.push(tube(v(x0, top, z), v(x1, top, z), 0.019));
  parts.push(tube(v(x0, lowY, z), v(x1, lowY, z), 0.019));
  const rungs = Math.round(width / 0.28);
  for (let i = 0; i <= rungs; i++) {
    const a = x0 + (i / rungs) * width;
    parts.push(tube(v(a, lowY, z), v(a, top, z), 0.008, 5));
    if (i < rungs) {
      const b = x0 + ((i + 1) / rungs) * width;
      parts.push(i % 2 ? tube(v(a, lowY, z), v(b, top, z), 0.007, 5) : tube(v(a, top, z), v(b, lowY, z), 0.007, 5));
    }
  }
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

function buildTables(stage: Stage) {
  const parts: THREE.BufferGeometry[] = [];
  // Two blocks of tables with a central aisle, so that nothing hides the stage.
  const outer = stage.roomWidth / 2 - 1.5;
  const inner = Math.min(outer, 2.7);
  for (let z = stage.stageDepth + 3.6; z < stage.roomLength - 6; z += 3.6) {
    for (const x of [-outer, -inner, inner, outer]) {
      parts.push(new THREE.CylinderGeometry(0.85, 0.85, 0.04, 28).translate(x, 0.76, z).toNonIndexed());
      parts.push(new THREE.CylinderGeometry(0.85, 0.92, 0.72, 28, 1, true).translate(x, 0.38, z).toNonIndexed());
    }
  }
  return new THREE.Mesh(mergeGeometries(parts), surfaceMaterial(0x8e8c86));
}

/** Builds the village hall facing its stage. */
export function buildRoom(stage: Stage): THREE.Group {
  const group = new THREE.Group();
  const { roomWidth: W, roomLength: L, roomHeight: H, stageWidth: SW, stageDepth: SD, stageHeight: SH } = stage;
  const cz = L / 2;

  const wall = surfaceMaterial(0x8d8a84, Pattern.wall);
  group.add(plane(W, L, surfaceMaterial(0x8a5f3a, Pattern.wood), [0, 0, cz], [-Math.PI / 2, 0, 0]));
  group.add(plane(W, L, surfaceMaterial(0x4e4d4b), [0, H, cz], [Math.PI / 2, 0, 0]));
  group.add(plane(W, H, wall, [0, H / 2, 0], [0, 0, 0]));
  group.add(plane(L, H, wall, [-W / 2, H / 2, cz], [0, Math.PI / 2, 0]));
  group.add(plane(L, H, wall, [W / 2, H / 2, cz], [0, -Math.PI / 2, 0]));

  // Stage platform.
  const deck = surfaceMaterial(0x2e3038, Pattern.deck);
  group.add(plane(SW, SD, deck, [0, SH, SD / 2], [-Math.PI / 2, 0, 0]));
  group.add(plane(SW, SH, surfaceMaterial(0x17181c), [0, SH / 2, SD], [0, 0, 0]));
  for (const side of [-1, 1]) {
    group.add(plane(SD, SH, surfaceMaterial(0x17181c), [(side * SW) / 2, SH / 2, SD / 2], [0, (side * Math.PI) / 2, 0]));
  }

  // Backdrop and side curtains.
  const curtain = surfaceMaterial(0x2c2f45, Pattern.curtain);
  const curtainH = H - SH;
  group.add(plane(SW, curtainH, curtain, [0, SH + curtainH / 2, 0.06], [0, 0, 0]));
  const wing = 1.1;
  for (const side of [-1, 1]) {
    group.add(plane(wing, curtainH, curtain, [(side * (SW - wing)) / 2, SH + curtainH / 2, SD - 0.05], [0, 0, 0]));
  }
  // Valance above the stage opening.
  group.add(plane(SW, 0.9, curtain, [0, H - 0.45, SD - 0.04], [0, 0, 0]));

  group.add(new THREE.Mesh(buildTruss(stage), surfaceMaterial(0x8a8d96)));
  group.add(buildTables(stage));
  return group;
}
