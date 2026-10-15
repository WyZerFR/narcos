import { EventEmitter } from 'node:events';
import { matchMaker, Room, ServerError, type Client, type Delayed } from '@colyseus/core';
import {
  ClientMsg,
  ServerMsg,
  STATION_ACTIONS,
  STREET,
  add,
  clockNow,
  createClock,
  distance,
  emptyInventory,
  freshBudget,
  gameData,
  generateRoomCode,
  interactionPoint,
  locationInteraction,
  AreaSchema,
  interiorForLocation,
  interiorPlaces,
  resolveCircle,
  sanitizeName,
  setClockScale,
  validateMove,
  zoneArea,
  type CorrectionMessage,
  type DialogueNodeMessage,
  type LaunderedEvent,
  type LaunderOpenMessage,
  type LaunderResultMessage,
  LAUNDERED,
  type FixtureResultMessage,
  type GameClock,
  type JoinOptions,
  type MoveBudget,
  type MoveRules,
  type NoticeMessage,
  type MoveResultMessage,
  moveStack,
  sortInventory,
  type StationAction,
} from '@narco/shared';
import type { RoomSnapshot } from '../persistence';
import { hydrateState, SNAPSHOT_SCHEMA_VERSION } from '../persistence';
import {
  clearLab,
  equipLab,
  fixturesIn,
  furnitureObstacles,
  moveFurniture,
  pickupFurniture,
  placeFurniture,
  refreshPotRates,
  type FurnitureResult,
} from './furniture';
import { completeCuts, runStationAction } from './lab';
import {
  consume,
  count,
  decayVitals,
  DIRTY_CASH,
  koCashLoss,
  remove,
  speedFactor,
} from '@narco/shared';
import { pay, putBack, readCart, returnCart, stockShelves, takeItem, writeCart } from './shop';
import { StreetNpcs } from './npcs';
import { DialogueDesk } from './dialogues';
import { accessGranted, debugEnabled } from '../env';
import {
  freezeLaunderWindows,
  launder,
  openTeller,
  resetLaunderCap,
  venueArea,
  venueOf,
} from './bank';
import { SALE_COMPLETED, type SaleClosedMessage, type SaleCompletedEvent } from '@narco/shared';
import { GameState, Player } from './schema';
import { makeSlots, readInventory, syncArea, writeInventory } from './stateSync';

const { config, economy, items } = gameData;
const SURVIVAL = economy.survival;

/** Règles de mouvement par zone (rue, intérieurs), sans le mobilier installé, calculées une fois. */
const MOVE_RULES = new Map<string, MoveRules>();
for (const zoneId of [STREET, ...gameData.interiors.keys()]) {
  const area = zoneArea(gameData, zoneId)!;
  MOVE_RULES.set(zoneId, {
    maxSpeed: config.movement.runSpeed,
    toleranceFactor: config.movement.toleranceFactor,
    maxBurstMs: config.movement.maxBurstMs,
    bounds: area.bounds,
    collision: { radius: config.world.playerRadius, obstacles: area.obstacles },
  });
}
const STREET_RULES = MOVE_RULES.get(STREET)!;

function rulesFor(zoneId: string): MoveRules {
  return MOVE_RULES.get(zoneId) ?? STREET_RULES;
}

/** Debug : point d'arrivée d'une téléportation (départ pour la rue, porte du bout d'impasse). */
function debugAreaSpot(areaId: string): { x: number; z: number } {
  const q = [...gameData.quartiers.values()].find((x) => x.areaId === areaId);
  const loc = q && gameData.locations.get(q.landmarkLocationId);
  return loc ? interactionPoint(loc) : { ...config.players.spawn };
}

const PLAYER_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Places en plus pour les sessions fantômes (socket mort pas encore détecté par le serveur). */
const GHOST_SLOTS = 2;
/** Cadence de la boucle serveur (fin des découpes) et de la diffusion de l'horloge. */
const TICK_MS = 250;
const CLOCK_BROADCAST_MS = 1000;

/** Rooms vivantes, pour la sauvegarde périodique. */
export const liveRooms = new Set<NarcoRoom>();

async function uniqueRoomCode(): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = generateRoomCode(config.room.codeAlphabet, config.room.codeLength);
    const taken = await matchMaker.query({ roomId: code });
    if (taken.length === 0) return code;
  }
  throw new Error('Impossible de générer un code de room libre');
}

function parseJoinOptions(options: unknown): JoinOptions {
  const o = (options ?? {}) as Partial<Record<keyof JoinOptions, unknown>>;
  if (typeof o.playerId !== 'string' || !PLAYER_ID_RE.test(o.playerId)) {
    throw new ServerError(400, 'playerId invalide');
  }
  if (!accessGranted(o.accessCode)) throw new ServerError(401, "Code d'accès incorrect.");
  return { playerId: o.playerId, name: sanitizeName(o.name, '') };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export interface NarcoRoomOptions {
  /** Partie à restaurer depuis la sauvegarde JSON. */
  restore?: RoomSnapshot;
  /** Code d'accès du lobby (`NARCO_ACCESS_CODE`), vérifié dès la création. */
  accessCode?: unknown;
}

export class NarcoRoom extends Room<GameState> {
  override maxClients = config.room.maxPlayers + GHOST_SLOTS;
  override autoDispose = false;
  override state = new GameState();

  /** sessionId -> playerId */
  private sessions = new Map<string, string>();
  private budgets = new Map<string, MoveBudget>();
  private emptyTimer: Delayed | undefined;
  private gameClock: GameClock = createClock(Date.now());
  /** PNJ acheteurs de la rue. */
  readonly npcs = new StreetNpcs(this.state);
  /** Conversations en cours (courtier…), validées choix par choix. */
  readonly dialogues = new DialogueDesk();
  /** Événements de jeu côté serveur (`sale_completed`…), pour le Heat et la police plus tard. */
  readonly events = new EventEmitter();
  private npcTickAt = Date.now();
  /** Temps de jeu depuis lequel aucun joueur n'est connecté (fenêtre du plafond gelée). */
  private emptySince: number | null = null;

  override async onCreate(options: NarcoRoomOptions = {}): Promise<void> {
    if (options.restore) {
      this.roomId = options.restore.code;
      hydrateState(this.state, options.restore);
      this.gameClock = createClock(
        Date.now(),
        options.restore.clock.now,
        options.restore.clock.scale,
      );
      stockShelves(this.state, false);
      console.log(`[room ${this.roomId}] restaurée (${this.state.players.size} joueur(s))`);
    } else {
      // refus avant tout : une partie créée sans joueur occuperait une place
      if (!accessGranted(options.accessCode)) throw new ServerError(401, "Code d'accès incorrect.");
      if (liveRooms.size >= config.room.maxRooms)
        throw new ServerError(503, 'Trop de parties en cours : réessaie plus tard.');
      this.roomId = await uniqueRoomCode();
      this.state.code = this.roomId;
      stockShelves(this.state);
    }
    this.publishClock();
    this.emptySince = this.now();
    await this.setPrivate(true);
    this.setPatchRate(config.room.patchRateMs);

    this.onMessage(ClientMsg.Move, (client, msg: unknown) => this.handleMove(client, msg));
    this.onMessage(ClientMsg.Interact, (client, msg: unknown) => this.handleInteract(client, msg));
    this.onMessage(ClientMsg.Station, (client, msg: unknown) => this.handleStation(client, msg));

    this.onMessage(ClientMsg.Debug, (client, msg: unknown) => this.handleDebug(client, msg));
    this.onMessage(ClientMsg.Use, (client, msg: unknown) => this.handleUse(client, msg));
    this.onMessage(ClientMsg.InventoryMove, (client, msg: unknown) =>
      this.handleInventoryMove(client, msg),
    );
    this.onMessage(ClientMsg.InventorySort, (client) => {
      const who = this.playerOf(client);
      if (who) writeInventory(who.player.bag, sortInventory(readInventory(who.player.bag), items));
    });
    this.onMessage(ClientMsg.FixturePlace, (client, msg: unknown) =>
      this.handleFurniture(client, msg, 'place'),
    );
    this.onMessage(ClientMsg.FixtureMove, (client, msg: unknown) =>
      this.handleFurniture(client, msg, 'move'),
    );
    this.onMessage(ClientMsg.FixturePickup, (client, msg: unknown) =>
      this.handleFurniture(client, msg, 'pickup'),
    );
    this.onMessage(ClientMsg.CartRemove, (client, msg: unknown) =>
      this.handleCartRemove(client, msg),
    );
    this.clock.setInterval(() => this.tick(), TICK_MS);
    this.clock.setInterval(() => this.publishClock(), CLOCK_BROADCAST_MS);
    this.clock.setInterval(() => this.settleAllVitals(), CLOCK_BROADCAST_MS);
    this.npcs.spawnAll(Date.now());
    this.clock.setInterval(() => this.npcTick(), 1000 / config.npc.broadcastHz);
    this.onMessage(ClientMsg.DialogueChoose, (client, msg: unknown) =>
      this.handleDialogueChoose(client, msg),
    );
    this.onMessage(ClientMsg.BankLaunder, (client, msg: unknown) =>
      this.handleLaunder(client, msg),
    );
    this.onMessage(ClientMsg.SaleOpen, (client, msg: unknown) => this.handleSaleOpen(client, msg));
    this.onMessage(ClientMsg.SaleAccept, (client, msg: unknown) =>
      this.handleSaleAccept(client, msg),
    );
    this.onMessage(ClientMsg.SaleDecline, (client, msg: unknown) =>
      this.handleSaleDecline(client, msg),
    );
    liveRooms.add(this);
    this.armEmptyTimer();
  }

  override onAuth(_client: Client, options: unknown): JoinOptions {
    const opts = parseJoinOptions(options);
    const isKnown = this.state.players.has(opts.playerId);
    if (!isKnown && this.state.players.size >= config.room.maxPlayers) {
      throw new ServerError(403, 'La partie est pleine');
    }
    return opts;
  }

  override onJoin(client: Client, _options: unknown, auth: JoinOptions): void {
    const { playerId } = auth;
    let player = this.state.players.get(playerId);

    if (player) {
      // Reconnexion : on réattache le joueur existant et on éjecte une éventuelle session fantôme.
      for (const [sessionId, pid] of this.sessions) {
        if (pid === playerId) this.clients.getById(sessionId)?.leave(4001, 'Session remplacée');
      }
      player.connected = true;
      if (auth.name) player.name = auth.name;
    } else {
      player = this.spawnPlayer(playerId, auth.name);
      this.state.players.set(playerId, player);
    }

    if (this.emptySince !== null) {
      freezeLaunderWindows(this.state, this.now() - this.emptySince);
      this.emptySince = null;
    }
    this.sessions.set(client.sessionId, playerId);
    // Hors ligne, les jauges sont figées : on repart de maintenant.
    player.survivalAt = this.now();
    this.budgets.set(playerId, freshBudget(Date.now(), this.zoneRules(player.zone)));
    this.cancelEmptyTimer();
    console.log(`[room ${this.roomId}] ${player.name} connecté (${this.sessions.size} session(s))`);
  }

  override onLeave(client: Client): void {
    const playerId = this.sessions.get(client.sessionId);
    this.sessions.delete(client.sessionId);
    if (playerId && ![...this.sessions.values()].includes(playerId)) {
      const player = this.state.players.get(playerId);
      if (player) {
        this.settleVitals(playerId, player);
        player.connected = false;
        this.emptyCart(player);
        this.releaseSales(playerId);
        this.dialogues.end(playerId);
        console.log(`[room ${this.roomId}] ${player.name} déconnecté`);
      }
    }
    if (this.sessions.size === 0) this.armEmptyTimer();
  }

  override onDispose(): void {
    liveRooms.delete(this);
    console.log(`[room ${this.roomId}] fermée`);
  }

  // ---------------------------------------------------------------- horloge et sauvegarde

  /** Temps de jeu courant (ms). */
  now(): number {
    return clockNow(this.gameClock, Date.now());
  }

  private publishClock(): void {
    this.state.clock.now = this.now();
    this.state.clock.scale = this.gameClock.scale;
  }

  snapshot(): RoomSnapshot {
    return {
      code: this.roomId,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      clock: { now: this.now(), scale: this.gameClock.scale },
      state: this.state.toJSON() as RoomSnapshot['state'],
    };
  }

  /** Boucle serveur : termine les découpes dont l'heure est venue. */
  private tick(): void {
    for (const result of completeCuts(this.state, this.now()))
      this.notifyPlayer(result.playerId, result.ok, result.text);
  }

  // ---------------------------------------------------------------- mise en place

  private spawnPlayer(playerId: string, name: string): Player {
    const used = new Set([...this.state.players.values()].map((p) => p.color));
    const color = config.players.colors.find((c) => !used.has(c)) ?? config.players.colors[0]!;
    const index = this.state.players.size;
    const spawn = config.players.spawn;
    const angle = (index / config.room.maxPlayers) * Math.PI * 2;

    const player = new Player();
    player.id = playerId;
    player.name = name || `Joueur ${index + 1}`;
    player.color = color;
    player.bag = makeSlots(config.inventory.bagSlots);
    // Argent de départ : sale dans le sac (physique, confiscable), propre sur le compte.
    const start = add(
      emptyInventory(config.inventory.bagSlots),
      'cash_dirty',
      economy.startingMoney.dirty,
      items,
    );
    writeInventory(player.bag, start.ok ? start.inv : emptyInventory(config.inventory.bagSlots));
    player.cleanBalance = economy.startingMoney.clean;
    Object.assign(player, SURVIVAL.start);
    // Autour du carton de départ, jamais dans un mur.
    const pos = resolveCircle(
      {
        x: spawn.x + Math.cos(angle) * config.players.spawnSpread,
        z: spawn.z + Math.sin(angle) * config.players.spawnSpread,
      },
      STREET_RULES.collision!.radius,
      STREET_RULES.collision!.obstacles,
    );
    player.x = pos.x;
    player.z = pos.z;
    syncArea(player);
    return player;
  }

  // ---------------------------------------------------------------- utilitaires

  /** Joueur associé à une session (null si inconnu). */
  private playerOf(client: Client): { playerId: string; player: Player } | null {
    const playerId = this.sessions.get(client.sessionId);
    const player = playerId ? this.state.players.get(playerId) : undefined;
    return playerId && player ? { playerId, player } : null;
  }

  private notify(
    client: Client,
    ok: boolean,
    text: string,
    extra: Pick<NoticeMessage, 'locationId'> = {},
  ): void {
    const notice: NoticeMessage = { ok, text, ...extra };
    client.send(ServerMsg.Notice, notice);
  }

  /** Notice à toutes les sessions d'un joueur (utile quand l'action finit plus tard). */
  private notifyPlayer(playerId: string, ok: boolean, text: string): void {
    for (const [sessionId, pid] of this.sessions) {
      if (pid !== playerId) continue;
      const client = this.clients.getById(sessionId);
      if (client) this.notify(client, ok, text);
    }
  }

  /** Téléporte un joueur dans une zone (entrée/sortie) : position imposée, crédit remis à neuf. */
  private moveToZone(
    playerId: string,
    player: Player,
    zoneId: string,
    at: { x: number; z: number },
  ) {
    if (zoneId !== player.zone) {
      this.emptyCart(player);
      this.releaseSales(playerId);
      this.dialogues.end(playerId);
    }
    player.zone = zoneId;
    player.x = at.x;
    player.z = at.z;
    syncArea(player);
    this.budgets.set(playerId, freshBudget(Date.now(), this.zoneRules(zoneId)));
  }

  /** Règles de la zone + mobilier installé (obstacles dynamiques du labo). */
  private zoneRules(zoneId: string): MoveRules {
    const rules = rulesFor(zoneId);
    const interior = gameData.interiors.get(zoneId);
    const extra = interior ? furnitureObstacles(this.state, interior) : [];
    if (extra.length === 0 || !rules.collision) return rules;
    return {
      ...rules,
      collision: { ...rules.collision, obstacles: [...rules.collision.obstacles, ...extra] },
    };
  }

  /** Le joueur est-il assez près de ce poste de son intérieur ? */
  private isNear(
    player: Player,
    station: { position: { x: number; z: number }; interactRadius: number },
  ) {
    return (
      distance(player, station.position) <= station.interactRadius + config.world.interactTolerance
    );
  }

  // ---------------------------------------------------------------- messages

  private handleMove(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const { playerId, player } = who;
    const budget = this.budgets.get(playerId);
    if (!budget) return;

    // Position calculée dans une autre zone (message parti avant un changement de zone) : ignorée.
    if (msg.zone !== player.zone) return;
    const proposed = { x: Number(msg.x), z: Number(msg.z) };
    const seq = Number(msg.seq) || 0;
    const rotY = Number(msg.rotY);

    const result = validateMove(player, proposed, budget, Date.now(), this.rulesForPlayer(player));
    this.budgets.set(playerId, result.budget);
    player.x = result.pos.x;
    player.z = result.pos.z;
    syncArea(player);
    if (Number.isFinite(rotY)) player.rotY = rotY;

    if (result.corrected) {
      const correction: CorrectionMessage = { x: result.pos.x, z: result.pos.z, seq };
      client.send(ServerMsg.Correction, correction);
    }
  }

  /** Porte d'un lieu de la rue : entre dans son intérieur s'il existe, sinon simple réplique. */
  private handleInteract(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const { playerId, player } = who;
    const loc = gameData.locations.get(String(msg.locationId ?? ''));
    const action = loc ? locationInteraction(gameData, loc) : null;
    if (!loc || !action) return this.notify(client, false, 'Rien à faire ici.');
    if (player.zone !== STREET) return this.notify(client, false, "Sors d'abord d'ici.");
    const d = distance(player, interactionPoint(loc));
    if (d > loc.interactRadius + config.world.interactTolerance)
      return this.notify(client, false, `Trop loin de : ${loc.name}`, { locationId: loc.id });
    if (action === 'talk') {
      // lieu sans intérieur où l'on parle depuis la rue (repaire d'El Jefe)
      const r = this.dialogues.start(playerId, player, loc.id);
      if (r.ok) client.send(ServerMsg.Dialogue, r.node);
      else this.notify(client, false, r.text);
      return;
    }
    const interior = interiorForLocation(gameData, loc.id)!;
    this.moveToZone(playerId, player, interior.id, interior.spawn);
    this.notify(client, true, loc.enterText ?? loc.name, { locationId: loc.id });
  }

  /** Action sur un poste d'intérieur : zone, poste, distance, puis logique du labo. */
  private handleStation(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const { playerId, player } = who;
    const action = msg.action as StationAction;
    if (!STATION_ACTIONS.includes(action)) return this.notify(client, false, 'Action inconnue.');
    const interior = gameData.interiors.get(player.zone);
    const place = interior
      ? interiorPlaces(interior, fixturesIn(this.state, interior)).find(
          (p) => p.id === msg.stationId,
        )
      : undefined;
    if (!interior || !place) return this.notify(client, false, "Ce poste n'est pas ici.");
    const station = place.station;
    if (!this.isNear(player, place))
      return this.notify(client, false, `Trop loin : ${station.label}`);

    if (station.kind === 'exit') {
      if (action !== 'exit') return this.notify(client, false, `Impossible ici : ${station.label}`);
      const loc = gameData.locations.get(interior.entranceLocationId)!;
      this.moveToZone(playerId, player, STREET, interactionPoint(loc));
      return this.notify(client, true, `Retour dans la rue, devant ${loc.name}.`);
    }
    if (station.kind === 'talk') {
      if (action !== 'talk') return this.notify(client, false, `Impossible ici : ${station.label}`);
      const r = this.dialogues.start(playerId, player, station.id);
      if (r.ok) client.send(ServerMsg.Dialogue, r.node);
      else this.notify(client, false, r.text);
      return;
    }
    if (station.kind === 'teller') {
      const r =
        action === 'launder'
          ? openTeller(player, venueOf(station)!)
          : { ok: false, text: `Impossible ici : ${station.label}` };
      if (!r.ok) return this.notify(client, false, r.text);
      client.send(ServerMsg.LaunderOpen, {
        stationId: station.id,
        venue: venueOf(station)!,
      } satisfies LaunderOpenMessage);
      return;
    }
    if (station.kind === 'shelf' || station.kind === 'counter') {
      const wrong = { ok: false, text: `Impossible ici : ${station.label}` };
      const result =
        station.kind === 'shelf'
          ? action === 'take'
            ? takeItem(this.state, player, interior.id, station)
            : wrong
          : action === 'pay'
            ? pay(player, station)
            : wrong;
      return this.notify(client, result.ok, result.text);
    }
    const result = runStationAction(this.state, player, station, action, this.now());
    this.notify(client, result.ok, result.text);
  }

  /**
   * Meubles du labo : poser (objet du sac), déplacer, reprendre. Règles et validation dans
   * `furniture.ts` ; réponse dédiée (le mode placement du client se ferme si ok) + notice.
   * Les messages sont traités un par un : deux poses au même endroit, la seconde est refusée.
   */
  private handleFurniture(client: Client, msg: unknown, kind: 'place' | 'move' | 'pickup'): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const { player } = who;
    const now = this.now();
    const pos = { x: Number(msg.x), z: Number(msg.z), rot: Number(msg.rot) };
    const fixtureId = String(msg.fixtureId ?? '');
    const r: FurnitureResult =
      kind === 'place'
        ? placeFurniture(this.state, player, { itemId: String(msg.itemId ?? ''), ...pos }, now)
        : kind === 'move'
          ? moveFurniture(this.state, player, { fixtureId, ...pos }, now)
          : pickupFurniture(this.state, player, fixtureId, now);
    const res: FixtureResultMessage = {
      requestId: Number(msg.requestId) || 0,
      ok: r.ok,
      text: r.text,
      ...(r.fixtureId ? { fixtureId: r.fixtureId } : {}),
    };
    client.send(ServerMsg.FixtureResult, res);
    this.notify(client, r.ok, r.text);
  }

  // ---------------------------------------------------------------- survie

  /** Règles de mouvement de la zone, vitesse réduite si faim ou soif sous le seuil bas. */
  private rulesForPlayer(player: Player): MoveRules {
    const rules = this.zoneRules(player.zone);
    const factor = speedFactor(player, SURVIVAL);
    return factor === 1 ? rules : { ...rules, maxSpeed: rules.maxSpeed * factor };
  }

  /** Fait baisser les jauges depuis `survivalAt` (temps de jeu × multiplicateur debug). */
  private settleVitals(playerId: string, player: Player): void {
    const now = this.now();
    const elapsed = (now - player.survivalAt) * this.state.clock.survivalScale;
    player.survivalAt = now;
    if (elapsed <= 0) return;
    const { vitals, ko } = decayVitals(player, elapsed, SURVIVAL);
    Object.assign(player, vitals);
    if (ko) this.knockOut(playerId, player);
  }

  /** Seuls les joueurs connectés s'affament : un joueur hors ligne ne perd rien. */
  private settleAllVitals(): void {
    const online = new Set(this.sessions.values());
    for (const [id, player] of this.state.players)
      if (online.has(id)) this.settleVitals(id, player);
  }

  /** KO : panier rendu, argent sale perdu en partie, réapparition au carton, jauges de reprise. */
  private knockOut(playerId: string, player: Player): void {
    this.emptyCart(player);
    this.releaseSales(playerId);
    const bag = readInventory(player.bag);
    const lost = koCashLoss(count(bag, DIRTY_CASH), SURVIVAL);
    if (lost > 0) {
      const r = remove(bag, DIRTY_CASH, lost, items);
      if (r.ok) writeInventory(player.bag, r.inv);
    }
    Object.assign(player, SURVIVAL.koRecovery);
    player.survivalAt = this.now();
    const spawn = resolveCircle(
      config.players.spawn,
      STREET_RULES.collision!.radius,
      STREET_RULES.collision!.obstacles,
    );
    this.moveToZone(playerId, player, STREET, spawn);
    this.notifyPlayer(
      playerId,
      false,
      `KO ! Tu te réveilles sur ton carton, délesté de ${lost} $. Mange et bois, bon sang.`,
    );
  }

  /** Manger / boire un consommable du sac. */
  private handleUse(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const { playerId, player } = who;
    this.settleVitals(playerId, player);
    const slot = Number(msg.slot);
    const bag = readInventory(player.bag);
    const stack = Number.isInteger(slot) ? bag[slot] : null;
    const def = stack ? items.get(stack.itemId) : undefined;
    if (!stack || !def) return this.notify(client, false, 'Rien à consommer ici.');
    const next = consume(player, def, SURVIVAL);
    if (!next) return this.notify(client, false, `${def.name} ne se mange pas. Ni ne se boit.`);
    const r = remove(bag, def.id, 1, items);
    if (!r.ok) return this.notify(client, false, r.message);
    writeInventory(player.bag, r.inv);
    Object.assign(player, next);
    this.notify(client, true, `${def.name} : ça va mieux.`);
  }

  // ---------------------------------------------------------------- vente de rue

  /** PNJ : simulation + diffusion des positions à cadence réduite ; offres expirées. */
  private npcTick(): void {
    const realNow = Date.now();
    const dt = Math.min(1000, realNow - this.npcTickAt);
    this.npcTickAt = realNow;
    for (const { playerId, npcId } of this.npcs.update(dt, realNow, this.now())) {
      const name = this.state.npcs.get(npcId)?.name ?? 'Le client';
      this.sendToPlayer(playerId, ServerMsg.SaleClosed, { npcId } satisfies SaleClosedMessage);
      this.notifyPlayer(playerId, false, `${name} en a eu marre d'attendre.`);
    }
    this.npcs.publish();
  }

  private sendToPlayer(playerId: string, type: string, payload: unknown): void {
    for (const [sessionId, pid] of this.sessions)
      if (pid === playerId) this.clients.getById(sessionId)?.send(type, payload);
  }

  /** Lâche les offres d'un joueur (déconnexion, changement de zone, KO). */
  private releaseSales(playerId: string): void {
    for (const npcId of this.npcs.releasePlayer(playerId, this.now()))
      this.sendToPlayer(playerId, ServerMsg.SaleClosed, { npcId } satisfies SaleClosedMessage);
  }

  /** « Vendre à <PNJ> » : réserve le PNJ pour ce joueur et lui envoie l'offre. */
  private handleSaleOpen(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const r = this.npcs.open(who.playerId, who.player, String(msg.npcId ?? ''), this.now());
    if (r.ok && r.offer) client.send(ServerMsg.SaleOffer, r.offer);
    else this.notify(client, r.ok, r.text);
  }

  /** « Accepter » : pochons contre argent sale ; événement `sale_completed`. */
  private handleSaleAccept(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const { playerId, player } = who;
    const npcId = String(msg.npcId ?? '');
    const r = this.npcs.accept(playerId, player, npcId, Number(msg.qty), this.now());
    this.notify(client, r.ok, r.text);
    if (!r.ok) return;
    client.send(ServerMsg.SaleClosed, { npcId } satisfies SaleClosedMessage);
    const event: SaleCompletedEvent = {
      playerId,
      npcId,
      qty: r.qty ?? 0,
      amount: r.amount ?? 0,
      x: player.x,
      z: player.z,
      area: r.area ?? '',
    };
    this.events.emit(SALE_COMPLETED, event);
  }

  private handleSaleDecline(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const npcId = String(msg.npcId ?? '');
    if (this.npcs.decline(who.playerId, npcId, this.now())) {
      client.send(ServerMsg.SaleClosed, { npcId } satisfies SaleClosedMessage);
      const name = this.state.npcs.get(npcId)?.name ?? 'Le client';
      this.notify(client, true, `${name} hausse les épaules et s'en va.`);
    }
  }

  /** Réponse choisie dans un dialogue : validée par le serveur, nœud suivant renvoyé. */
  private handleDialogueChoose(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const req = {
      dialogueId: String(msg.dialogueId ?? ''),
      nodeId: String(msg.nodeId ?? ''),
      choiceId: String(msg.choiceId ?? ''),
    };
    const r = this.dialogues.choose(who.playerId, who.player, req, (st) =>
      this.isNear(who.player, st),
    );
    if (!r.ok) this.notify(client, false, r.text);
    else if (r.notice) this.notify(client, true, r.notice);
    const node: DialogueNodeMessage | undefined = r.node;
    if (node) client.send(ServerMsg.Dialogue, node);
  }

  /** Guichet : blanchit un montant ; réponse dédiée + notice, événement `laundered`. */
  private handleLaunder(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const { playerId, player } = who;
    const r = launder(
      player,
      { stationId: String(msg.stationId ?? ''), amount: Number(msg.amount) },
      this.now(),
      (st) => this.isNear(player, st),
    );
    const res: LaunderResultMessage = {
      requestId: Number(msg.requestId) || 0,
      ok: r.ok,
      text: r.text,
    };
    client.send(ServerMsg.LaunderResult, res);
    this.notify(client, r.ok, r.text);
    if (!r.ok) return;
    const event: LaunderedEvent = {
      playerId,
      dirty: r.dirty ?? 0,
      clean: r.clean ?? 0,
      venue: r.venue ?? 'bank',
      area: venueArea(player.zone),
    };
    this.events.emit(LAUNDERED, event);
  }

  /** Panier rendu au rayon (sortie du magasin, déconnexion, KO). */
  private emptyCart(player: Player): void {
    if (player.cart.length > 0 && gameData.shops.has(player.zone))
      returnCart(this.state, player, player.zone);
  }

  /** « Retirer » : repose 1 article du panier (il faut être dans le magasin). */
  private handleCartRemove(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const { player } = who;
    if (!gameData.shops.has(player.zone))
      return this.notify(client, false, "Tu n'es pas dans un magasin.");
    const r = putBack(this.state, player, player.zone, String(msg.stationId ?? ''));
    if (!r.ok) this.notify(client, false, r.text);
  }

  /**
   * Glisser-déposer dans le sac : déplacement / fusion / échange d'une pile entière (le stock
   * commun est désactivé). L'objet attendu protège des mouvements concurrents : si le slot a
   * changé entre-temps, le second est refusé.
   */
  private handleInventoryMove(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const { player } = who;
    const requestId = Number(msg.requestId) || 0;
    const reply = (ok: boolean, text?: string) => {
      const res: MoveResultMessage = text ? { requestId, ok, text } : { requestId, ok };
      client.send(ServerMsg.MoveResult, res);
    };
    const from = isObject(msg.from) ? msg.from : null;
    const to = isObject(msg.to) ? msg.to : null;
    if (!from || !to || from.inv !== 'bag' || to.inv !== 'bag')
      return reply(false, 'Déplacement invalide.');
    const fromSlot = Number(from.slot);
    if (player.bag[fromSlot]?.itemId !== String(msg.itemId ?? ''))
      return reply(false, "L'objet a déjà bougé.");
    const r = moveStack(readInventory(player.bag), fromSlot, null, Number(to.slot), items);
    if (!r.ok) return reply(false, r.message);
    writeInventory(player.bag, r.from);
    reply(true);
  }

  /** Commandes de debug : donner un objet, de l'argent, accélérer le temps. */
  private handleDebug(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    if (!debugEnabled()) return this.notify(client, false, 'Commandes debug désactivées.');
    const { player } = who;
    switch (msg.cmd) {
      case 'give': {
        const r = add(readInventory(player.bag), String(msg.itemId), Number(msg.qty), items);
        if (!r.ok) return this.notify(client, false, r.message);
        writeInventory(player.bag, r.inv);
        return this.notify(client, true, `[debug] ${String(msg.qty)} × ${String(msg.itemId)}`);
      }
      case 'money': {
        const r = add(readInventory(player.bag), DIRTY_CASH, Number(msg.amount), items);
        if (!r.ok) return this.notify(client, false, r.message);
        writeInventory(player.bag, r.inv);
        return this.notify(client, true, `[debug] +${Number(msg.amount)} $`);
      }
      case 'vitals': {
        const value = msg.mode === 'empty' ? 0 : SURVIVAL.max;
        player.hunger = value;
        player.thirst = value;
        if (msg.mode !== 'empty') player.health = SURVIVAL.max;
        player.survivalAt = this.now();
        return this.notify(
          client,
          true,
          `[debug] jauges ${msg.mode === 'empty' ? 'vides' : 'pleines'}`,
        );
      }
      case 'survivalScale': {
        const scale = Number(msg.scale);
        if (!config.debug.timeScales.includes(scale))
          return this.notify(client, false, '[debug] vitesse non autorisée');
        this.settleAllVitals();
        this.state.clock.survivalScale = scale;
        return this.notify(client, true, `[debug] survie x${scale}`);
      }
      case 'openAccount':
        player.hasAccount = true;
        return this.notify(client, true, '[debug] compte ouvert');
      case 'setClean': {
        const amount = Math.max(0, Math.floor(Number(msg.amount) || 0));
        player.cleanBalance = amount;
        writeCart(player, readCart(player)); // « any » réparti selon le nouveau solde
        return this.notify(client, true, `[debug] solde propre = ${amount} $`);
      }
      case 'giveClean': {
        const amount = Math.max(0, Math.floor(Number(msg.amount) || 0));
        player.cleanBalance += amount;
        writeCart(player, readCart(player));
        return this.notify(client, true, `[debug] +${amount} $ propres sur le compte`);
      }
      case 'teleport': {
        const area = gameData.areas.get(String(msg.areaId));
        if (!area) return this.notify(client, false, '[debug] area inconnue');
        this.moveToZone(who.playerId, player, STREET, debugAreaSpot(area.id));
        return this.notify(client, true, `[debug] téléporté : ${area.name}`);
      }
      case 'priceMultiplier': {
        const area = gameData.areas.get(String(msg.areaId));
        const value = AreaSchema.shape.priceMultiplier.safeParse(Number(msg.value));
        if (!area || !value.success)
          return this.notify(client, false, '[debug] area ou multiplicateur invalide');
        // réglage à chaud du processus : s'applique aux prochaines demandes des PNJ
        area.priceMultiplier = value.data;
        return this.notify(
          client,
          true,
          `[debug] ${area.name} : prix ×${value.data} (prochaines demandes)`,
        );
      }
      case 'resetLaunderCap':
        resetLaunderCap(player);
        return this.notify(client, true, '[debug] plafond de blanchiment remis à zéro');
      case 'restock':
        stockShelves(this.state);
        return this.notify(client, true, '[debug] étagères réapprovisionnées');

      case 'equipLab':
      case 'clearLab': {
        const interior = gameData.interiors.get(player.zone);
        if (!interior?.furnishable) return this.notify(client, false, '[debug] va dans le labo');
        if (msg.cmd === 'clearLab') {
          clearLab(this.state);
          refreshPotRates(this.state, this.now());
          return this.notify(client, true, '[debug] labo vidé');
        }
        const n = equipLab(this.state, interior, this.now());
        return this.notify(client, true, `[debug] labo équipé (${n} meuble(s) posé(s))`);
      }
      case 'spawnBuyer': {
        if (player.zone !== STREET) return this.notify(client, false, '[debug] va dans la rue');
        const id = this.npcs.spawnBuyerNear(player);
        const name = id ? this.state.npcs.get(id)?.name : null;
        return this.notify(
          client,
          Boolean(id),
          name ? `[debug] ${name} veut acheter` : '[debug] pas de place ici',
        );
      }
      case 'timeScale': {
        const scale = Number(msg.scale);
        if (!config.debug.timeScales.includes(scale))
          return this.notify(client, false, '[debug] vitesse non autorisée');
        this.gameClock = setClockScale(this.gameClock, scale, Date.now());
        this.publishClock();
        return this.notify(client, true, `[debug] temps x${scale}`);
      }
    }
  }

  // ---------------------------------------------------------------- room vide

  private armEmptyTimer(): void {
    this.cancelEmptyTimer();
    this.emptyTimer = this.clock.setTimeout(
      () => void this.disconnect(),
      config.room.emptyRoomTtlSeconds * 1000,
    );
  }

  private cancelEmptyTimer(): void {
    this.emptyTimer?.clear();
    this.emptyTimer = undefined;
  }
}
