import { describe, expect, it } from 'vitest';
import { checkPlacements, kitModelled, placementObstacles } from './props';
import { gameData } from './data';
import { obstaclesFrom } from './collision';
import { cellIndex, createNavGrid, distancesFrom } from './navgrid';
import { interactionPoint } from './locations';
import { walkableAreas, areaAt } from './areas';
import { PROP_KIT_IDS, type PlacementsFile } from './schemas';

/**
 * Décor posé (placements.json) : collisions par boîtes simples, accès à tous les lieux depuis le
 * départ, trajets comparés avec et sans les props posés, refus des placements sur route, porte
 * ou créant une fente.
 */
const { config } = gameData;
const radius = config.world.playerRadius;
const without = { ...gameData, placements: { ...gameData.placements, areas: {} } };
const base = obstaclesFrom(without);
const withProps = obstaclesFrom(gameData);
const walkable = walkableAreas(gameData.areas.values());

const check = (areas: PlacementsFile['areas']) =>
  checkPlacements(
    config,
    gameData.props,
    { ...gameData.placements, areas },
    gameData.areas,
    gameData.locations.values(),
    gameData.quartierLayouts.values(),
    base,
  );

describe('placements du décor 3D', () => {
  it('kits remplacés : tous actifs, collisions générées inchangées', () => {
    for (const kit of PROP_KIT_IDS) expect(kitModelled(gameData, kit), kit).toBe(true);
    const noKits = {
      ...without,
      placements: {
        ...without.placements,
        kits: Object.fromEntries(
          PROP_KIT_IDS.map((k) => [k, { ...without.placements.kits[k], props: [] }]),
        ) as unknown as PlacementsFile['kits'],
      },
    };
    expect(obstaclesFrom(noKits)).toEqual(base);
  });

  it('props posés : boîtes simples ajoutées aux obstacles, données valides', () => {
    const own = placementObstacles(gameData);
    expect(own.length).toBeGreaterThan(10);
    expect(withProps.length).toBe(base.length + own.length);
    expect(check(gameData.placements.areas)).toEqual([]);
  });

  it('tous les lieux atteignables depuis le départ, trajets inchangés ou signalés', () => {
    const cell = config.npc.navCellSize;
    const spawn = config.players.spawn;
    const before = distancesFrom(createNavGrid(config.world.bounds, base, radius, cell), spawn);
    const gridAfter = createNavGrid(config.world.bounds, withProps, radius, cell);
    const after = distancesFrom(gridAfter, spawn);
    const changed: string[] = [];
    for (const loc of gameData.locations.values()) {
      const p = interactionPoint(loc);
      if (!areaAt(walkable, p)) continue;
      const i = cellIndex(gridAfter, p);
      expect(Number.isFinite(after[i]!), `${loc.id} enfermé`).toBe(true);
      // détour toléré : 2 m (props contournés), au-delà le trajet est signalé
      if (after[i]! > before[i]! + 2)
        changed.push(`${loc.id} : +${(after[i]! - before[i]!).toFixed(1)} m`);
    }
    expect(changed, changed.join(', ')).toEqual([]);
  });

  it('refuse un prop sur une route, devant une porte, hors area ou en fente', () => {
    const road = config.map.roads[0]!;
    expect(
      check({ bas_fonds: [{ prop: 'bench', x: road.x, z: road.z, rotation: 0, scale: 1 }] }).join(),
    ).toMatch(/sur une route|hors de son area/);
    const shop = [...gameData.locations.values()].find(
      (l) => l.kind === 'building' && areaAt(walkable, interactionPoint(l)),
    )!;
    const door = interactionPoint(shop);
    const area = areaAt(walkable, door)!.id;
    expect(
      check({ [area]: [{ prop: 'box', x: door.x, z: door.z, rotation: 0, scale: 1 }] }).join(),
    ).toMatch(/trop près d'une porte/);
    // deux caisses à 0,5 m l'une de l'autre : fente plus étroite qu'un diamètre + marge
    const first = gameData.placements.areas.bas_fonds![0]!;
    const twin = { ...first, prop: 'box', rotation: 0 as const, scale: 1 };
    const gap = 0.5;
    const w = (gameData.props.get('box')!.collision as { w: number }).w;
    expect(check({ bas_fonds: [twin, { ...twin, x: twin.x + w + gap }] }).join()).toMatch(
      /fente de moins de/,
    );
    expect(check({ nulle_part: [twin] }).join()).toMatch(/inconnu/);
  });

  it('aucun prop posé ne bloque un point de passage des PNJ', () => {
    const own = placementObstacles(gameData);
    for (const wp of gameData.npcs.waypoints)
      for (const r of own)
        expect(
          wp.x >= r.minX - radius &&
            wp.x <= r.maxX + radius &&
            wp.z >= r.minZ - radius &&
            wp.z <= r.maxZ + radius,
        ).toBe(false);
  });
});
