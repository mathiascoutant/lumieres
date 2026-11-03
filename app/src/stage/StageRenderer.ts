import { ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

import { Fixture, Placement, Stage } from '../types';
import { buildModel, FixtureOutput, indexChannels, readOutput } from './fixtureModel';
import { aimDirection, defaultAim, fixturePosition, trussBars } from './geometry';
import { beamMaterial, glowMaterial, lightUniforms, MAX_LIGHTS, smokeMaterial, surfaceMaterial } from './materials';
import { buildRoom } from './room';

export type ViewPreset = 'front' | 'top' | 'left' | 'right';

const PRESETS: Record<ViewPreset, { az: number; el: number }> = {
  front: { az: 0, el: 9 },
  top: { az: 0, el: 62 },
  left: { az: -58, el: 20 },
  right: { az: 58, el: 20 },
};

const BEAM_LENGTH = 16;
const SMOKE_PARTICLES = 140;
const LASER_RAYS = 14;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
/** Dragging within this many points of a bar snaps the fixture onto it. */
const SNAP_DISTANCE = 44;

const beamGeometry = new THREE.ConeGeometry(1, 1, 28, 1, true).translate(0, -0.5, 0);
const rayGeometry = new THREE.CylinderGeometry(0.03, 0.005, 1, 4, 1, true).translate(0, 0.5, 0);
const ringGeometry = new THREE.RingGeometry(0.3, 0.335, 40);

interface FixtureNode {
  fixture: Fixture;
  channels: ReturnType<typeof indexChannels>;
  group: THREE.Group;
  head: THREE.Mesh;
  lens: THREE.Mesh;
  lensMaterial: THREE.ShaderMaterial;
  beam: THREE.Mesh | null;
  beamMaterial: THREE.ShaderMaterial | null;
  lensOffset: number;
  rays: THREE.InstancedMesh | null;
  rayMaterial: THREE.ShaderMaterial | null;
  output: FixtureOutput;
  emitAcc: number;
  key: string;
  base: THREE.Mesh | null;
}

export class StageRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 80);
  private room: THREE.Group | null = null;
  private stage: Stage | null = null;
  private nodes = new Map<string, FixtureNode>();
  private bodyMaterial = surfaceMaterial(0x1d1f25);
  private ring = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, side: THREE.DoubleSide, depthTest: false }));
  private selection: string[] = [];
  private width = 1;
  private height = 1;
  private az = PRESETS.front.az;
  private el = PRESETS.front.el;
  private zoom = 1;
  private target = new THREE.Vector3(0, 2.4, 3);
  private insets = { top: 0, left: 0, right: 0, bottom: 0 };
  private haze = 0;
  private smoke: {
    points: THREE.Points;
    position: Float32Array;
    size: Float32Array;
    alpha: Float32Array;
    velocity: Float32Array;
    life: Float32Array;
    next: number;
  };
  private lastTime = 0;
  private temp = new THREE.Vector3();
  private temp2 = new THREE.Vector3();
  private projected = new THREE.Vector3();

  constructor(private gl: ExpoWebGLRenderingContext) {
    // three logs a warning on every texture parameter expo-gl does not implement.
    const pixelStorei = gl.pixelStorei.bind(gl);
    gl.pixelStorei = (pname: number, param: number | boolean) => {
      if (pname === gl.UNPACK_FLIP_Y_WEBGL) pixelStorei(pname, param as number);
    };
    const canvas = {
      width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, style: {}, clientHeight: gl.drawingBufferHeight,
      addEventListener() {}, removeEventListener() {}, getContext: () => gl,
    };
    // The context goes through getContext: three rejects any context passed directly that
    // is an instance of WebGLRenderingContext, the class expo-gl uses for its WebGL2 context.
    this.renderer = new THREE.WebGLRenderer({ canvas: canvas as unknown as HTMLCanvasElement });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x050608, 1);
    this.scene.add(this.ring);
    this.ring.visible = false;
    this.ring.renderOrder = 10;
    this.smoke = this.buildSmoke();
    this.scene.add(this.smoke.points);
  }

  private buildSmoke() {
    const position = new Float32Array(SMOKE_PARTICLES * 3).fill(-100);
    const size = new Float32Array(SMOKE_PARTICLES);
    const alpha = new Float32Array(SMOKE_PARTICLES);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    const points = new THREE.Points(geometry, smokeMaterial());
    points.frustumCulled = false;
    points.renderOrder = 5;
    return { points, position, size, alpha, velocity: new Float32Array(SMOKE_PARTICLES * 3), life: new Float32Array(SMOKE_PARTICLES), next: 0 };
  }

  /** Size in points, and in physical pixels of the drawing buffer. */
  setSize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const w = this.gl.drawingBufferWidth;
    const h = this.gl.drawingBufferHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = this.width / this.height;
    this.applyInsets();
    (this.smoke.points.material as THREE.ShaderMaterial).uniforms.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.updateCamera();
  }

  setStage(stage: Stage) {
    const same = this.stage && JSON.stringify({ ...this.stage, houseLights: 0 }) === JSON.stringify({ ...stage, houseLights: 0 });
    this.stage = stage;
    if (!same) {
      if (this.room) {
        this.scene.remove(this.room);
        this.room.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
      }
      this.room = buildRoom(stage);
      this.scene.add(this.room);
      this.target.set(0, stage.stageHeight + 1.7, stage.stageDepth * 0.6);
      this.updateCamera();
    }
    this.nodes.forEach((n) => this.placeNode(n));
  }

  setFixtures(fixtures: Fixture[]) {
    const seen = new Set<string>();
    for (const f of fixtures) {
      seen.add(f.id);
      const key = `${f.category}|${f.channels.map((c) => c.type).join(',')}|${f.beamAngle}`;
      let node = this.nodes.get(f.id);
      if (node && node.key !== key) {
        this.removeNode(node);
        node = undefined;
      }
      if (!node) {
        node = this.createNode(f, key);
        this.nodes.set(f.id, node);
      }
      node.fixture = f;
      node.channels = indexChannels(f);
      this.placeNode(node);
    }
    this.nodes.forEach((n, id) => {
      if (!seen.has(id)) {
        this.removeNode(n);
        this.nodes.delete(id);
      }
    });
  }

  setSelection(ids: string[]) {
    this.selection = ids;
  }

  private removeNode(n: FixtureNode) {
    this.scene.remove(n.group);
    n.lensMaterial.dispose();
    n.beamMaterial?.dispose();
    n.rayMaterial?.dispose();
    n.rays?.dispose();
  }

  private createNode(f: Fixture, key: string): FixtureNode {
    const parts = buildModel(f.category);
    const group = new THREE.Group();
    const base = parts.base ? new THREE.Mesh(parts.base, this.bodyMaterial) : null;
    if (base) group.add(base);
    const head = new THREE.Mesh(parts.head, this.bodyMaterial);
    group.add(head);
    const lensMaterial = glowMaterial(THREE.DoubleSide);
    const lens = new THREE.Mesh(parts.lens, lensMaterial);
    head.add(lens);

    let beam: THREE.Mesh | null = null;
    let beamMat: THREE.ShaderMaterial | null = null;
    if (f.category !== 'fog' && f.category !== 'laser') {
      beamMat = beamMaterial();
      beam = new THREE.Mesh(beamGeometry, beamMat);
      beam.frustumCulled = false;
      const radius = Math.tan(THREE.MathUtils.degToRad(f.beamAngle / 2)) * BEAM_LENGTH;
      beam.scale.set(radius, BEAM_LENGTH, radius);
      beam.position.y = -parts.lensOffset;
      beam.visible = false;
      beam.renderOrder = 2;
      head.add(beam);
    }

    let rays: THREE.InstancedMesh | null = null;
    let rayMat: THREE.ShaderMaterial | null = null;
    if (f.category === 'laser') {
      rayMat = glowMaterial(THREE.DoubleSide);
      rays = new THREE.InstancedMesh(rayGeometry, rayMat, LASER_RAYS);
      rays.frustumCulled = false;
      rays.visible = false;
      rays.renderOrder = 3;
      this.scene.add(rays);
    }

    this.scene.add(group);
    return {
      fixture: f, channels: indexChannels(f), group, head, lens, lensMaterial, beam, beamMaterial: beamMat,
      lensOffset: parts.lensOffset, rays, rayMaterial: rayMat, base, emitAcc: 0, key,
      output: { r: 0, g: 0, b: 0, intensity: 0, pan: 0, tilt: 0, fog: 0, pattern: 0, speed: 0, hasMotion: false },
    };
  }

  private placeNode(n: FixtureNode) {
    if (!this.stage) return;
    fixturePosition(n.fixture.placement, this.stage, n.group.position);
  }

  /* ---- Camera ---- */

  /** Keeps the stage centred in the part of the screen the floating panels leave free. */
  setInsets(insets: { top: number; left: number; right: number; bottom: number }) {
    this.insets = insets;
    this.applyInsets();
    this.updateCamera();
  }

  private applyInsets() {
    const { top, left, right, bottom } = this.insets;
    this.camera.setViewOffset(this.width, this.height, (right - left) / 2, (bottom - top) / 2, this.width, this.height);
  }

  private updateCamera() {
    const halfW = (this.stage?.stageWidth ?? 10) / 2 + 1;
    const halfH = 3.1;
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const { top, left, right, bottom } = this.insets;
    const freeHeight = Math.max(0.2, (this.height - top - bottom) / this.height);
    const freeWidth = Math.max(0.2, (this.width - left - right) / this.width);
    const fit = Math.max(halfH / (tan * freeHeight), halfW / (tan * this.camera.aspect * freeWidth));
    const dist = fit * this.zoom;
    const az = THREE.MathUtils.degToRad(this.az);
    const el = THREE.MathUtils.degToRad(this.el);
    this.camera.position.set(
      this.target.x + dist * Math.sin(az) * Math.cos(el),
      this.target.y + dist * Math.sin(el),
      this.target.z + dist * Math.cos(az) * Math.cos(el),
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  saveView() {
    return { az: this.az, el: this.el, zoom: this.zoom, target: this.target.clone() };
  }

  restoreView(v: ReturnType<StageRenderer['saveView']>) {
    this.az = v.az;
    this.el = v.el;
    this.zoom = v.zoom;
    this.target.copy(v.target);
    this.updateCamera();
  }

  setPreset(p: ViewPreset) {
    this.az = PRESETS[p].az;
    this.el = PRESETS[p].el;
    this.zoom = 1;
    if (this.stage) this.target.set(0, this.stage.stageHeight + 1.7, this.stage.stageDepth * 0.6);
    this.updateCamera();
  }

  orbit(dx: number, dy: number) {
    this.az = THREE.MathUtils.clamp(this.az - dx * 0.3, -110, 110);
    this.el = THREE.MathUtils.clamp(this.el + dy * 0.25, 2, 85);
    this.updateCamera();
  }

  zoomBy(factor: number) {
    this.zoom = THREE.MathUtils.clamp(this.zoom / factor, 0.25, 1.6);
    this.updateCamera();
  }

  panBy(dx: number, dy: number) {
    const dist = this.camera.position.distanceTo(this.target);
    const scale = (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.height;
    const right = this.temp.setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = this.temp2.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
    if (this.stage) {
      this.target.x = THREE.MathUtils.clamp(this.target.x, -this.stage.roomWidth / 2, this.stage.roomWidth / 2);
      this.target.y = THREE.MathUtils.clamp(this.target.y, 0.3, this.stage.roomHeight);
      this.target.z = THREE.MathUtils.clamp(this.target.z, 0, this.stage.roomLength);
    }
    this.updateCamera();
  }

  /* ---- Picking and placing ---- */

  private toScreen(p: THREE.Vector3): { x: number; y: number; visible: boolean } {
    this.projected.copy(p).project(this.camera);
    return {
      x: ((this.projected.x + 1) / 2) * this.width,
      y: ((1 - this.projected.y) / 2) * this.height,
      visible: this.projected.z < 1,
    };
  }

  /** Nearest fixture to a touch, with a tolerance that suits a finger. */
  pick(x: number, y: number, tolerance = 40): string | null {
    let best: string | null = null;
    let bestD = tolerance;
    this.nodes.forEach((n, id) => {
      const s = this.toScreen(n.group.position);
      if (!s.visible) return;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    });
    return best;
  }

  screenOf(id: string) {
    const n = this.nodes.get(id);
    return n ? this.toScreen(n.group.position) : null;
  }

  /** New placement for a fixture dragged under the finger: snapped onto a bar, or on the floor. */
  dragTo(id: string, x: number, y: number): Placement | null {
    const n = this.nodes.get(id);
    if (!n || !this.stage) return null;
    const f = n.fixture;
    const previous = f.placement;

    if (f.category !== 'fog') {
      let bestBar = null;
      let bestT = 0;
      let bestD = SNAP_DISTANCE;
      for (const bar of trussBars(this.stage)) {
        const a = this.toScreen(this.temp.set(bar.xMin, bar.y, bar.z));
        const b = this.toScreen(this.temp2.set(bar.xMax, bar.y, bar.z));
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = THREE.MathUtils.clamp(((x - a.x) * dx + (y - a.y) * dy) / Math.max(1, dx * dx + dy * dy), 0, 1);
        const d = Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
        if (d < bestD) {
          bestD = d;
          bestBar = bar;
          bestT = t;
        }
      }
      if (bestBar) {
        const aim = previous.mount === 'floor' ? defaultAim(bestBar.mount, f.category) : { tilt: previous.tilt, pan: previous.pan };
        return { mount: bestBar.mount, x: bestBar.xMin + (bestBar.xMax - bestBar.xMin) * bestT, z: bestBar.z, ...aim };
      }
    }

    // Otherwise the finger points at the floor: the stage deck first, then the hall.
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, 1 - (y / this.height) * 2);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    const s = this.stage;
    for (const level of [s.stageHeight, 0]) {
      if (!ray.ray.intersectPlane(new THREE.Plane(Y_AXIS, -level), hit)) continue;
      const onStage = hit.z <= s.stageDepth && Math.abs(hit.x) <= s.stageWidth / 2;
      if (level > 0 && !onStage) continue;
      const aim = previous.mount !== 'floor' ? defaultAim('floor', f.category) : { tilt: previous.tilt, pan: previous.pan };
      return {
        mount: 'floor',
        x: THREE.MathUtils.clamp(hit.x, -s.roomWidth / 2 + 0.3, s.roomWidth / 2 - 0.3),
        z: THREE.MathUtils.clamp(hit.z, 0.3, s.roomLength - 0.3),
        ...aim,
      };
    }
    return null;
  }

  /* ---- Frame ---- */

  render(timeMs: number, frame: Uint8Array) {
    if (!this.stage) return;
    const time = timeMs / 1000;
    const dt = Math.min(0.1, this.lastTime ? time - this.lastTime : 0.016);
    this.lastTime = time;

    const lights = lightUniforms;
    let count = 0;
    let bounceR = 0;
    let bounceG = 0;
    let bounceB = 0;
    let smokeOn = false;

    this.nodes.forEach((n) => {
      const out = readOutput(n.fixture, n.channels, frame, time, n.output);
      const p = n.fixture.placement;
      const isMover = n.fixture.category === 'moving';
      const isLaser = n.fixture.category === 'laser';
      const swing = isMover ? { pan: 270, tilt: 135 } : isLaser ? { pan: 22, tilt: 18 } : { pan: 0, tilt: 0 };
      const dir = aimDirection(p.tilt + out.tilt * swing.tilt, p.pan + out.pan * swing.pan, this.temp);
      n.head.quaternion.setFromUnitVectors(DOWN, dir);

      const lit = out.intensity > 0.004;
      n.lensMaterial.uniforms.uColor.value.set(Math.min(1, out.r), Math.min(1, out.g), Math.min(1, out.b));
      n.lensMaterial.uniforms.uStrength.value = lit ? 1 : 0;

      if (n.beam && n.beamMaterial) {
        n.beam.visible = lit;
        if (lit) {
          n.beamMaterial.uniforms.uColor.value.set(Math.min(1, out.r), Math.min(1, out.g), Math.min(1, out.b));
          n.beamMaterial.uniforms.uStrength.value = 0.1 + 0.42 * this.haze;
        }
        if (lit && count < MAX_LIGHTS) {
          const half = THREE.MathUtils.degToRad(n.fixture.beamAngle / 2);
          lights.uPos.value[count].copy(n.group.position).addScaledVector(dir, n.lensOffset);
          lights.uDir.value[count].copy(dir);
          lights.uCol.value[count].set(out.r * 9, out.g * 9, out.b * 9);
          lights.uCone.value[count].set(Math.cos(half * 1.12), Math.cos(half * 0.72));
          count++;
          bounceR += out.r;
          bounceG += out.g;
          bounceB += out.b;
        }
      }
      if (n.rays && n.rayMaterial) this.updateLaser(n, dir, out, time);
      if (out.fog > 0.01 && n.fixture.category === 'fog') {
        smokeOn = true;
        this.emitSmoke(n, dir, out.fog, dt);
      }
    });

    lights.uCount.value = count;
    const ambient = 0.06 + this.stage.houseLights * 0.9;
    lights.uAmbient.value.set(ambient + bounceR * 0.012, ambient + bounceG * 0.012, ambient * 1.04 + bounceB * 0.012);

    this.updateSmoke(dt, bounceR, bounceG, bounceB, ambient);
    this.haze = smokeOn ? Math.min(1, this.haze + dt * 0.35) : Math.max(0, this.haze - dt * 0.04);
    this.updateRing();

    this.renderer.render(this.scene, this.camera);
    this.gl.endFrameEXP();
    // A synchronous call waits for the GL thread. Without it, a slow GPU queues frames
    // endlessly: the picture falls seconds behind the lights and the UI stops responding.
    this.gl.getError();
  }

  private updateLaser(n: FixtureNode, dir: THREE.Vector3, out: FixtureOutput, time: number) {
    const rays = n.rays!;
    const on = out.intensity > 0.004;
    rays.visible = on;
    if (!on) return;
    n.rayMaterial!.uniforms.uColor.value.set(Math.min(1, out.r), Math.min(1, out.g), Math.min(1, out.b));
    n.rayMaterial!.uniforms.uStrength.value = 0.55 + 0.45 * this.haze;

    const origin = this.temp2.copy(n.group.position).addScaledVector(dir, n.lensOffset);
    const right = new THREE.Vector3().crossVectors(dir, Y_AXIS).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    const figure = Math.floor(out.pattern / 32) % 4;
    const phase = time * (0.5 + out.speed * 3);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 15, 1);
    const ray = new THREE.Vector3();
    for (let i = 0; i < LASER_RAYS; i++) {
      const t = i / (LASER_RAYS - 1) - 0.5;
      let a = 0;
      let b = 0;
      if (figure === 0) { a = t * 0.9; b = Math.sin(phase) * 0.2; }
      else if (figure === 1) { a = Math.sin(phase) * 0.45; b = t * 0.8; }
      else if (figure === 2) { const w = i * 0.449 + phase; a = Math.cos(w) * 0.32; b = Math.sin(w) * 0.32; }
      else { a = i % 2 ? t * 0.9 : Math.sin(phase) * 0.4; b = i % 2 ? Math.sin(phase) * 0.3 : t * 0.9; }
      ray.copy(dir).addScaledVector(right, a).addScaledVector(up, b).normalize();
      q.setFromUnitVectors(Y_AXIS, ray);
      m.compose(origin, q, scale);
      rays.setMatrixAt(i, m);
    }
    rays.instanceMatrix.needsUpdate = true;
  }

  private emitSmoke(n: FixtureNode, dir: THREE.Vector3, level: number, dt: number) {
    const s = this.smoke;
    n.emitAcc += level * 26 * dt;
    while (n.emitAcc >= 1) {
      n.emitAcc -= 1;
      const i = s.next;
      s.next = (s.next + 1) % SMOKE_PARTICLES;
      const j = i * 3;
      s.position[j] = n.group.position.x + dir.x * 0.3;
      s.position[j + 1] = n.group.position.y + dir.y * 0.3 - 0.05;
      s.position[j + 2] = n.group.position.z + dir.z * 0.3;
      const spread = 0.35;
      s.velocity[j] = dir.x * 1.7 + (Math.random() - 0.5) * spread;
      s.velocity[j + 1] = dir.y * 1.7 + (Math.random() - 0.3) * spread;
      s.velocity[j + 2] = dir.z * 1.7 + (Math.random() - 0.5) * spread;
      s.life[i] = 1;
      s.size[i] = 0.35;
    }
  }

  private updateSmoke(dt: number, r: number, g: number, b: number, ambient: number) {
    const s = this.smoke;
    let active = false;
    for (let i = 0; i < SMOKE_PARTICLES; i++) {
      if (s.life[i] <= 0) {
        s.alpha[i] = 0;
        continue;
      }
      active = true;
      const j = i * 3;
      s.life[i] -= dt / 7;
      const drag = Math.exp(-dt * 0.7);
      s.velocity[j] *= drag;
      s.velocity[j + 1] = s.velocity[j + 1] * drag + dt * 0.03;
      s.velocity[j + 2] *= drag;
      s.position[j] += s.velocity[j] * dt;
      s.position[j + 1] = Math.max(0.05, s.position[j + 1] + s.velocity[j + 1] * dt);
      s.position[j + 2] += s.velocity[j + 2] * dt;
      s.size[i] += dt * 0.28;
      s.alpha[i] = Math.max(0, s.life[i]) * 0.13;
    }
    const g2 = s.points.geometry;
    if (active) {
      g2.attributes.position.needsUpdate = true;
      (g2.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
      (g2.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
      const level = 0.3 + ambient * 2;
      const m = Math.max(1, r, g, b);
      (s.points.material as THREE.ShaderMaterial).uniforms.uColor.value.set(level + (r / m) * 0.5, level + (g / m) * 0.5, level + (b / m) * 0.5);
    }
    s.points.visible = active;
  }

  private updateRing() {
    const id = this.selection[0];
    const n = id ? this.nodes.get(id) : undefined;
    this.ring.visible = !!n;
    if (n) {
      this.ring.position.copy(n.group.position);
      this.ring.quaternion.copy(this.camera.quaternion);
    }
  }
}

