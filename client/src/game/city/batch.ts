import type { BufferGeometry } from 'three';
import {
  BoxGeometry,
  Color,
  Float32BufferAttribute,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Euler,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { DoorSide, Rect } from '@narco/shared';

/** Couleur dérivée : `hex` multipliée par `k` (assombrir < 1 < éclaircir). */
export function shade(hex: string, k: number): Color {
  return new Color(hex).multiplyScalar(k);
}

/** Mélange linéaire de deux couleurs. */
export function mix(a: string, b: string, t: number): Color {
  return new Color(a).lerp(new Color(b), t);
}

/** Générateur pseudo-aléatoire déterministe (mulberry32) à partir d'une chaîne. */
export function seeded(seed: string): () => number {
  let h = 1779033703;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Une façade d'un rectangle : origine au centre de la face, axe `u` le long, normale sortante. */
export interface Face {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  nx: number;
  nz: number;
  len: number;
}

export function faceOf(r: Rect, side: DoorSide): Face {
  const mx = (r.minX + r.maxX) / 2;
  const mz = (r.minZ + r.maxZ) / 2;
  const w = r.maxX - r.minX;
  const d = r.maxZ - r.minZ;
  switch (side) {
    case 'north':
      return { cx: mx, cz: r.minZ, ux: 1, uz: 0, nx: 0, nz: -1, len: w };
    case 'south':
      return { cx: mx, cz: r.maxZ, ux: -1, uz: 0, nx: 0, nz: 1, len: w };
    case 'west':
      return { cx: r.minX, cz: mz, ux: 0, uz: -1, nx: -1, nz: 0, len: d };
    case 'east':
      return { cx: r.maxX, cz: mz, ux: 0, uz: 1, nx: 1, nz: 0, len: d };
  }
}

export const SIDES: DoorSide[] = ['north', 'south', 'east', 'west'];

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpE = new Euler();
const tmpS = new Vector3(1, 1, 1);
const tmpP = new Vector3();

/**
 * Accumule des primitives colorées (couleurs par sommet) puis les fusionne en une seule
 * géométrie : un matériau = un draw call, quel que soit le nombre de bâtiments.
 */
export class Batch {
  private parts: BufferGeometry[] = [];
  /**
   * Les primitives ajoutées ensuite peuvent-elles être percées par la découpe (attribut `aCut`) ?
   * Faux pour le sol et les trottoirs ; les planchers (`floor`) ne le sont jamais.
   */
  cuttable = true;

  /** Ajoute une géométrie quelconque (rendue non indexée pour pouvoir tout fusionner). */
  add(geo: BufferGeometry, color: Color, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
    this.push(geo, color, x, y, z, rx, ry, rz);
  }

  private push(
    geo: BufferGeometry,
    color: Color,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    cut = this.cuttable,
  ) {
    if (geo.index) {
      const flat = geo.toNonIndexed();
      geo.dispose();
      geo = flat;
    }
    geo.computeVertexNormals();
    const count = geo.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b], i * 3);
    geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geo.setAttribute(
      'aCut',
      new Float32BufferAttribute(new Float32Array(count).fill(cut ? 1 : 0), 1),
    );
    geo.deleteAttribute('uv');
    // Ordre YXZ : l'inclinaison (rx) se fait dans le repère de la façade, puis on l'oriente (ry).
    tmpQ.setFromEuler(tmpE.set(rx, ry, rz, 'YXZ'));
    geo.applyMatrix4(tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS));
    this.parts.push(geo);
  }

  /** Boîte centrée en (x, y, z). */
  box(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: Color,
    rx = 0,
    ry = 0,
    rz = 0,
  ) {
    this.push(new BoxGeometry(w, h, d), color, x, y, z, rx, ry, rz);
  }

  /** Boîte posée au sol (y = base). */
  block(x: number, baseY: number, z: number, w: number, h: number, d: number, color: Color) {
    this.box(x, baseY + h / 2, z, w, h, d, color);
  }

  /** Rectangle horizontal (sol), légèrement surélevé de `y`. */
  floor(r: Rect, y: number, color: Color) {
    const geo = new PlaneGeometry(r.maxX - r.minX, r.maxZ - r.minZ);
    this.push(
      geo,
      color,
      (r.minX + r.maxX) / 2,
      y,
      (r.minZ + r.maxZ) / 2,
      -Math.PI / 2,
      0,
      0,
      false,
    );
  }

  /** Panneau plaqué sur une façade (fenêtre, porte, enseigne plate). `u` = décalage le long. */
  facePlane(f: Face, u: number, y: number, w: number, h: number, color: Color, out = 0.03) {
    const geo = new PlaneGeometry(w, h);
    const ry = Math.atan2(f.nx, f.nz);
    this.push(geo, color, f.cx + f.ux * u + f.nx * out, y, f.cz + f.uz * u + f.nz * out, 0, ry);
  }

  /** Boîte en saillie sur une façade (enseigne, auvent, colonne). */
  faceBox(
    f: Face,
    u: number,
    y: number,
    w: number,
    h: number,
    depth: number,
    color: Color,
    out = depth / 2,
    tilt = 0,
  ) {
    const ry = Math.atan2(f.nx, f.nz);
    this.push(
      new BoxGeometry(w, h, depth),
      color,
      f.cx + f.ux * u + f.nx * out,
      y,
      f.cz + f.uz * u + f.nz * out,
      tilt,
      ry,
    );
  }

  build(): BufferGeometry {
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    if (!merged) throw new Error('fusion de géométries impossible');
    merged.computeBoundingSphere();
    return merged;
  }
}
