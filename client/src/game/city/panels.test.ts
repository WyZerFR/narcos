import { describe, expect, it } from 'vitest';
import { discoveryTargets, footprint, gameData, rectContainsPoint } from '@narco/shared';
import { panelSpots } from './Panels';
import { themedData } from './themedData';

/** Enseignes peintes du thème jour et pictogrammes de la mini-carte. */
describe('enseignes et icônes', () => {
  const spots = panelSpots(themedData(gameData, 'day'));

  it('panneaux lisibles des lieux de la référence, hors des façades, à taille de façade', () => {
    const texts = spots.map((s) => s.text);
    for (const t of ['BANK', 'PD · POLICE', 'AMMU-NATION', 'LAUNDROMAT', 'BARBERSHOP', 'COMMERCES'])
      expect(texts, t).toContain(t);
    const solids = [...gameData.locations.values(), ...gameData.blocks].map(footprint);
    for (const s of spots) {
      expect(
        solids.some((r) => rectContainsPoint(r, s)),
        s.text,
      ).toBe(false);
      expect(s.w).toBeGreaterThan(s.h);
      expect(s.y).toBeGreaterThanOrEqual(s.h);
    }
    expect(gameData.config.theme.day.panels).toBe(true);
    expect(gameData.config.theme.cartel.panels).toBe(false);
  });

  it('mini-carte : banque, police, armurerie, concession, laverie et labo ont leur icône', () => {
    const icons = new Map(discoveryTargets(gameData).map((t) => [t.id, t.icon]));
    for (const id of ['banque', 'local']) expect(icons.get(`place:${id}`), id).toBeTruthy();
    for (const style of ['police', 'gunshop', 'dealership', 'laundry']) {
      const b = gameData.blocks.find((x) => x.style === style)!;
      expect(icons.get(`place:${b.id}`), style).toBeTruthy();
    }
  });
});
