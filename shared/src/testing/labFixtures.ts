import { z } from 'zod';
import { gameData, type GameData } from '../data';
import { FixtureSchema, type Fixture } from '../schemas';
import fixturesJson from './labFixtures.json';

/**
 * Emplacements de l'ancien labo meublé (4 pots, 2 étendoirs, 1 table, 4 lampes), réservés aux
 * tests : le labo du jeu est livré vide, mais la logique d'installation et de production reste
 * testée sur ces emplacements.
 */
export const TEST_LAB_FIXTURES: readonly Fixture[] = z.array(FixtureSchema).parse(fixturesJson);

/** Ajoute les emplacements de test au labo (une fois par processus de test). */
export function installTestLabFixtures(data: GameData = gameData): void {
  const lab = data.interiors.get('lab')!;
  if (lab.fixtures.length === 0) lab.fixtures.push(...structuredClone(TEST_LAB_FIXTURES));
}
