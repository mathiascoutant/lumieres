import * as THREE from 'three';

export const MAX_LIGHTS = 24;

/** Light data shared by every surface: one shader, one pass, no shadow maps. */
export const lightUniforms = {
  uCount: { value: 0 },
  uPos: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
  uDir: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3(0, -1, 0)) },
  uCol: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
  uCone: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector2(0.9, 0.95)) },
  uAmbient: { value: new THREE.Vector3(0.05, 0.05, 0.06) },
};

export const Pattern = { plain: 0, wood: 1, curtain: 2, wall: 3, deck: 4 } as const;

const surfaceVertex = /* glsl */ `
  varying vec3 vP;
  varying vec3 vN;
  void main() {
    vec4 p = vec4(position, 1.0);
    vec3 n = normal;
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
      n = mat3(instanceMatrix) * n;
    #endif
    vec4 w = modelMatrix * p;
    vP = w.xyz;
    vN = normalize(mat3(modelMatrix) * n);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const surfaceFragment = /* glsl */ `
  precision highp float;
  #define MAX_LIGHTS ${MAX_LIGHTS}
  uniform int uCount;
  uniform vec3 uPos[MAX_LIGHTS];
  uniform vec3 uDir[MAX_LIGHTS];
  uniform vec3 uCol[MAX_LIGHTS];
  uniform vec2 uCone[MAX_LIGHTS];
  uniform vec3 uAmbient;
  uniform vec3 uAlbedo;
  uniform vec3 uEmissive;
  uniform int uPattern;
  varying vec3 vP;
  varying vec3 vN;

  float hash(float x) { return fract(sin(x * 12.9898) * 43758.5453); }

  vec3 albedo() {
    if (uPattern == 1) {
      float row = floor(vP.z / 0.22);
      float board = floor((vP.x + hash(row) * 3.0) / 1.4);
      float tone = 0.82 + 0.3 * hash(row * 7.0 + board);
      float seam = smoothstep(0.0, 0.012, abs(fract(vP.z / 0.22) - 0.5) - 0.47);
      return uAlbedo * tone * (1.0 - 0.45 * seam);
    }
    if (uPattern == 2) {
      float folds = 0.62 + 0.38 * sin(vP.x * 9.0 + sin(vP.x * 2.3) * 1.6) + 0.0 * vP.z;
      return uAlbedo * folds;
    }
    if (uPattern == 3) {
      float wainscot = 1.0 - 0.32 * step(vP.y, 1.1);
      return uAlbedo * wainscot;
    }
    if (uPattern == 4) {
      float plate = smoothstep(0.0, 0.015, abs(fract(vP.x / 1.0) - 0.5) - 0.48)
                  + smoothstep(0.0, 0.015, abs(fract(vP.z / 2.0) - 0.5) - 0.49);
      return uAlbedo * (1.0 - 0.3 * min(plate, 1.0));
    }
    return uAlbedo;
  }

  void main() {
    vec3 n = normalize(vN);
    vec3 base = albedo();
    vec3 lit = uAmbient * (0.65 + 0.35 * n.y);
    for (int i = 0; i < uCount; i++) {
      vec3 toLight = uPos[i] - vP;
      float d = length(toLight);
      vec3 l = toLight / d;
      float spot = smoothstep(uCone[i].x, uCone[i].y, dot(-l, uDir[i]));
      if (spot <= 0.0) continue;
      float wrap = max(dot(n, l), 0.0);
      lit += uCol[i] * spot * wrap / (1.0 + 0.045 * d * d);
    }
    vec3 c = base * lit + uEmissive;
    c = 1.0 - exp(-c * 1.5);
    gl_FragColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
  }
`;

export function surfaceMaterial(albedo: number, pattern: number = Pattern.plain, emissive = 0x000000) {
  return new THREE.ShaderMaterial({
    vertexShader: surfaceVertex,
    fragmentShader: surfaceFragment,
    uniforms: {
      ...lightUniforms,
      uAlbedo: { value: toLinear(albedo) },
      uEmissive: { value: toLinear(emissive) },
      uPattern: { value: pattern },
    },
  });
}

function toLinear(hex: number) {
  const c = new THREE.Color(hex); // three converts sRGB hex to linear working space
  return new THREE.Vector3(c.r, c.g, c.b);
}

/** Visible beam in the haze: bright at the lens, fading along its length and at its edges. */
export function beamMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Vector3() }, uStrength: { value: 0 } },
    vertexShader: /* glsl */ `
      varying float vT;
      varying float vEdge;
      void main() {
        vT = -position.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vEdge = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uColor;
      uniform float uStrength;
      varying float vT;
      varying float vEdge;
      void main() {
        float a = uStrength * pow(1.0 - clamp(vT, 0.0, 1.0), 1.7) * smoothstep(0.0, 0.8, vEdge);
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
}

/** Flat additive colour, for lenses and laser rays. */
export function glowMaterial(side: THREE.Side = THREE.FrontSide) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Vector3() }, uStrength: { value: 0 } },
    vertexShader: /* glsl */ `
      varying float vT;
      void main() {
        vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        vT = position.y;
        gl_Position = projectionMatrix * modelViewMatrix * p;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uColor;
      uniform float uStrength;
      varying float vT;
      void main() {
        gl_FragColor = vec4(uColor, uStrength * (1.0 - 0.75 * clamp(vT, 0.0, 1.0)));
      }
    `,
  });
}

/** Soft smoke sprites. */
export function smokeMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uColor: { value: new THREE.Vector3(0.6, 0.6, 0.65) }, uScale: { value: 300 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aAlpha;
      uniform float uScale;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / max(-mv.z, 0.5);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = vAlpha * smoothstep(1.0, 0.1, d);
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
}
