import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import { footprint, interactionPoint, nearestLocation } from './locations';

const locations = [...gameData.locations.values()];
const local = gameData.locations.get('local')!;

describe('lieux', () => {
  it('place le point d’interaction d’un bâtiment devant sa porte, hors de l’emprise', () => {
    const p = interactionPoint(local);
    const r = footprint(local);
    // au bout de l'impasse sud, porte tournée vers la rue (nord = -Z)
    expect(local.door).toBe('north');
    expect(p.x).toBe(local.position.x);
    expect(p.z).toBeLessThan(r.minZ);
  });

  it('place le point d’interaction d’une ruelle en son centre', () => {
    const alley = gameData.locations.get('ruelle_nord')!;
    expect(interactionPoint(alley)).toEqual(alley.position);
  });

  it('trouve le lieu le plus proche dans son rayon, et rien ailleurs', () => {
    expect(nearestLocation(interactionPoint(local), locations)?.id).toBe('local');
    const epicerie = gameData.locations.get('epicerie')!;
    const p = interactionPoint(epicerie);
    expect(nearestLocation({ x: p.x + 1, z: p.z }, locations)?.id).toBe('epicerie');
    expect(nearestLocation({ x: 0, z: 0 }, locations)).toBeNull(); // milieu du carrefour
  });
});
