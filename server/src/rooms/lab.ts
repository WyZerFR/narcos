import {
  bagFullText,
  add,
  count,
  gameData,
  NO_LAMP,
  potLit,
  hangPlants,
  harvestPot,
  isCutDone,
  plantPot,
  pouchesFor,
  rackLoad,
  remove,
  splitDried,
  startCut,
  strainItem,
  waterPot,
  type Inventory,
  type ItemCategory,
  type Station,
  type StationAction,
  type Strain,
} from '@narco/shared';
import { labFixtures } from './furniture';
import type { CutJob, GameState, Player } from './schema';
import {
  readCut,
  readInventory,
  readPot,
  readRack,
  writeCut,
  writeInventory,
  writePot,
  writeRack,
} from './stateSync';

/**
 * Actions des postes du labo. Le serveur est l'autorité : chaque action relit l'état,
 * applique une fonction pure de `shared/` et n'écrit que si tout a réussi (tout ou rien).
 * Les messages Colyseus sont traités un par un : deux récoltes simultanées ne peuvent pas
 * réussir toutes les deux, la seconde trouve le pot vide.
 */

const { items, economy } = gameData;
const LAB = economy.lab;

export interface ActionResult {
  ok: boolean;
  text: string;
}

/** Actions autorisées par type de poste (la sortie est gérée par la room). */
export const ACTIONS_BY_KIND: Record<Station['kind'], readonly StationAction[]> = {
  pot: ['plant', 'water', 'harvest'],
  water: ['fill'],
  rack: ['hang', 'collect'],
  table: ['cut'],
  stock: [], // la caisse reviendra comme objet posable
  exit: ['exit'],
  shelf: ['take'],
  counter: ['pay'],
  lamp: [],
  talk: ['talk'],
  teller: ['launder'],
};

const done = (text: string): ActionResult => ({ ok: true, text });
const refuse = (text: string): ActionResult => ({ ok: false, text });

function strainOf(id: string): Strain | undefined {
  return economy.strains.find((s) => s.id === id);
}

/** Première pile d'une catégorie dans le sac (ex. la première graine). */
function firstOf(inv: Inventory, category: ItemCategory) {
  for (const stack of inv) {
    const def = stack ? items.get(stack.itemId) : undefined;
    if (stack && def?.category === category && def.strain)
      return { stack, def, strain: def.strain };
  }
  return null;
}

export function runStationAction(
  state: GameState,
  player: Player,
  station: Station,
  action: StationAction,
  now: number,
): ActionResult {
  if (!ACTIONS_BY_KIND[station.kind].includes(action))
    return refuse(`Impossible ici : ${station.label}`);
  const bag = readInventory(player.bag);

  switch (action) {
    case 'plant':
    case 'water':
    case 'harvest': {
      const potState = state.lab.pots.get(station.id);
      if (!potState) return refuse("Ce pot n'est pas encore installé.");
      const pot = readPot(potState);

      if (action === 'plant') {
        const lamps = labFixtures(state)
          .filter((f) => f.accepts === 'lamp')
          .map((f) => f.position);
        if (!potLit(station.position, lamps, LAB.lamp.range)) return refuse(NO_LAMP);
        const seed = firstOf(bag, 'seed');
        if (!seed) return refuse('Pas de graine dans ton sac.');
        const planted = plantPot(pot, seed.strain, now);
        if (!planted.ok) return refuse(planted.message);
        const nextBag = remove(bag, seed.def.id, 1, items);
        if (!nextBag.ok) return refuse(nextBag.message);
        writePot(potState, planted.value);
        writeInventory(player.bag, nextBag.inv);
        return done(`Graine plantée (${seed.def.name}). Maintenant, arrose.`);
      }

      const strain = strainOf(pot.strainId);
      if (!strain) return refuse('Rien ne pousse ici.');

      if (action === 'water') {
        if (count(bag, 'water') < LAB.waterPerWatering)
          return refuse("Pas d'eau dans ton sac : passe au point d'eau.");
        const watered = waterPot(pot, now, strain);
        if (!watered.ok) return refuse(watered.message);
        const nextBag = remove(bag, 'water', LAB.waterPerWatering, items);
        if (!nextBag.ok) return refuse(nextBag.message);
        writePot(potState, watered.value);
        writeInventory(player.bag, nextBag.inv);
        return done('Arrosé. La plante te remercie en silence.');
      }

      const harvested = harvestPot(pot, now, strain);
      if (!harvested.ok) return refuse(harvested.message);
      const fresh = strainItem(items, 'plant_fresh', strain.id)!;
      const nextBag = add(bag, fresh.id, harvested.value.fresh, items);
      if (!nextBag.ok) return refuse(bagFullText(player.bagTier, 'impossible de récolter.'));
      writePot(potState, harvested.value.pot);
      writeInventory(player.bag, nextBag.inv);
      return done(`Récolte : ${harvested.value.fresh} × ${fresh.name}.`);
    }

    case 'fill': {
      const nextBag = add(bag, 'water', LAB.waterPerTap, items);
      if (!nextBag.ok) return refuse('Plus de place pour une bouteille.');
      writeInventory(player.bag, nextBag.inv);
      return done("Bouteille remplie. Eau du robinet, millésime d'hier.");
    }

    case 'hang': {
      const rackState = state.lab.racks.get(station.id);
      if (!rackState) return refuse("Cet étendoir n'est pas encore installé.");
      const fresh = firstOf(bag, 'plant_fresh');
      if (!fresh) return refuse('Pas de plante fraîche dans ton sac.');
      const strain = strainOf(fresh.strain)!;
      const rack = readRack(rackState.entries);
      const room = LAB.rackCapacity - rackLoad(rack);
      const qty = Math.min(count(bag, fresh.def.id), room);
      const hung = hangPlants(rack, strain, qty, now, LAB.rackCapacity);
      if (!hung.ok) return refuse(hung.message);
      const nextBag = remove(bag, fresh.def.id, qty, items);
      if (!nextBag.ok) return refuse(nextBag.message);
      writeRack(rackState.entries, hung.value);
      writeInventory(player.bag, nextBag.inv);
      return done(`${qty} plante(s) étendue(s). Séchage en cours.`);
    }

    case 'collect': {
      const rackState = state.lab.racks.get(station.id);
      if (!rackState) return refuse("Cet étendoir n'est pas encore installé.");
      const { dried, remaining } = splitDried(readRack(rackState.entries), now);
      if (dried.length === 0) return refuse("Rien n'est encore sec.");
      let nextBag: Inventory = bag;
      let total = 0;
      for (const entry of dried) {
        const item = strainItem(items, 'plant_dried', entry.strainId)!;
        const r = add(nextBag, item.id, entry.qty, items);
        if (!r.ok)
          return refuse(bagFullText(player.bagTier, 'fais de la place avant de décrocher.'));
        nextBag = r.inv;
        total += entry.qty;
      }
      writeRack(rackState.entries, remaining);
      writeInventory(player.bag, nextBag);
      return done(`${total} plante(s) séchée(s) décrochée(s).`);
    }

    case 'cut': {
      const cutState = state.lab.cuts.get(station.id);
      if (!cutState) return refuse("Cette table n'est pas encore installée.");
      const dried = firstOf(bag, 'plant_dried');
      if (!dried) return refuse('Pas de plante séchée dans ton sac.');
      const qty = Math.min(count(bag, dried.def.id), LAB.tableBatchMax);
      const job = startCut(
        readCut(cutState),
        player.id,
        dried.strain,
        qty,
        now,
        LAB.cuttingSeconds,
      );
      if (!job.ok) return refuse(job.message);
      const nextBag = remove(bag, dried.def.id, qty, items);
      if (!nextBag.ok) return refuse(nextBag.message);
      writeCut(cutState, job.value);
      writeInventory(player.bag, nextBag.inv);
      return done(`Découpe de ${qty} plante(s) en cours…`);
    }

    case 'exit':
    case 'take':
    case 'pay':
    case 'talk':
    case 'launder':
      return refuse('Action gérée par la room.');
  }
}

/** Message de fin de découpe pour le joueur qui l'a lancée (`ok: false` = sac plein). */
export interface CutNotice {
  playerId: string;
  ok: boolean;
  text: string;
}

/** Termine les découpes prêtes de toutes les tables installées (messages par joueur). */
export function completeCuts(state: GameState, now: number): CutNotice[] {
  const out: CutNotice[] = [];
  for (const cut of state.lab.cuts.values()) {
    const r = completeCut(state, cut, now);
    if (r) out.push(r);
  }
  return out;
}

/** Découpes déjà signalées « sac plein » : le message n'est envoyé qu'une fois par découpe. */
const blockedCuts = new WeakSet<CutJob>();

/**
 * Termine une découpe si elle est prête : pochons dans le sac de celui qui l'a lancée.
 * Sac plein (ou joueur absent) : la découpe refuse de se terminer, les pochons attendent sur
 * la table et le joueur est prévenu une fois ; ils arrivent dès qu'il y a de la place.
 */
function completeCut(state: GameState, cut: CutJob, now: number): CutNotice | null {
  const job = readCut(cut);
  if (!isCutDone(job, now)) return null;
  const strain = strainOf(job.strainId);
  const pouch = strain ? strainItem(items, 'pouch', strain.id) : undefined;
  if (!strain || !pouch) {
    writeCut(cut, null);
    return null;
  }
  const qty = pouchesFor(job, strain);
  const player = state.players.get(job.playerId);
  const r = player ? add(readInventory(player.bag), pouch.id, qty, items) : null;
  if (player && r?.ok) {
    writeInventory(player.bag, r.inv);
    writeCut(cut, null);
    blockedCuts.delete(cut);
    return { playerId: job.playerId, ok: true, text: `${qty} × ${pouch.name} dans ton sac.` };
  }
  if (blockedCuts.has(cut)) return null;
  blockedCuts.add(cut);
  return {
    playerId: job.playerId,
    ok: false,
    text: `Découpe finie. ${bagFullText(
      player?.bagTier ?? 0,
      `fais de la place pour récupérer ${qty} × ${pouch.name} (ils attendent sur la table).`,
    )}`,
  };
}
