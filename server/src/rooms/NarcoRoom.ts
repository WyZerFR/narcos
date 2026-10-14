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
  interiorPlaces,
  isBlocked,
  isSolidFixture,
  rectFromCenter,
  resolveCircle,
  sanitizeName,
  setClockScale,
  transfer,
  validateMove,
  zoneArea,
  type CorrectionMessage,
  type Fixture,
  type GameClock,
  type Interior,
  type JoinOptions,
  type MoveBudget,
  type MoveRules,
  type NoticeMessage,
  type MoveResultMessage,
  moveStack,
  type StationAction,
} from '@narco/shared';
import type { RoomSnapshot } from '../persistence';
import { hydrateState, SNAPSHOT_SCHEMA_VERSION } from '../persistence';
import {
  clearAll,
  equipAll,
  installedIds,
  installedObstacles,
  installFixture,
  refreshPotRates,
  uninstallFixture,
} from './fixtures';
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
import { pay, putBack, returnCart, stockShelves, takeItem } from './shop';
import { GameState, Player } from './schema';
import { makeSlots, readInventory, writeInventory } from './stateSync';

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
    this.onMessage(ClientMsg.Use, (client, msg: unknown) => this.handleUse(client, msg));
    this.onMessage(ClientMsg.InventoryMove, (client, msg: unknown) =>
      this.handleInventoryMove(client, msg),
    );
    this.onMessage(ClientMsg.Fixture, (client, msg: unknown) => this.handleFixture(client, msg));
    this.onMessage(ClientMsg.CartRemove, (client, msg: unknown) =>
      this.handleCartRemove(client, msg),
    );
    this.clock.setInterval(() => this.tick(), TICK_MS);
    this.clock.setInterval(() => this.publishClock(), CLOCK_BROADCAST_MS);
    this.clock.setInterval(() => this.settleAllVitals(), CLOCK_BROADCAST_MS);
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
      this.notifyPlayer(result.playerId, true, result.text);
  }

  // ---------------------------------------------------------------- mise en place

  /** Stock de départ (economy.lab). Le labo est vide : on l'équipe au Bricoshop. */
  private setupLab(): void {
    const lab = this.state.lab;
    lab.stock = makeSlots(economy.inventory.stockSlots);
    let stock = readInventory(lab.stock);
    for (const { itemId, qty } of economy.lab.startingStock) {
      const r = add(stock, itemId, qty, items);
      if (r.ok) stock = r.inv;
    }
    writeInventory(lab.stock, stock);
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
    this.budgets.set(playerId, freshBudget(Date.now(), this.zoneRules(zoneId)));
  }

  /** Règles de la zone + mobilier installé (obstacles dynamiques du labo). */
  private zoneRules(zoneId: string): MoveRules {
    const rules = rulesFor(zoneId);
    const interior = gameData.interiors.get(zoneId);
    const extra = interior ? installedObstacles(this.state, interior) : [];
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
    const place = interior
      ? interiorPlaces(interior, installedIds(this.state)).find((p) => p.id === msg.stationId)
      : undefined;
    if (!interior || !place) return this.notify(client, false, "Ce poste n'est pas ici.");
    const label = place.station?.label ?? place.fixture?.label ?? place.id;
    if (!this.isNear(player, place)) return this.notify(client, false, `Trop loin : ${label}`);
    const station = place.station;
    if (!station) return this.notify(client, false, "Rien n'est installé ici.");

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

  /** Installer / démonter du mobilier : zone, emplacement, distance, puis règles du labo. */
  private handleFixture(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || !isObject(msg)) return;
    const { player } = who;
    const interior = gameData.interiors.get(player.zone);
    const fixture = interior?.fixtures.find((f) => f.id === msg.fixtureId);
    if (!interior || !fixture) return this.notify(client, false, "Cet emplacement n'est pas ici.");
    if (!this.isNear(player, fixture))
      return this.notify(client, false, `Trop loin : ${fixture.label}`);
    const now = this.now();
    if (msg.action === 'install') {
      const blocker = this.standingOn(interior.id, fixture);
      if (blocker) return this.notify(client, false, `${blocker} est dans le passage.`);
      const r = installFixture(this.state, player, interior, fixture, now);
      return this.notify(client, r.ok, r.text);
    }
    if (msg.action === 'uninstall') {
      const r = uninstallFixture(this.state, player, interior, fixture, now);
      return this.notify(client, r.ok, r.text);
    }
    this.notify(client, false, 'Action inconnue.');
  }

  /** Nom d'un joueur debout sur l'emplacement (on n'installe pas un meuble sur quelqu'un). */
  private standingOn(zoneId: string, fixture: Fixture): string | null {
    if (!isSolidFixture(fixture)) return null;
    const rect = rectFromCenter(fixture.position, fixture.size);
    for (const p of this.state.players.values())
      if (p.zone === zoneId && isBlocked(p, config.world.playerRadius, [rect])) return p.name;
    return null;
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
  /**
   * Glisser-déposer : déplacement / fusion / échange d'une pile entière. Sac ↔ sac partout ;
   * tout ce qui touche le stock commun exige d'être près de la caisse. L'objet attendu protège
   * des mouvements concurrents : si le slot a changé entre-temps, le second est refusé.
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
    const kinds = ['bag', 'stock'];
    if (!from || !to || !kinds.includes(String(from.inv)) || !kinds.includes(String(to.inv)))
      return reply(false, 'Déplacement invalide.');
    if ((from.inv === 'stock' || to.inv === 'stock') && !this.stockInReach(player))
      return reply(false, 'Approche-toi de la caisse pour toucher au stock.');
    const slotsOf = (inv: unknown) => (inv === 'bag' ? player.bag : this.state.lab.stock);
    const source = slotsOf(from.inv);
    const target = slotsOf(to.inv);
    const fromSlot = Number(from.slot);
    if (source[fromSlot]?.itemId !== String(msg.itemId ?? ''))
      return reply(false, "L'objet a déjà bougé.");
    const same = from.inv === to.inv;
    const r = moveStack(
      readInventory(source),
      fromSlot,
      same ? null : readInventory(target),
      Number(to.slot),
      items,
    );
    if (!r.ok) return reply(false, r.message);
    writeInventory(source, r.from);
    if (!same) writeInventory(target, r.to);
    reply(true);
  }

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
      case 'restock':
        stockShelves(this.state);
        return this.notify(client, true, '[debug] étagères réapprovisionnées');
      case 'clearStock':
        writeInventory(this.state.lab.stock, emptyInventory(this.state.lab.stock.length));
        return this.notify(client, true, '[debug] stock vidé');
      case 'equipLab':
      case 'clearLab': {
        const interior = gameData.interiors.get(player.zone);
        if (!interior?.fixtures.length)
          return this.notify(client, false, '[debug] va dans le labo');
        if (msg.cmd === 'equipLab') equipAll(this.state, interior, this.now());
        else clearAll(this.state, interior);
        refreshPotRates(this.state, interior, this.now());
        return this.notify(
          client,
          true,
          `[debug] labo ${msg.cmd === 'equipLab' ? 'équipé' : 'vidé'}`,
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
