import {
  add,
  count,
  gameData,
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
import type { GameState, Player } from './schema';
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
  /** Le client doit ouvrir un panneau (caisse du stock). */
  open?: 'stock';
}

/** Actions autorisées par type de poste (la sortie est gérée par la room). */
export const ACTIONS_BY_KIND: Record<Station['kind'], readonly StationAction[]> = {
  pot: ['plant', 'water', 'harvest'],
  water: ['fill'],
  rack: ['hang', 'collect'],
  table: ['cut'],
  stock: ['open'],
  exit: ['exit'],
  shelf: ['take'],
  counter: ['pay'],
};

const done = (text: string, open?: 'stock'): ActionResult =>
  open ? { ok: true, text, open } : { ok: true, text };
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
      if (!nextBag.ok) return refuse(`Sac plein : impossible de récolter.`);
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
      const fresh = firstOf(bag, 'plant_fresh');
      if (!fresh) return refuse('Pas de plante fraîche dans ton sac.');
      const strain = strainOf(fresh.strain)!;
      const rack = readRack(state.lab.rack);
      const room = LAB.rackCapacity - rackLoad(rack);
      const qty = Math.min(count(bag, fresh.def.id), room);
      const hung = hangPlants(rack, strain, qty, now, LAB.rackCapacity);
      if (!hung.ok) return refuse(hung.message);
      const nextBag = remove(bag, fresh.def.id, qty, items);
      if (!nextBag.ok) return refuse(nextBag.message);
      writeRack(state.lab.rack, hung.value);
      writeInventory(player.bag, nextBag.inv);
      return done(`${qty} plante(s) étendue(s). Séchage en cours.`);
    }

    case 'collect': {
      const { dried, remaining } = splitDried(readRack(state.lab.rack), now);
      if (dried.length === 0) return refuse("Rien n'est encore sec.");
      let nextBag: Inventory = bag;
      let total = 0;
      for (const entry of dried) {
        const item = strainItem(items, 'plant_dried', entry.strainId)!;
        const r = add(nextBag, item.id, entry.qty, items);
        if (!r.ok) return refuse('Sac plein : fais de la place avant de décrocher.');
        nextBag = r.inv;
        total += entry.qty;
      }
      writeRack(state.lab.rack, remaining);
      writeInventory(player.bag, nextBag);
      return done(`${total} plante(s) séchée(s) décrochée(s).`);
    }

    case 'cut': {
      const dried = firstOf(bag, 'plant_dried');
      if (!dried) return refuse('Pas de plante séchée dans ton sac.');
      const qty = Math.min(count(bag, dried.def.id), LAB.tableBatchMax);
      const job = startCut(
        readCut(state.lab.cut),
        player.id,
        dried.strain,
        qty,
        now,
        LAB.cuttingSeconds,
      );
      if (!job.ok) return refuse(job.message);
      const nextBag = remove(bag, dried.def.id, qty, items);
      if (!nextBag.ok) return refuse(nextBag.message);
      writeCut(state.lab.cut, job.value);
      writeInventory(player.bag, nextBag.inv);
      return done(`Découpe de ${qty} plante(s) en cours…`);
    }

    case 'open':
      return done('Caisse ouverte.', 'stock');

    case 'exit':
    case 'take':
    case 'pay':
      return refuse('Action gérée par la room.');
  }
}

/**
 * Termine la découpe si elle est prête : pochons dans le sac de celui qui l'a lancée,
 * ou dans le stock commun si son sac est plein. Renvoie le message pour ce joueur.
 */
export function completeCut(
  state: GameState,
  now: number,
): { playerId: string; text: string } | null {
  const job = readCut(state.lab.cut);
  if (!isCutDone(job, now)) return null;
  const strain = strainOf(job.strainId);
  const pouch = strain ? strainItem(items, 'pouch', strain.id) : undefined;
  if (!strain || !pouch) {
    writeCut(state.lab.cut, null);
    return null;
  }
  const qty = pouchesFor(job, strain);
  const player = state.players.get(job.playerId);
  if (player) {
    const r = add(readInventory(player.bag), pouch.id, qty, items);
    if (r.ok) {
      writeInventory(player.bag, r.inv);
      writeCut(state.lab.cut, null);
      return { playerId: job.playerId, text: `${qty} × ${pouch.name} dans ton sac.` };
    }
  }
  const r = add(readInventory(state.lab.stock), pouch.id, qty, items);
  if (!r.ok) return null; // tout est plein : la table reste occupée jusqu'à ce qu'on fasse de la place
  writeInventory(state.lab.stock, r.inv);
  writeCut(state.lab.cut, null);
  return {
    playerId: job.playerId,
    text: `Sac plein : ${qty} × ${pouch.name} posés dans la caisse.`,
  };
}
