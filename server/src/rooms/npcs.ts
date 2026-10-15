import {
  areaAt,
  createNavGrid,
  distance,
  distancesFrom,
  findPath,
  gameData,
  isFreeAt,
  obstaclesFrom,
  pickName,
  pickProfile,
  buyerProfile,
  rollDemand,
  sellPouches,
  strainItem,
  type Area,
  type Demand,
  type NavGrid,
  type Rng,
  type SaleOfferMessage,
  type Vec2,
} from '@narco/shared';
import { Npc, type GameState, type Player } from './schema';
import { readInventory, writeInventory } from './stateSync';

/**
 * PNJ acheteurs de la rue, simulés par le serveur : marche de point de passage en point de
 * passage (grille de navigation), pause, demande tirée à l'apparition. Une offre ouverte
 * réserve le PNJ pour un seul joueur (verrou) jusqu'à la fin de sa patience : deux joueurs
 * ne vendent jamais au même PNJ. Après une vente ou un refus, il s'éloigne puis revient avec
 * une nouvelle demande. Positions écrites dans l'état à `broadcastHz` seulement.
 * Chaque PNJ vit dans son area (`areas.json`) : sa grille de navigation est bornée au
 * rectangle de l'area, ses points de passage y sont, sa demande suit le marché de l'area.
 */

const { config, npcs: NPCS, economy, items } = gameData;
const NPC = config.npc;

const AREAS = [...gameData.areas.values()];
const grids = new Map<string, NavGrid>();
const fields = new Map<string, Float64Array>();

/** Points de passage d'une area : ceux de npcs.json pour la rue, ceux générés pour une impasse. */
const WAYPOINTS = new Map<string, Vec2[]>(
  AREAS.map((a) => [
    a.id,
    a.id === 'street'
      ? NPCS.waypoints.filter((wp) => areaAt(AREAS, wp)?.id === 'street')
      : [...gameData.quartierLayouts.values()]
          .filter((l) => l.areaId === a.id)
          .flatMap((l) => l.waypoints),
  ]),
);
const waypointsOf = (areaId: string) => WAYPOINTS.get(areaId) ?? [];

/** Grille d'une area (obstacles gonflés du rayon d'un PNJ, bornée à l'area), construite une fois. */
function gridOf(areaId: string): NavGrid {
  let g = grids.get(areaId);
  if (!g) {
    g = createNavGrid(
      gameData.areas.get(areaId)!.bounds,
      obstaclesFrom(gameData),
      NPC.radius,
      NPC.navCellSize,
    );
    grids.set(areaId, g);
  }
  return g;
}

/** Champ de distances vers un point de passage (mis en cache : 1 Dijkstra par point). */
function fieldTo(areaId: string, index: number): Float64Array {
  const key = `${areaId}:${index}`;
  let f = fields.get(key);
  if (!f) {
    f = distancesFrom(gridOf(areaId), waypointsOf(areaId)[index]!);
    fields.set(key, f);
  }
  return f;
}

interface Sim {
  /** Area où il vit (il n'en sort jamais). */
  area: Area;
  pos: Vec2;
  path: Vec2[];
  /** Fin de la pause (ms réelles). */
  pauseUntil: number;
  demand: Demand;
  /** Pas d'achat avant (temps de jeu, ms) ; 0 = disponible. */
  cooldownUntil: number;
  lock: { playerId: string; until: number } | null;
}

export type SaleResult =
  | {
      ok: true;
      text: string;
      offer?: SaleOfferMessage;
      amount?: number;
      qty?: number;
      area?: string;
    }
  | { ok: false; text: string };

export class StreetNpcs {
  private sims = new Map<string, Sim>();
  private nextId = 1;

  constructor(
    private readonly state: GameState,
    private readonly rng: Rng = Math.random,
  ) {}

  /** Fait apparaître la population de chaque area (sur ses points de passage, au hasard). */
  spawnAll(realNow: number): void {
    for (const area of AREAS) {
      const living = () => [...this.sims.values()].filter((s) => s.area.id === area.id).length;
      while (living() < area.npcCount) this.spawn(area, this.randomWaypoint(area.id), realNow);
    }
    this.publish();
  }

  private randomIndex(areaId: string): number {
    return Math.floor(this.rng() * waypointsOf(areaId).length);
  }

  private randomWaypoint(areaId: string): Vec2 {
    return waypointsOf(areaId)[this.randomIndex(areaId)]!;
  }

  private between([min, max]: readonly [number, number]) {
    return min + (max - min) * this.rng();
  }

  private spawn(area: Area, at: Vec2, realNow: number): string {
    const id = `npc_${this.nextId++}`;
    const taken = new Set([...this.state.npcs.values()].map((n) => n.name));
    const npc = new Npc();
    npc.id = id;
    npc.name = pickName(NPCS.names, taken, this.rng);
    this.state.npcs.set(id, npc);
    const sim: Sim = {
      area,
      pos: { ...at },
      path: [],
      pauseUntil: realNow + this.between(NPC.pauseSeconds) * 1000,
      demand: rollDemand(pickProfile(NPCS.profiles, this.rng), economy, this.rng, area),
      cooldownUntil: 0,
      lock: null,
    };
    this.sims.set(id, sim);
    this.writeDemand(npc, sim);
    return id;
  }

  /** Demande visible : seulement si intéressé et pas en pause d'achat. */
  private writeDemand(npc: Npc, sim: Sim): void {
    const visible = sim.demand.interested && sim.cooldownUntil === 0;
    npc.profileId = sim.demand.profileId;
    npc.interested = visible;
    npc.strainId = visible ? sim.demand.strainId : '';
    npc.qty = visible ? sim.demand.qty : 0;
    npc.unitPrice = visible ? sim.demand.unitPrice : 0;
    npc.busyWith = sim.lock?.playerId ?? '';
  }

  /**
   * Avance la simulation de `dtMs` (temps réel) : marche, pauses, fin des cooldowns (nouvelle
   * demande), fin de patience des offres. Renvoie les offres expirées (pour prévenir le joueur).
   */
  update(dtMs: number, realNow: number, gameNow: number): { playerId: string; npcId: string }[] {
    const expired: { playerId: string; npcId: string }[] = [];
    for (const [id, sim] of this.sims) {
      const npc = this.state.npcs.get(id)!;
      if (sim.lock && gameNow >= sim.lock.until) {
        expired.push({ playerId: sim.lock.playerId, npcId: id });
        this.leave(id, sim, gameNow);
      }
      if (sim.cooldownUntil > 0 && gameNow >= sim.cooldownUntil) {
        sim.cooldownUntil = 0;
        sim.demand = rollDemand(pickProfile(NPCS.profiles, this.rng), economy, this.rng, sim.area);
        this.writeDemand(npc, sim);
      }
      if (sim.lock) continue; // en pleine négociation : il ne bouge pas
      this.walk(sim, dtMs, realNow);
    }
    return expired;
  }

  private walk(sim: Sim, dtMs: number, realNow: number): void {
    if (sim.path.length === 0) {
      if (realNow < sim.pauseUntil) return;
      const a = sim.area.id;
      const index = this.randomIndex(a);
      sim.path = findPath(gridOf(a), sim.pos, waypointsOf(a)[index]!, fieldTo(a, index)) ?? [];
      if (sim.path.length === 0) sim.pauseUntil = realNow + this.between(NPC.pauseSeconds) * 1000;
      return;
    }
    let budget = (NPC.speed * dtMs) / 1000;
    while (budget > 0 && sim.path.length > 0) {
      const target = sim.path[0]!;
      const d = distance(sim.pos, target);
      if (d <= budget) {
        sim.pos = { ...target };
        sim.path.shift();
        budget -= d;
        if (sim.path.length === 0) sim.pauseUntil = realNow + this.between(NPC.pauseSeconds) * 1000;
      } else {
        const k = budget / d;
        sim.pos = {
          x: sim.pos.x + (target.x - sim.pos.x) * k,
          z: sim.pos.z + (target.z - sim.pos.z) * k,
        };
        budget = 0;
      }
    }
  }

  /** Écrit positions et orientations dans l'état diffusé (appelé à `broadcastHz`). */
  publish(): void {
    for (const [id, sim] of this.sims) {
      const npc = this.state.npcs.get(id)!;
      const next = sim.path[0];
      if (next && distance(next, sim.pos) > 1e-3)
        npc.rotY = Math.atan2(next.x - sim.pos.x, next.z - sim.pos.z);
      if (Math.abs(npc.x - sim.pos.x) > 1e-3) npc.x = sim.pos.x;
      if (Math.abs(npc.z - sim.pos.z) > 1e-3) npc.z = sim.pos.z;
    }
  }

  /** Le PNJ s'en va (vente faite, refus, patience épuisée) : verrou levé, cooldown. */
  private leave(id: string, sim: Sim, gameNow: number): void {
    sim.lock = null;
    sim.cooldownUntil = gameNow + this.between(NPC.cooldownSeconds) * 1000;
    sim.path = [];
    sim.pauseUntil = 0; // repart tout de suite
    this.writeDemand(this.state.npcs.get(id)!, sim);
  }

  private nearCheck(sim: Sim, player: Player): string | null {
    if (player.zone !== 'street') return 'Pas ici : la vente se fait dans la rue.';
    if (distance(player, sim.pos) > NPC.saleRadius + config.world.interactTolerance)
      return 'Trop loin : approche-toi.';
    return null;
  }

  /** Ouvre une offre : le PNJ est réservé pour ce joueur jusqu'à la fin de sa patience. */
  open(playerId: string, player: Player, npcId: string, gameNow: number): SaleResult {
    const sim = this.sims.get(npcId);
    const npc = this.state.npcs.get(npcId);
    if (!sim || !npc) return { ok: false, text: "Ce passant n'est plus là." };
    const far = this.nearCheck(sim, player);
    if (far) return { ok: false, text: far };
    if (sim.lock && sim.lock.playerId !== playerId)
      return { ok: false, text: `${npc.name} est déjà en affaire avec quelqu'un.` };
    if (!sim.demand.interested || sim.cooldownUntil > 0)
      return { ok: false, text: `${npc.name} n'est pas intéressé.` };
    if (!sim.lock) {
      // une seule offre à la fois par joueur : on lâche les autres
      this.releasePlayer(playerId, gameNow);
      sim.lock = { playerId, until: gameNow + sim.demand.patienceMs };
      sim.path = [];
      npc.rotY = Math.atan2(player.x - sim.pos.x, player.z - sim.pos.z);
      this.writeDemand(npc, sim);
    }
    const pouch = strainItem(items, 'pouch', sim.demand.strainId)!;
    return {
      ok: true,
      text: `${npc.name} veut ${sim.demand.qty} × ${pouch.name}.`,
      offer: {
        npcId,
        name: npc.name,
        pouchId: pouch.id,
        maxQty: sim.demand.qty,
        unitPrice: sim.demand.unitPrice,
        expiresAt: sim.lock!.until,
        area: sim.area.id,
        priceMultiplier: sim.demand.priceMultiplier,
      },
    };
  }

  /** Accepte l'offre : pochons contre argent sale, tout ou rien, puis le PNJ s'en va. */
  accept(
    playerId: string,
    player: Player,
    npcId: string,
    qty: number,
    gameNow: number,
  ): SaleResult {
    const sim = this.sims.get(npcId);
    const npc = this.state.npcs.get(npcId);
    if (!sim || !npc) return { ok: false, text: "Ce passant n'est plus là." };
    if (!sim.lock || sim.lock.playerId !== playerId || gameNow >= sim.lock.until)
      return { ok: false, text: "Pas d'offre en cours avec lui." };
    const far = this.nearCheck(sim, player);
    if (far) return { ok: false, text: far };
    const sale = sellPouches(readInventory(player.bag), sim.demand, qty, gameData);
    if (!sale.ok) return { ok: false, text: sale.message };
    writeInventory(player.bag, sale.bag);
    this.leave(npcId, sim, gameNow);
    const pouch = items.get(sale.pouchId)!;
    return {
      ok: true,
      text: `${npc.name} repart avec ${qty} × ${pouch.name}. +${sale.amount} $ (sale).`,
      amount: sale.amount,
      qty,
      area: sim.area.id,
    };
  }

  /** Refus du joueur : le PNJ s'en va. */
  decline(playerId: string, npcId: string, gameNow: number): boolean {
    const sim = this.sims.get(npcId);
    if (!sim?.lock || sim.lock.playerId !== playerId) return false;
    this.leave(npcId, sim, gameNow);
    return true;
  }

  /** Lâche les offres d'un joueur (déconnexion, changement de zone, KO). Renvoie les PNJ libérés. */
  releasePlayer(playerId: string, gameNow: number): string[] {
    const freed: string[] = [];
    for (const [id, sim] of this.sims)
      if (sim.lock?.playerId === playerId) {
        this.leave(id, sim, gameNow);
        freed.push(id);
      }
    return freed;
  }

  /** Debug : un acheteur intéressé de l'area du joueur apparaît devant lui (dans la rue). */
  spawnBuyerNear(player: Player): string | null {
    const area = areaAt(AREAS, player);
    if (!area) return null;
    const g = gridOf(area.id);
    for (let k = 0; k < 16; k++) {
      const a = player.rotY + (k * Math.PI) / 8;
      const at = {
        x: player.x + Math.sin(a) * NPC.debugSpawnDistance,
        z: player.z + Math.cos(a) * NPC.debugSpawnDistance,
      };
      if (!isFreeAt(g, at)) continue;
      // on recycle le PNJ le plus loin pour garder la population constante
      let farId: string | null = null;
      let farD = -1;
      for (const [id, sim] of this.sims) {
        const d = distance(sim.pos, player);
        if (!sim.lock && sim.area.id === area.id && d > farD) {
          farD = d;
          farId = id;
        }
      }
      if (!farId) return null;
      const sim = this.sims.get(farId)!;
      sim.pos = at;
      sim.path = [];
      sim.pauseUntil = Number.POSITIVE_INFINITY; // il attend le joueur
      sim.cooldownUntil = 0;
      sim.demand = {
        ...rollDemand(buyerProfile(NPCS.profiles), economy, this.rng, area),
        interested: true,
      };
      const npc = this.state.npcs.get(farId)!;
      npc.x = at.x;
      npc.z = at.z;
      npc.rotY = Math.atan2(player.x - at.x, player.z - at.z);
      this.writeDemand(npc, sim);
      return farId;
    }
    return null;
  }

  /** Position simulée (tests). */
  positionOf(npcId: string): Vec2 | undefined {
    return this.sims.get(npcId)?.pos;
  }

  /** Area d'un PNJ (tests, debug). */
  areaOf(npcId: string): string | undefined {
    return this.sims.get(npcId)?.area.id;
  }
}
