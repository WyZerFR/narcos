import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import { furnitureFixture, type Fixture } from './fixtures';
import {
  checkPlacement,
  fixtureAt,
  fixtureUser,
  generateLayout,
  snap,
  type PlacementRequest,
} from './placement';
import type { Vec2 } from './geometry';

const lab = gameData.interiors.get('lab')!;
const shop = gameData.interiors.get('shop')!;
const MAX = gameData.economy.lab.furniture.maxPerType;

const fx = (id: string, itemId: string, x: number, z: number, rot = 0): Fixture =>
  furnitureFixture({ id, itemId, x, z, rot }, gameData.items)!;

function check(req: PlacementRequest, fixtures: Fixture[] = [], players: Vec2[] = []) {
  return checkPlacement(gameData, { interior: lab, fixtures, players }, req);
}

describe('placement libre — règles', () => {
  it('accepte un pot au milieu du labo vide', () => {
    const r = check({ itemId: 'pot', x: 0, z: 0, rot: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fixture).toMatchObject({ accepts: 'pot', position: { x: 0, z: 0 } });
  });

  it('refuse hors de la pièce (dans le mur)', () => {
    expect(check({ itemId: 'pot', x: 6.6, z: 0, rot: 0 })).toMatchObject({
      ok: false,
      reason: 'out_of_room',
    });
    expect(check({ itemId: 'pot', x: 0, z: -4.7, rot: 0 })).toMatchObject({
      reason: 'out_of_room',
    });
  });

  it('rotation : un étendoir trop large contre le mur passe une fois tourné', () => {
    expect(check({ itemId: 'drying_rack', x: 6.5, z: -3, rot: 0 })).toMatchObject({
      reason: 'out_of_room',
    });
    expect(check({ itemId: 'drying_rack', x: 6.5, z: -3, rot: 1 }).ok).toBe(true);
    expect(check({ itemId: 'drying_rack', x: 6.5, z: -3, rot: 1.5 })).toMatchObject({
      reason: 'bad_position',
    });
  });

  it('refuse devant la porte (zone de dégagement) et sur le robinet', () => {
    expect(check({ itemId: 'pot', x: 0, z: 3.6, rot: 0 })).toMatchObject({ reason: 'door' });
    const water = lab.stations.find((s) => s.kind === 'water')!;
    const r = check({ itemId: 'pot', x: water.position.x + 0.3, z: water.position.z, rot: 0 });
    expect(r).toMatchObject({ ok: false, reason: 'station' });
    if (!r.ok) expect(r.message).toMatch(/Point d'eau/);
  });

  it('refuse un chevauchement avec un autre meuble, pas en le déplaçant sur place', () => {
    const pot = fx('f1', 'pot', 0, 0);
    const r = check({ itemId: 'cutting_table', x: 1, z: 0, rot: 0 }, [pot]);
    expect(r).toMatchObject({ ok: false, reason: 'furniture' });
    if (!r.ok) expect(r.message).toMatch(/Pot de terre/);
    expect(check({ itemId: 'pot', x: 0.4, z: 0, rot: 0, ignoreId: 'f1' }, [pot]).ok).toBe(true);
  });

  it('refuse sur un joueur ; une lampe au plafond passe au-dessus', () => {
    const someone = [{ x: 0, z: 0 }];
    expect(check({ itemId: 'pot', x: 0.5, z: 0, rot: 0 }, [], someone)).toMatchObject({
      reason: 'player',
    });
    expect(check({ itemId: 'grow_lamp', x: 0, z: 0, rot: 0 }, [], someone).ok).toBe(true);
  });

  it('lampes : au-dessus d’un pot ou de la porte oui, sur une autre lampe non', () => {
    const pot = fx('f1', 'pot', 0, 0);
    expect(check({ itemId: 'grow_lamp', x: 0, z: 0, rot: 0 }, [pot]).ok).toBe(true);
    expect(check({ itemId: 'grow_lamp', x: 0, z: 4, rot: 0 }).ok).toBe(true);
    const lamp = fx('f2', 'grow_lamp', 0, 0);
    expect(check({ itemId: 'grow_lamp', x: 0.3, z: 0, rot: 0 }, [pot, lamp])).toMatchObject({
      reason: 'furniture',
    });
  });

  it('plafond par type : refuse le meuble de trop, pas le déplacement d’un existant', () => {
    const pots = Array.from({ length: MAX.pot }, (_, i) => fx(`p${i}`, 'pot', -5 + i, -4));
    const r = check({ itemId: 'pot', x: 0, z: 0, rot: 0 }, pots);
    expect(r).toMatchObject({ ok: false, reason: 'limit' });
    if (!r.ok) expect(r.message).toMatch(String(MAX.pot));
    expect(check({ itemId: 'pot', x: 0, z: 0, rot: 0, ignoreId: 'p0' }, pots).ok).toBe(true);
    // les autres types ne sont pas comptés
    expect(check({ itemId: 'grow_lamp', x: 0, z: 0, rot: 0 }, pots).ok).toBe(true);
  });

  it('refuse un objet non posable, ou ailleurs que dans un intérieur aménageable', () => {
    expect(check({ itemId: 'water', x: 0, z: 0, rot: 0 })).toMatchObject({
      reason: 'not_placeable',
    });
    const r = checkPlacement(
      gameData,
      { interior: shop, fixtures: [], players: [] },
      { itemId: 'pot', x: 0, z: 0, rot: 0 },
    );
    expect(r).toMatchObject({ ok: false, reason: 'not_here', message: 'À poser dans ton labo.' });
  });
});

describe('placement libre — agencement généré (debug)', () => {
  it('produit des placements tous valides, lampes près des pots, alignés sur le pas', () => {
    const step = gameData.config.placement.stepM;
    const layout = generateLayout(gameData, { interior: lab, fixtures: [], players: [] }, [
      { itemId: 'pot', count: 4 },
      { itemId: 'cutting_table', count: 1 },
      { itemId: 'grow_lamp', count: 2 },
    ]);
    expect(layout).toHaveLength(7);
    const placed: Fixture[] = [];
    for (const [i, f] of layout.entries()) {
      expect(f.x).toBe(snap(f.x, step));
      const r = check({ ...f, ignoreId: `g${i}` }, placed);
      expect(r.ok, JSON.stringify(f)).toBe(true);
      placed.push(fx(`g${i}`, f.itemId, f.x, f.z, f.rot));
    }
    const pots = placed.filter((f) => f.accepts === 'pot');
    for (const lamp of placed.filter((f) => f.accepts === 'lamp'))
      expect(
        Math.min(
          ...pots.map((p) =>
            Math.hypot(p.position.x - lamp.position.x, p.position.z - lamp.position.z),
          ),
        ),
      ).toBeLessThanOrEqual(gameData.economy.lab.lamp.range);
  });

  it('s’arrête au plafond par type', () => {
    const layout = generateLayout(gameData, { interior: lab, fixtures: [], players: [] }, [
      { itemId: 'cutting_table', count: MAX.cutting_table + 3 },
    ]);
    expect(layout.length).toBeLessThanOrEqual(MAX.cutting_table);
  });
});

describe('placement — glisser direct et lampes', () => {
  it('lampe au-dessus d’un pot : valide ; lampe sur lampe : refusée ; pot sur pot : refusé', () => {
    const pot = fx('f1', 'pot', 0, 0);
    expect(check({ itemId: 'grow_lamp', x: 0.2, z: 0, rot: 0 }, [pot]).ok).toBe(true);
    const lamp = fx('f2', 'grow_lamp', 0, 0);
    expect(check({ itemId: 'grow_lamp', x: 0, z: 0, rot: 0 }, [pot, lamp])).toMatchObject({
      ok: false,
      reason: 'furniture',
    });
    expect(check({ itemId: 'pot', x: 0.6, z: 0, rot: 0 }, [pot])).toMatchObject({
      ok: false,
      reason: 'furniture',
    });
  });

  it('lampe : ignore porte, robinet et joueurs, mais reste dans la pièce', () => {
    const water = lab.stations.find((s) => s.kind === 'water')!;
    expect(check({ itemId: 'grow_lamp', ...water.position, rot: 0 }).ok).toBe(true);
    expect(check({ itemId: 'grow_lamp', x: 0, z: 3.6, rot: 0 }).ok).toBe(true);
    expect(check({ itemId: 'grow_lamp', x: 6.9, z: 0, rot: 0 })).toMatchObject({
      reason: 'out_of_room',
    });
  });

  it('fixtureAt : meuble sous le doigt, le meuble au sol avant la lampe', () => {
    const pot = fx('f1', 'pot', 0, 0);
    const lamp = fx('f2', 'grow_lamp', 0.1, 0);
    expect(fixtureAt({ x: 0.1, z: 0 }, [lamp, pot])?.id).toBe('f1');
    expect(fixtureAt({ x: 3, z: 3 }, [lamp, pot])).toBeNull();
  });

  it('fixtureUser : poste libre, joueur à portée, découpe d’un autre', () => {
    const pot = fx('f1', 'pot', 0, 0);
    const me = { id: 'a', name: 'Moi', x: 0, z: 1 };
    const far = { id: 'b', name: 'Bob', x: 5, z: 3 };
    expect(fixtureUser(pot, [me, far], 'a', 1)).toBeNull();
    expect(fixtureUser(pot, [me, { ...far, x: 0.5, z: 0.5 }], 'a', 1)).toBe('Bob');
    expect(fixtureUser(pot, [me, far], 'a', 1, 'b')).toBe('Bob');
    expect(fixtureUser(pot, [me], 'a', 1, 'a')).toBeNull();
  });
});
