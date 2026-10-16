import {
  AdditiveBlending,
  Color,
  NormalBlending,
  ShaderMaterial,
  type ColorRepresentation,
} from 'three';

/**
 * Quads instanciés à dégradé radial (aucune texture) : ombres blob au sol et halos de néons.
 * `instanceMatrix` / `instanceColor` sont déclarés par three.js pour un InstancedMesh.
 */
const VERTEX = /* glsl */ `
  attribute vec2 aBlink;
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec2 vBlink;
  void main() {
    vUv = uv;
    vBlink = aBlink;
    vColor = vec3(1.0);
    #ifdef USE_INSTANCING_COLOR
      vColor = instanceColor;
    #endif
    vec4 p = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * p;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uBoost;
  uniform float uTime;
  uniform float uInner;
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec2 vBlink;
  void main() {
    float d = length(vUv * 2.0 - 1.0);
    float a = uOpacity * (1.0 - smoothstep(uInner, 1.0, d));
    // gyrophares : clignotement par instance (fréquence, phase), sans lumière
    if (vBlink.x > 0.0) a *= 0.5 + 0.5 * sin(uTime * vBlink.x * 6.2831853 + vBlink.y);
    if (a <= 0.003) discard;
    gl_FragColor = vec4(uColor * vColor * uBoost, a);
  }
`;

export interface GlowMaterialOptions {
  color: ColorRepresentation;
  opacity: number;
  /** Rayon (0..1) jusqu'où l'opacité reste pleine avant le fondu. */
  inner: number;
  additive: boolean;
}

export function glowQuadMaterial(o: GlowMaterialOptions): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uColor: { value: new Color(o.color) },
      uOpacity: { value: o.opacity },
      uBoost: { value: 1 },
      uTime: { value: 0 },
      uInner: { value: o.inner },
    },
    transparent: true,
    depthWrite: false,
    blending: o.additive ? AdditiveBlending : NormalBlending,
    toneMapped: false,
  });
}
