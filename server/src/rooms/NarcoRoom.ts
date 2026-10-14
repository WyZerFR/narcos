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
  interiorForLocation,
  resolveCircle,
  sanitizeName,
  setClockScale,
  transfer,
  validateMove,
  zoneArea,
  type CorrectionMessage,
  type GameClock,
  type Interior,
  type JoinOptions,
  type MoveBudget,
  type MoveRules,
  type NoticeMessage,
  type StationAction,
} from '@narco/shared';
import type { RoomSnapshot } from '../persistence';
import { hydrateState } from '../persistence';
import { completeCut, runStationAction } from './lab';
import { pay, putBack, returnCart, stockShelves, takeItem } from './shop';
import { GameState, Player, Pot } from './schema';
import { makeSlots, readInventory, writeInventory } from './stateSync';

const { config, economy, items } = gameData;

/** Règles de mouvement par zone (rue, intérieurs), calculées une fois. */
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
  return { playerId: o.playerId, name: sanitizeName(o.name, '') };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export interface NarcoRoomOptions {
  /** Partie à restaurer depuis la sauvegarde JSON. */
  restore?: RoomSnapshot;
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
      this.roomId = await uniqueRoomCode();
      this.state.code = this.roomId;
      this.setupLab();
      stockShelves(this.state);
    }
    this.publishClock();
    await this.setPrivate(true);
    this.setPatchRate(config.room.patchRateMs);

    this.onMessage(ClientMsg.Move, (client, msg: unknown) => this.handleMove(client, msg));
    this.onMessage(ClientMsg.Interact, (client, msg: unknown) => this.handleInteract(client, msg));
    this.onMessage(ClientMsg.Station, (client, msg: unknown) => this.handleStation(client, msg));
    this.onMessage(ClientMsg.Transfer, (client, msg: unknown) => this.handleTransfer(client, msg));
    this.onMessage(ClientMsg.Debug, (client, msg: unknown) => this.handleDebug(client, msg));
    this.onMessage(ClientMsg.CartRemove, (client, msg: unknown) =>
      this.handleCartRemove(client, msg),
    );
    this.clock.setInterval(() => this.tick(), TICK_MS);
    this.clock.setInterval(() => this.publishClock(), CLOCK_BROADCAST_MS);
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

    this.sessions.set(client.sessionId, playerId);
    this.budgets.set(playerId, freshBudget(Date.now(), rulesFor(player.zone)));
    this.cancelEmptyTimer();
    console.log(`[room ${this.roomId}] ${player.name} connecté (${this.sessions.size} session(s))`);
  }

  override onLeave(client: Client): void {
    const playerId = this.sessions.get(client.sessionId);
    this.sessions.delete(client.sessionId);
    if (playerId && ![...this.sessions.values()].includes(playerId)) {
      const player = this.state.players.get(playerId);
      if (player) {
        player.connected = false;
        this.emptyCart(player);
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
      clock: { now: this.now(), scale: this.gameClock.scale },
      state: this.state.toJSON() as RoomSnapshot['state'],
    };
  }

  /** Boucle serveur : termine la découpe en cours quand son heure est venue. */
  private tick(): void {
    const result = completeCut(this.state, this.now());
    if (result) this.notifyPlayer(result.playerId, true, result.text);
  }

  // ---------------------------------------------------------------- mise en place

  /** Stock de départ et pots installés au départ (economy.lab). */
  private setupLab(): void {
    const lab = this.state.lab;
    lab.stock = makeSlots(economy.inventory.stockSlots);
    let stock = readInventory(lab.stock);
    for (const { itemId, qty } of economy.lab.startingStock) {
      const r = add(stock, itemId, qty, items);
      if (r.ok) stock = r.inv;
    }
    writeInventory(lab.stock, stock);
    const potStations = [...gameData.interiors.values()].flatMap((i) =>
      i.stations.filter((s) => s.kind === 'pot'),
    );
    for (const st of potStations.slice(0, economy.lab.startPots)) lab.pots.set(st.id, new Pot());
  }

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
    player.bag = makeSlots(economy.inventory.bagSlots);
    // Argent de départ : sale dans le sac (physique, confiscable), propre sur le compte.
    const start = add(
      emptyInventory(economy.inventory.bagSlots),
      'cash_dirty',
      economy.startingMoney.dirty,
      items,
    );
    writeInventory(player.bag, start.ok ? start.inv : emptyInventory(economy.inventory.bagSlots));
    player.cleanMoney = economy.startingMoney.clean;
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
    extra: Pick<NoticeMessage, 'locationId' | 'open'> = {},
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
    if (zoneId !== player.zone) this.emptyCart(player);
    player.zone = zoneId;
    player.x = at.x;
    player.z = at.z;
    this.budgets.set(playerId, freshBudget(Date.now(), rulesFor(zoneId)));
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

    const result = validateMove(player, proposed, budget, Date.now(), rulesFor(player.zone));
    this.budgets.set(playerId, result.budget);
    player.x = result.pos.x;
    player.z = result.pos.z;
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
    if (!loc) return this.notify(client, false, "Ce lieu n'existe pas (encore).");
    if (player.zone !== STREET) return this.notify(client, false, "Sors d'abord d'ici.");
    const d = distance(player, interactionPoint(loc));
    if (d > loc.interactRadius + config.world.interactTolerance)
      return this.notify(client, false, `Trop loin de : ${loc.name}`, { locationId: loc.id });
    const interior = interiorForLocation(gameData, loc.id);
    if (interior) this.moveToZone(playerId, player, interior.id, interior.spawn);
    this.notify(client, true, loc.enterText, { locationId: loc.id });
  }

  /** Action sur un poste d'intérieur : zone, poste, distance, puis logique du labo. */
  private handleStation(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const { playerId, player } = who;
    const action = msg.action as StationAction;
    if (!STATION_ACTIONS.includes(action)) return this.notify(client, false, 'Action inconnue.');
    const interior = gameData.interiors.get(player.zone);
    const station = interior?.stations.find((s) => s.id === msg.stationId);
    if (!interior || !station) return this.notify(client, false, "Ce poste n'est pas ici.");
    if (!this.isNear(player, station))
      return this.notify(client, false, `Trop loin : ${station.label}`);

    if (station.kind === 'exit') {
      if (action !== 'exit') return this.notify(client, false, `Impossible ici : ${station.label}`);
      const loc = gameData.locations.get(interior.entranceLocationId)!;
      this.moveToZone(playerId, player, STREET, interactionPoint(loc));
      return this.notify(client, true, `Retour dans la rue, devant ${loc.name}.`);
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
    this.notify(client, result.ok, result.text, result.open ? { open: result.open } : {});
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

  /** Caisse du stock de l'intérieur courant, si le joueur est à portée. */
  private stockInReach(player: Player): Interior['stations'][number] | null {
    const interior = gameData.interiors.get(player.zone);
    const crate = interior?.stations.find((s) => s.kind === 'stock');
    return crate && this.isNear(player, crate) ? crate : null;
  }

  /** Transfert sac ↔ stock commun, seulement à portée de la caisse. */
  private handleTransfer(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const { player } = who;
    if (!this.stockInReach(player)) return this.notify(client, false, 'Approche-toi de la caisse.');
    const fromBag = msg.from === 'bag';
    if (!fromBag && msg.from !== 'stock') return;
    const slot = Number(msg.slot);
    const qty = Number(msg.qty);
    const source = fromBag ? player.bag : this.state.lab.stock;
    const target = fromBag ? this.state.lab.stock : player.bag;
    if (!Number.isInteger(slot) || slot < 0 || slot >= source.length)
      return this.notify(client, false, 'Slot invalide.');
    const r = transfer(readInventory(source), slot, readInventory(target), qty, items);
    if (!r.ok) return this.notify(client, false, r.message);
    writeInventory(source, r.from);
    writeInventory(target, r.to);
  }

  /** Commandes de debug : donner un objet, vider le stock, accélérer le temps. */
  private handleDebug(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    if (!config.debug.commands) return this.notify(client, false, 'Commandes debug désactivées.');
    const { player } = who;
    switch (msg.cmd) {
      case 'give': {
        const r = add(readInventory(player.bag), String(msg.itemId), Number(msg.qty), items);
        if (!r.ok) return this.notify(client, false, r.message);
        writeInventory(player.bag, r.inv);
        return this.notify(client, true, `[debug] ${String(msg.qty)} × ${String(msg.itemId)}`);
      }
      case 'restock':
        stockShelves(this.state);
        return this.notify(client, true, '[debug] étagères réapprovisionnées');
      case 'clearStock':
        writeInventory(this.state.lab.stock, emptyInventory(this.state.lab.stock.length));
        return this.notify(client, true, '[debug] stock vidé');
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
