import { useLayoutEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  Color,
  Euler,
  IcosahedronGeometry,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type InstancedMesh,
  type Material,
} from 'three';
import {
  airportLayout,
  expandRect,
  interactionPoint,
  lotCars,
  rectFromCenter,
  rectContainsPoint,
  type GameData,
  type QuartierLayout,
  type QuartierParams,
  type Rect,
  type Vec2,
} from '@narco/shared';
import { Batch, shade } from './batch';

/** Une instance : position (au sol sauf `y`), rotation Y, échelle uniforme, teinte optionnelle. */
interface Placement {
  x: number;
  z: number;
  y?: number;
  rotY?: number;
  scale?: number;
  color?: Color;
}

const LAMP_H = 4.6;
const ARM = 1.3;

/** Lampadaires générés le long des routes, côté extérieur du trottoir, hors croisements. */
function streetlightPlacements(data: GameData): Placement[] {
  const { map, decor } = data.config;
  const doors = [...data.locations.values()].map(interactionPoint);
  const roads = map.roads.map((r) => rectFromCenter(r, r));
  const out: Placement[] = [];
  roads.forEach((road, i) => {
    const crossings = roads
      .filter((_, j) => j !== i)
      .map((o) => expandRect(o, map.sidewalkWidth + 1));
    const alongX = road.maxX - road.minX >= road.maxZ - road.minZ;
    const edge = map.sidewalkWidth - decor.streetlights.inset;
    const sides = alongX
      ? [
          { off: road.minZ - edge, rotY: 0 },
          { off: road.maxZ + edge, rotY: Math.PI },
        ]
      : [
          { off: road.minX - edge, rotY: Math.PI / 2 },
          { off: road.maxX + edge, rotY: -Math.PI / 2 },
        ];
    const from = alongX ? road.minX : road.minZ;
    const to = alongX ? road.maxX : road.maxZ;
    sides.forEach((side, k) => {
      // décalage d'un demi-pas sur un côté sur deux : quinconce
      for (
        let t = from + decor.streetlights.spacing * (k ? 0.5 : 1);
        t < to - 1;
        t += decor.streetlights.spacing
      ) {
        const p = alongX ? { x: t, z: side.off } : { x: side.off, z: t };
        if (crossings.some((c: Rect) => rectContainsPoint(c, p))) continue;
        if (doors.some((dp) => Math.hypot(dp.x - p.x, dp.z - p.z) < 3)) continue;
        out.push({ ...p, rotY: side.rotY });
      }
    });
  });
  return out;
}

/** Points de décor des quartiers générés, avec leur quartier et l'axe de la rue la plus proche. */
function quartierPlacements(
  data: GameData,
  of: (l: QuartierLayout) => Vec2[],
): (Vec2 & { q: QuartierParams; axisX: number })[] {
  return [...data.quartierLayouts.values()].flatMap((l) =>
    of(l).map((p) => ({
      ...p,
      q: data.quartiers.get(l.id)!,
      // rue la plus proche (deux rues dans un U)
      axisX: l.frame.legs.reduce((a, b) => (Math.abs(b - p.x) < Math.abs(a - p.x) ? b : a)),
    })),
  );
}

/** Halo de lumière au sol (texture radiale générée, aucun fichier). */
function makeGlowTexture(): CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}

interface Kit {
  key: string;
  geometry: BufferGeometry;
  material: Material;
  items: Placement[];
}

/**
 * Aéroport : avions de ligne (fuselage, ailes, dérive, hublots allumés) et conteneurs empilés,
 * un InstancedMesh par pièce (`config.airport`).
 */
function airportKits(data: GameData, solidMaterial: Material, glowMaterial: Material): Kit[] {
  const { palette, airport } = data.config;
  const area = data.areas.get(airport.areaId);
  if (!area) return [];
  const layout = airportLayout(airport, area);
  const { length, span, height } = airport.planeSize;
  const hull = shade(palette.neon, 2.2);
  const plane = new Batch();
  const r = height * 0.28;
  plane.block(0, height * 0.25, 0, length, r * 2, r * 2, hull);
  plane.block(length * 0.52, height * 0.3, 0, length * 0.06, r * 1.4, r * 1.4, hull);
  plane.block(length * 0.05, height * 0.3, 0, length * 0.18, 0.3, span, shade(palette.wall, 1.6));
  plane.block(
    -length * 0.42,
    height * 0.3,
    0,
    length * 0.1,
    0.25,
    span * 0.35,
    shade(palette.wall, 1.6),
  );
  plane.block(
    -length * 0.43,
    height * 0.25 + r * 2,
    0,
    length * 0.1,
    height * 0.45,
    0.3,
    shade(area.themeColor, 1),
  );
  for (const s of [-1, 1])
    plane.block(
      length * 0.08,
      0,
      (s * span) / 4,
      1.2,
      height * 0.25,
      1.2,
      shade(palette.street, 0.8),
    );
  const windows = new Batch();
  for (const s of [-1, 1])
    windows.block(
      0,
      height * 0.25 + r * 1.1,
      s * (r + 0.02),
      length * 0.7,
      0.25,
      0.04,
      shade(palette.neon, 1),
    );
  const planes: Placement[] = layout.planes.map((p) => ({ x: p.x, z: p.z, rotY: p.rotY }));

  const c = airport.containerSize;
  const box = new Batch();
  const white = new Color(1, 1, 1);
  box.block(0, 0, 0, c.length, c.height, c.width, white);
  for (let u = -c.length / 2 + 0.4; u < c.length / 2; u += 0.6)
    for (const s of [-1, 1])
      box.block(u, 0.05, (s * c.width) / 2, 0.08, c.height - 0.1, 0.06, shade(palette.sky, 2));
  const containers: Placement[] = layout.containers.flatMap((k) =>
    Array.from({ length: k.stack }, (_, i) => ({
      x: k.x,
      z: k.z,
      y: i * c.height,
      rotY: k.rotY,
      color: shade(k.color, 1 - i * 0.08),
    })),
  );
  return [
    { key: 'planes', geometry: plane.build(), material: solidMaterial, items: planes },
    { key: 'planeWindows', geometry: windows.build(), material: glowMaterial, items: planes },
    { key: 'containers', geometry: box.build(), material: solidMaterial, items: containers },
  ];
}

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpE = new Euler();
const tmpP = new Vector3();
const tmpS = new Vector3();

function Instances({ kit }: { kit: Kit }) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    kit.items.forEach((it, i) => {
      tmpQ.setFromEuler(tmpE.set(0, it.rotY ?? 0, 0));
      const s = it.scale ?? 1;
      mesh.setMatrixAt(i, tmpM.compose(tmpP.set(it.x, it.y ?? 0, it.z), tmpQ, tmpS.set(s, s, s)));
      if (it.color) mesh.setColorAt(i, it.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [kit]);
  if (kit.items.length === 0) return null;
  return (
    <instancedMesh
      ref={ref}
      args={[kit.geometry, kit.material, kit.items.length]}
      frustumCulled={false}
    />
  );
}

export function Decor({
  data,
  solidMaterial,
  glowMaterial,
}: {
  data: GameData;
  solidMaterial: Material;
  glowMaterial: Material;
}) {
  const kits = useMemo<Kit[]>(() => {
    const { palette, decor } = data.config;
    const white = new Color(1, 1, 1);
    const lotTints = [palette.neon, palette.wall, palette.vegetation, palette.danger, palette.ok];

    // lampadaire : mât + bras (orienté vers la route)
    const pole = new Batch();
    pole.block(0, 0, 0, 0.16, LAMP_H, 0.16, shade(palette.sky, 1.4));
    pole.box(0, LAMP_H - 0.1, ARM / 2, 0.1, 0.1, ARM, shade(palette.sky, 1.4));
    // tête et halo blancs, teintés par instance (néon de la rue, lampe du quartier)
    const head = new Batch();
    head.box(0, LAMP_H - 0.25, ARM, 0.5, 0.18, 0.35, white);
    const pool = new PlaneGeometry(6, 6).rotateX(-Math.PI / 2).translate(0, 0.05, ARM);
    const poolMaterial = new MeshBasicMaterial({
      map: makeGlowTexture(),
      color: white,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    const streetLamp = shade(palette.neon, 1.2);
    const lamps: Placement[] = [
      ...streetlightPlacements(data).map((l) => ({ ...l, color: streetLamp })),
      ...quartierPlacements(data, (l) => l.lamps).map((p) => ({
        ...p,
        rotY: p.x < p.axisX ? Math.PI / 2 : -Math.PI / 2, // bras vers l'axe de l'impasse
        color: shade(p.q.palette.lamp, 1.2),
      })),
    ];

    // arbre low-poly : tronc + houppier à facettes
    const tree = new Batch();
    tree.block(0, 0, 0, 0.3, 1.6, 0.3, shade(palette.neon, 0.25));
    tree.add(new IcosahedronGeometry(1.3, 0), shade(palette.vegetation, 1), 0, 2.6, 0);
    tree.add(new IcosahedronGeometry(0.8, 0), shade(palette.vegetation, 1.3), 0.3, 3.5, -0.2, 0.4);

    // palmier des plages : tronc penché en trois tronçons, cinq palmes retombantes, noix
    const palm = new Batch();
    const bark = shade(palette.sand, 0.55);
    palm.block(0, 0, 0, 0.4, 1.4, 0.4, bark);
    palm.block(0.15, 1.4, 0, 0.34, 1.4, 0.34, bark);
    palm.block(0.35, 2.8, 0, 0.3, 1.2, 0.3, bark);
    const frond = new BoxGeometry(2.2, 0.08, 0.55).translate(1, 0, 0);
    for (let k = 0; k < 5; k++)
      palm.add(
        frond.clone(),
        shade(palette.vegetation, 1.1),
        0.4,
        4,
        0,
        0,
        (k * 2 * Math.PI) / 5,
        -0.4,
      );
    frond.dispose();
    palm.add(new IcosahedronGeometry(0.3, 0), shade(palette.sand, 0.4), 0.4, 3.8, 0);

    // voiture : caisse teintée par instance + habitacle sombre
    const { length, width, height } = decor.carSize;
    const car = new Batch();
    car.block(0, 0.25, 0, length, height * 0.45, width, white);
    car.block(
      -length * 0.08,
      0.25 + height * 0.45,
      0,
      length * 0.5,
      height * 0.4,
      width * 0.88,
      shade(palette.sky, 2.2),
    );
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        car.box(
          (sx * length) / 3,
          0.3,
          (sz * width) / 2,
          0.6,
          0.6,
          0.2,
          shade(palette.street, 0.6),
        );
    const carLights = new Batch();
    for (const sz of [-1, 1]) {
      carLights.box(
        length / 2 + 0.02,
        0.6,
        (sz * width) / 3,
        0.05,
        0.18,
        0.35,
        shade(palette.neon, 1.3),
      );
      carLights.box(
        -length / 2 - 0.02,
        0.6,
        (sz * width) / 3,
        0.05,
        0.15,
        0.4,
        shade(palette.neon, 0.45),
      );
    }
    const cars: Placement[] = [
      ...decor.cars.map((c) => ({
        x: c.x,
        z: c.z,
        rotY: c.rotation === 90 ? Math.PI / 2 : 0,
        color: shade(palette[c.color], c.color === 'neon' ? 0.9 : 1.6),
      })),
      // voitures garées des impasses : teinte d'une façade du quartier
      ...[...data.quartierLayouts.values()].flatMap((l) => {
        const facades = data.quartiers.get(l.id)!.palette.facades;
        return l.cars.map((c, i) => ({
          x: c.x,
          z: c.z,
          rotY: c.rotY,
          color: shade(facades[i % facades.length]!, 0.8),
        }));
      }),
      // concession et parking : voitures rangées dans l'emprise (déjà solide), teintes de la palette
      ...data.blocks
        .filter((b) => b.style === 'dealership' || b.style === 'parking')
        .flatMap((b) =>
          lotCars(b, decor.carSize, data.config.city.lotCars).map((c) => ({
            x: c.x,
            z: c.z,
            rotY: c.rotY,
            color: shade(lotTints[c.tint % lotTints.length]!, 1.4),
          })),
        ),
    ];

    // poubelle avec couvercle, caisse en bois, carton de départ
    const bin = new Batch();
    bin.block(0, 0, 0, 0.8, 1, 0.7, shade(palette.vegetation, 0.55));
    bin.block(0, 1, 0, 0.85, 0.1, 0.75, shade(palette.vegetation, 0.4));
    const crate = new Batch();
    crate.block(0, 0, 0, 0.9, 0.9, 0.9, shade(palette.neon, 0.42));
    crate.block(0, 0.42, 0, 0.95, 0.08, 0.95, shade(palette.neon, 0.3));
    const carton = new Batch();
    carton.block(0, 0, 0, 1.4, 0.8, 1, shade(palette.neon, 0.55));
    carton.block(-1.2, 0, 0, 1.8, 0.04, 1.1, shade(palette.neon, 0.5));
    carton.block(-1.2, 0.04, 0, 1.5, 0.12, 0.7, shade(palette.vegetation, 0.8));

    const at = (list: { x: number; z: number }[]): Placement[] =>
      list.map((p, i) => ({ ...p, rotY: i * 0.7 }));
    return [
      {
        key: 'poles',
        geometry: pole.build(),
        material: solidMaterial,
        items: lamps.map(({ color: _c, ...p }) => p),
      },
      { key: 'heads', geometry: head.build(), material: glowMaterial, items: lamps },
      { key: 'pools', geometry: pool, material: poolMaterial, items: lamps },
      {
        key: 'trees',
        geometry: tree.build(),
        material: solidMaterial,
        items: [
          ...decor.trees,
          ...quartierPlacements(data, (l) => l.trees).map((t) => ({ x: t.x, z: t.z })),
        ].map((t, i) => ({ ...t, rotY: i })),
      },
      {
        key: 'palms',
        geometry: palm.build(),
        material: solidMaterial,
        items: data.island.palms.map((p, i) => ({ ...p, rotY: i * 1.3 })),
      },
      { key: 'cars', geometry: car.build(), material: solidMaterial, items: cars },
      {
        key: 'carLights',
        geometry: carLights.build(),
        material: glowMaterial,
        items: cars.map(({ color: _c, ...p }) => p),
      },
      {
        key: 'bins',
        geometry: bin.build(),
        material: solidMaterial,
        items: at([
          ...decor.bins,
          ...quartierPlacements(data, (l) => [...l.bins, ...l.gardens.flatMap((g) => g.bins)]),
        ]),
      },
      {
        key: 'crates',
        geometry: crate.build(),
        material: solidMaterial,
        items: at([
          ...decor.crates,
          ...quartierPlacements(data, (l) => [...l.crates, ...l.gardens.flatMap((g) => g.crates)]),
        ]),
      },
      ...airportKits(data, solidMaterial, glowMaterial),
      {
        key: 'cartons',
        geometry: carton.build(),
        material: solidMaterial,
        items: at(decor.cartons),
      },
    ];
  }, [data, solidMaterial, glowMaterial]);

  useLayoutEffect(
    () => () => {
      for (const k of kits) {
        k.geometry.dispose();
        if (k.key === 'pools') k.material.dispose();
      }
    },
    [kits],
  );

  return (
    <>
      {kits.map((k) => (
        <Instances key={k.key} kit={k} />
      ))}
    </>
  );
}
