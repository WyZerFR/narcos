import {
  count,
  gameData,
  potProgress,
  potStatus,
  rackLoad,
  splitDried,
  type Inventory,
  type ItemCategory,
  type Place,
  type Station,
  type StationAction,
} from '@narco/shared';
import type { GameRoom } from '../net/connection';
import { readBag, readCut, readPot, readRack } from '../net/gameView';

const { items, economy } = gameData;
const LAB = economy.lab;
const DEFAULT_STRAIN = economy.strains[0]!;

/** Ce que propose un poste au joueur local, et son état visible par tous. */
export interface StationView {
  /** Action envoyée par le bouton ACTION (absente = rien à faire pour l'instant). */
  action?: StationAction;
  label: string;
  active: boolean;
  /** Texte d'état sous l'étiquette du poste (« Pousse 40 % »…). */
  status?: string;
  /** 0..1 pour la barre de progression partagée. */
  progress?: number;
}

const strainOf = (id: string) => economy.strains.find((s) => s.id === id) ?? DEFAULT_STRAIN;
const pct = (p: number) => `${Math.floor(p * 100)} %`;

function hasCategory(bag: Inventory, category: ItemCategory): boolean {
  return bag.some((s) => s !== null && items.get(s.itemId)?.category === category);
}

/**
 * Vue d'un endroit d'intérieur : poste fixe ou meuble posé. `furniture` : meuble posé
 * (déplaçable) ; `idle` : au repos, donc reprenable (le serveur revérifie).
 */
export function placeView(
  room: GameRoom,
  place: Place,
  myId: string,
  now: number,
  interiorId: string,
): StationView & { furniture?: boolean; idle?: boolean } {
  const view = stationView(room, place.station, myId, now, interiorId);
  return place.fixture ? { ...view, furniture: true, idle: isIdle(room, place.id) } : view;
}

/** Un meuble posé est au repos : pot vide, étendoir vide, table libre, lampe. */
function isIdle(room: GameRoom, id: string): boolean {
  const lab = room.state.lab;
  if (lab?.pots?.get(id)?.planted) return false;
  if ((lab?.racks?.get(id)?.entries.length ?? 0) > 0) return false;
  if (lab?.cuts?.get(id)?.playerId) return false;
  return true;
}

export function stationView(
  room: GameRoom,
  station: Station,
  myId: string,
  now: number,
  /** Intérieur où se trouve le poste (pour les étagères des magasins). */
  interiorId: string,
): StationView {
  const bag = readBag(room, myId);
  switch (station.kind) {
    case 'pot': {
      const pot = readPot(room, station.id);
      if (!pot) return { label: 'Pot non installé', active: false, status: 'Non installé' };
      const strain = strainOf(pot.strainId);
      const status = potStatus(pot, now, strain);
      const progress = potProgress(pot, now, strain);
      switch (status) {
        case 'empty': {
          const ok = hasCategory(bag, 'seed');
          return {
            action: 'plant',
            label: ok ? 'Planter' : 'Planter — pas de graine',
            active: ok,
            status: 'Vide',
            progress: 0,
          };
        }
        case 'needs_water': {
          const ok = count(bag, 'water') >= LAB.waterPerWatering;
          return {
            action: 'water',
            label: ok ? 'Arroser' : "Arroser — pas d'eau",
            active: ok,
            status: `À arroser · ${pct(progress)}`,
            progress,
          };
        }
        case 'growing':
          return {
            label: 'Ça pousse…',
            active: false,
            status: `Pousse ${pct(progress)}`,
            progress,
          };
        case 'ready':
          return {
            action: 'harvest',
            label: 'Récolter',
            active: true,
            status: 'Prêt !',
            progress: 1,
          };
      }
      break;
    }
    case 'water':
      return { action: 'fill', label: "Prendre de l'eau", active: true };
    case 'rack': {
      const rack = readRack(room, station.id);
      const load = rackLoad(rack);
      const { dried, remaining } = splitDried(rack, now);
      const next = remaining.reduce<number | null>(
        (m, e) => (m === null || e.readyAt < m ? e.readyAt : m),
        null,
      );
      const dryMs = DEFAULT_STRAIN.dryingSeconds * 1000;
      const progress =
        dried.length > 0 ? 1 : next !== null ? Math.max(0, 1 - (next - now) / dryMs) : 0;
      const status =
        load === 0
          ? 'Vide'
          : `${load}/${LAB.rackCapacity} · ${dried.length > 0 ? 'Sec !' : `Séchage ${pct(progress)}`}`;
      if (dried.length > 0)
        return { action: 'collect', label: 'Décrocher', active: true, status, progress };
      if (load >= LAB.rackCapacity)
        return { action: 'hang', label: 'Étendoir plein', active: false, status, progress };
      const ok = hasCategory(bag, 'plant_fresh');
      return {
        action: 'hang',
        label: ok ? 'Étendre' : 'Étendre — pas de plante fraîche',
        active: ok,
        status,
        progress,
      };
    }
    case 'table': {
      const job = readCut(room, station.id);
      if (job) {
        const total = LAB.cuttingSeconds * 1000;
        const progress = Math.min(1, Math.max(0, 1 - (job.readyAt - now) / total));
        return {
          label: 'Découpe en cours…',
          active: false,
          status: `Découpe ${pct(progress)}`,
          progress,
        };
      }
      const ok = hasCategory(bag, 'plant_dried');
      return {
        action: 'cut',
        label: ok ? 'Découper' : 'Découper — pas de plante séchée',
        active: ok,
        status: 'Libre',
        progress: 0,
      };
    }
    case 'exit':
      return { action: 'exit', label: 'Sortir', active: true };
    case 'shelf': {
      // prix et stock viennent des données et de l'état serveur : rien n'est calculé ici
      const shelf = gameData.shops.get(interiorId)?.shelves.find((x) => x.stationId === station.id);
      if (!shelf) return { label: station.label, active: false };
      const name = items.get(shelf.itemId)?.name ?? shelf.itemId;
      const stock = room.state.shelves?.get(`${interiorId}:${station.id}`)?.stock ?? -1;
      const status = `${shelf.price} $ · ${stock < 0 ? 'en stock' : `reste ${stock}`}`;
      if (stock === 0) return { action: 'take', label: `Rupture : ${name}`, active: false, status };
      return {
        action: 'take',
        label: `Prendre : ${name} (${shelf.price} $)`,
        active: true,
        status,
      };
    }
    case 'lamp':
      return { label: 'Lampe allumée', active: false, status: 'Allumée' };
    case 'counter': {
      const total = room.state.players?.get(myId)?.cartTotal ?? 0;
      const lines = room.state.players?.get(myId)?.cart?.length ?? 0;
      return lines > 0
        ? { action: 'pay', label: `Payer (${total} $)`, active: true }
        : { action: 'pay', label: 'Panier vide', active: false };
    }
  }
  return { label: station.label, active: false };
}
