import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import { footprint, interactionPoint, nearestLocation } from './locations';
import { locationInteraction } from './zones';

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

describe('interactions des lieux', () => {
  const action = (id: string) => locationInteraction(gameData, gameData.locations.get(id)!);

  it('entrer pour un intérieur, parler pour un dialogue, rien pour un simple repère', () => {
    for (const id of ['local', 'epicerie', 'banque', 'shop']) expect(action(id), id).toBe('enter');
    expect(action('repaire_jefe')).toBe('talk');
    for (const id of ['ruelle_nord', 'ruelle_est', 'ruelle_sud', 'point_relais'])
      expect(action(id), id).toBeNull();
  });

  it('aucun lieu ne répond par un simple message d’ambiance sans effet', () => {
    for (const loc of locations) {
      const kind = locationInteraction(gameData, loc);
      // une réplique d'entrée n'existe que si l'on entre vraiment quelque part
      expect(Boolean(loc.enterText), loc.id).toBe(kind === 'enter');
      if (kind === 'talk') expect(gameData.dialogues.has(loc.dialogue!), loc.id).toBe(true);
    }
  });
});
