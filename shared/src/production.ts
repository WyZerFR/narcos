import type { ItemCategory, ItemDef, Strain } from './schemas';

/**
 * Production du labo, en fonctions pures : `now` (temps de jeu, ms) est toujours passé en
 * paramètre. Aucun compteur n'est décrémenté : on stocke des timestamps et on en déduit l'état.
 */

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const no = <T>(message: string): Outcome<T> => ({ ok: false, message });

/** Objet d'une catégorie pour une variété (graine, plante fraîche, séchée, pochon). */
export function strainItem(
  items: ReadonlyMap<string, ItemDef>,
  category: ItemCategory,
  strainId: string,
): ItemDef | undefined {
  for (const it of items.values())
    if (it.category === category && it.strain === strainId) return it;
  return undefined;
}

// ---------------------------------------------------------------- pot

/**
 * Pot. La pousse n'avance que tant que la terre est humide (`now < wateredUntil`) ; la pousse
 * déjà acquise est « mise en banque » (`growMsDone` à l'instant `bankedAt`) à chaque arrosage.
 */
export interface PotState {
  planted: boolean;
  strainId: string;
  growMsDone: number;
  bankedAt: number;
  wateredUntil: number;
  /** Vitesse de pousse (1 = normale ; > 1 avec des lampes à portée). */
  rate: number;
}

export type PotStatus = 'empty' | 'needs_water' | 'growing' | 'ready';

export function emptyPot(): PotState {
  return { planted: false, strainId: '', growMsDone: 0, bankedAt: 0, wateredUntil: 0, rate: 1 };
}

const growTotal = (strain: Strain) => strain.growSeconds * 1000;

/** Pousse acquise (ms) à l'instant `now`, plafonnée à la durée totale. */
export function potGrowMs(pot: PotState, now: number, strain: Strain): number {
  if (!pot.planted) return 0;
  const wet = Math.max(0, Math.min(now, pot.wateredUntil) - pot.bankedAt);
  return Math.min(growTotal(strain), pot.growMsDone + wet * (pot.rate || 1));
}

export function potStatus(pot: PotState, now: number, strain: Strain): PotStatus {
  if (!pot.planted) return 'empty';
  if (potGrowMs(pot, now, strain) >= growTotal(strain)) return 'ready';
  return now < pot.wateredUntil ? 'growing' : 'needs_water';
}

export function potProgress(pot: PotState, now: number, strain: Strain): number {
  return pot.planted ? potGrowMs(pot, now, strain) / growTotal(strain) : 0;
}

/** Instant où le pot sera prêt si l'arrosage en cours suffit, sinon null. */
export function potReadyAt(pot: PotState, now: number, strain: Strain): number | null {
  if (potStatus(pot, now, strain) !== 'growing') return null;
  const at = now + (growTotal(strain) - potGrowMs(pot, now, strain)) / (pot.rate || 1);
  return at <= pot.wateredUntil ? at : null;
}

export function plantPot(
  pot: PotState,
  strainId: string,
  now: number,
  rate = pot.rate || 1,
): Outcome<PotState> {
  if (pot.planted) return no('Ce pot est déjà occupé.');
  return ok({ planted: true, strainId, growMsDone: 0, bankedAt: now, wateredUntil: now, rate });
}

/**
 * Change la vitesse de pousse (lampe posée ou retirée) : la pousse acquise est d'abord « mise
 * en banque » à l'ancienne vitesse, la suite se fera à la nouvelle. Aucun saut de progression.
 */
export function rebankPot(pot: PotState, now: number, strain: Strain, rate: number): PotState {
  if (!pot.planted) return { ...pot, rate };
  return { ...pot, growMsDone: potGrowMs(pot, now, strain), bankedAt: now, rate };
}

export function waterPot(pot: PotState, now: number, strain: Strain): Outcome<PotState> {
  const status = potStatus(pot, now, strain);
  if (status === 'empty') return no("Rien à arroser : plante d'abord.");
  if (status === 'ready') return no('La plante est prête : récolte-la.');
  if (status === 'growing') return no('La terre est encore humide.');
  return ok({
    ...pot,
    growMsDone: potGrowMs(pot, now, strain),
    bankedAt: now,
    wateredUntil: now + strain.waterEverySeconds * 1000,
  });
}

export function harvestPot(
  pot: PotState,
  now: number,
  strain: Strain,
): Outcome<{ pot: PotState; fresh: number }> {
  if (potStatus(pot, now, strain) !== 'ready') return no("Ce n'est pas encore prêt.");
  return ok({ pot: emptyPot(), fresh: strain.freshPerPlant });
}

// ---------------------------------------------------------------- étendoir

export interface RackEntry {
  strainId: string;
  qty: number;
  readyAt: number;
}

export function rackLoad(entries: readonly RackEntry[]): number {
  return entries.reduce((n, e) => n + e.qty, 0);
}

/** Étend `qty` plantes fraîches ; refusé si l'étendoir n'a pas la place. */
export function hangPlants(
  entries: readonly RackEntry[],
  strain: Strain,
  qty: number,
  now: number,
  capacity: number,
): Outcome<RackEntry[]> {
  if (qty <= 0) return no('Aucune plante fraîche à étendre.');
  if (rackLoad(entries) + qty > capacity) return no("L'étendoir est plein.");
  return ok([...entries, { strainId: strain.id, qty, readyAt: now + strain.dryingSeconds * 1000 }]);
}

/** Sépare les entrées sèches (à décrocher) des autres. */
export function splitDried(
  entries: readonly RackEntry[],
  now: number,
): { dried: RackEntry[]; remaining: RackEntry[] } {
  return {
    dried: entries.filter((e) => now >= e.readyAt),
    remaining: entries.filter((e) => now < e.readyAt),
  };
}

// ---------------------------------------------------------------- table de découpe

export interface CutJob {
  playerId: string;
  strainId: string;
  /** Plantes séchées engagées. */
  qty: number;
  readyAt: number;
}

export function startCut(
  current: CutJob | null,
  playerId: string,
  strainId: string,
  qty: number,
  now: number,
  cuttingSeconds: number,
): Outcome<CutJob> {
  if (current) return no('La table est occupée.');
  if (qty <= 0) return no('Aucune plante séchée à découper.');
  return ok({ playerId, strainId, qty, readyAt: now + cuttingSeconds * 1000 });
}

export function pouchesFor(job: Pick<CutJob, 'qty'>, strain: Strain): number {
  return job.qty * strain.pouchesPerDried;
}

export function isCutDone(job: CutJob | null, now: number): job is CutJob {
  return job !== null && now >= job.readyAt;
}
