import {
  add,
  fixtureObstacles,
  gameData,
  lampRate,
  rebankPot,
  remove,
  type Fixture,
  type Interior,
  type Rect,
} from '@narco/shared';
import type { ActionResult } from './lab';
import { CutJob, InstalledFixture, Pot, RackState, type GameState, type Player } from './schema';
import { readInventory, readPot, writeInventory, writePot } from './stateSync';

/**
 * Aménagement du labo côté serveur : installer un objet du sac sur un emplacement libre,
 * le démonter (s'il ne travaille pas), recalculer la vitesse des pots quand une lampe bouge.
 */

const { items, economy } = gameData;
const LAMP = economy.lab.lamp;
const DEFAULT_STRAIN = economy.strains[0]!;

export function installedIds(state: GameState): Set<string> {
  return new Set(state.lab.fixtures.keys());
}

/** Obstacles du mobilier installé dans un intérieur (collisions dynamiques). */
export function installedObstacles(state: GameState, interior: Interior): Rect[] {
  return fixtureObstacles(interior, installedIds(state));
}

/** Recalcule la vitesse de chaque pot installé selon les lampes à portée (sans saut). */
export function refreshPotRates(state: GameState, interior: Interior, now: number): void {
  const installed = installedIds(state);
  const lamps = interior.fixtures
    .filter((f) => f.accepts === 'lamp' && installed.has(f.id))
    .map((f) => f.position);
  for (const f of interior.fixtures) {
    const potState = state.lab.pots.get(f.id);
    if (f.accepts !== 'pot' || !potState) continue;
    const rate = lampRate(f.position, lamps, LAMP);
    if (Math.abs((potState.rate || 1) - rate) < 1e-9) continue;
    const pot = readPot(potState);
    const strain = economy.strains.find((s) => s.id === pot.strainId) ?? DEFAULT_STRAIN;
    writePot(potState, rebankPot(pot, now, strain, rate));
  }
}

/** Crée l'état de travail d'un emplacement installé (pot vide, étendoir vide, table libre). */
function activate(state: GameState, f: Fixture, itemId: string): void {
  const record = new InstalledFixture();
  record.itemId = itemId;
  state.lab.fixtures.set(f.id, record);
  if (f.accepts === 'pot') state.lab.pots.set(f.id, new Pot());
  if (f.accepts === 'drying_rack') state.lab.racks.set(f.id, new RackState());
  if (f.accepts === 'cutting_table') state.lab.cuts.set(f.id, new CutJob());
}

function deactivate(state: GameState, f: Fixture): void {
  state.lab.fixtures.delete(f.id);
  state.lab.pots.delete(f.id);
  state.lab.racks.delete(f.id);
  state.lab.cuts.delete(f.id);
}

/** Pourquoi un emplacement installé ne peut pas être démonté (ou null s'il est libre). */
export function busyReason(state: GameState, f: Fixture): string | null {
  if (state.lab.pots.get(f.id)?.planted) return 'Le pot contient une plante : récolte-la avant.';
  if ((state.lab.racks.get(f.id)?.entries.length ?? 0) > 0) return "L'étendoir est chargé.";
  if (state.lab.cuts.get(f.id)?.playerId) return 'Une découpe est en cours sur cette table.';
  return null;
}

/** Installe le premier objet compatible du sac sur l'emplacement. */
export function installFixture(
  state: GameState,
  player: Player,
  interior: Interior,
  f: Fixture,
  now: number,
): ActionResult {
  if (state.lab.fixtures.has(f.id)) return { ok: false, text: 'Cet emplacement est déjà occupé.' };
  const bag = readInventory(player.bag);
  const stack = bag.find((s) => s && items.get(s.itemId)?.installs === f.accepts);
  if (!stack) return { ok: false, text: "Tu n'as rien de compatible dans ton sac." };
  const r = remove(bag, stack.itemId, 1, items);
  if (!r.ok) return { ok: false, text: r.message };
  writeInventory(player.bag, r.inv);
  activate(state, f, stack.itemId);
  refreshPotRates(state, interior, now);
  return { ok: true, text: `Installé : ${items.get(stack.itemId)?.name ?? stack.itemId}.` };
}

/** Démonte un emplacement inactif et rend l'objet au sac. */
export function uninstallFixture(
  state: GameState,
  player: Player,
  interior: Interior,
  f: Fixture,
  now: number,
): ActionResult {
  const record = state.lab.fixtures.get(f.id);
  if (!record) return { ok: false, text: "Il n'y a rien à démonter ici." };
  const busy = busyReason(state, f);
  if (busy) return { ok: false, text: busy };
  const r = add(readInventory(player.bag), record.itemId, 1, items);
  if (!r.ok) return { ok: false, text: 'Sac plein : impossible de démonter.' };
  writeInventory(player.bag, r.inv);
  const name = items.get(record.itemId)?.name ?? record.itemId;
  deactivate(state, f);
  refreshPotRates(state, interior, now);
  return { ok: true, text: `Démonté : ${name}, rangé dans ton sac.` };
}

/** Debug : installe tout le mobilier de l'intérieur (sans rien prendre dans un sac). */
export function equipAll(state: GameState, interior: Interior, now: number): void {
  for (const f of interior.fixtures) {
    if (state.lab.fixtures.has(f.id)) continue;
    const item = [...items.values()].find((it) => it.installs === f.accepts);
    if (item) activate(state, f, item.id);
  }
  refreshPotRates(state, interior, now);
}

/** Debug : vide le labo (plantes, séchage et découpes en cours compris). */
export function clearAll(state: GameState, interior: Interior): void {
  for (const f of interior.fixtures) deactivate(state, f);
}
