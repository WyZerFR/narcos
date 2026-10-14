import { matchMaker, Room, ServerError, type Client, type Delayed } from '@colyseus/core';
import {
  ClientMsg,
  ServerMsg,
  freshBudget,
  gameData,
  generateRoomCode,
  resolveCircle,
  sanitizeName,
  validateMove,
  distance,
  interactionPoint,
  interiorForLocation,
  STATION_ACTIONS,
  STREET,
  zoneArea,
  type StationAction,
  type CorrectionMessage,
  type NoticeMessage,
  type JoinOptions,
  type MoveBudget,
  type MoveRules,
} from '@narco/shared';
import { GameState, Player } from './schema';

const { config } = gameData;

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

export class NarcoRoom extends Room<GameState> {
  override maxClients = config.room.maxPlayers + GHOST_SLOTS;
  override autoDispose = false;
  override state = new GameState();

  /** sessionId -> playerId */
  private sessions = new Map<string, string>();
  private budgets = new Map<string, MoveBudget>();
  private emptyTimer: Delayed | undefined;

  override async onCreate(): Promise<void> {
    this.roomId = await uniqueRoomCode();
    this.state.code = this.roomId;
    await this.setPrivate(true);
    this.setPatchRate(config.room.patchRateMs);

    this.onMessage(ClientMsg.Move, (client, msg: unknown) => this.handleMove(client, msg));
    this.onMessage(ClientMsg.Interact, (client, msg: unknown) => this.handleInteract(client, msg));
    this.onMessage(ClientMsg.Station, (client, msg: unknown) => this.handleStation(client, msg));
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
        console.log(`[room ${this.roomId}] ${player.name} déconnecté`);
      }
    }
    if (this.sessions.size === 0) this.armEmptyTimer();
  }

  override onDispose(): void {
    console.log(`[room ${this.roomId}] fermée`);
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

  /** Joueur associé à une session (null si inconnu). */
  private playerOf(client: Client): { playerId: string; player: Player } | null {
    const playerId = this.sessions.get(client.sessionId);
    const player = playerId ? this.state.players.get(playerId) : undefined;
    return playerId && player ? { playerId, player } : null;
  }

  private notify(client: Client, ok: boolean, text: string, locationId?: string): void {
    const notice: NoticeMessage = locationId ? { ok, text, locationId } : { ok, text };
    client.send(ServerMsg.Notice, notice);
  }

  /** Téléporte un joueur dans une zone (entrée/sortie) : position imposée, crédit remis à neuf. */
  private moveToZone(
    playerId: string,
    player: Player,
    zoneId: string,
    at: { x: number; z: number },
  ) {
    player.zone = zoneId;
    player.x = at.x;
    player.z = at.z;
    this.budgets.set(playerId, freshBudget(Date.now(), rulesFor(zoneId)));
  }

  private handleMove(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || typeof msg !== 'object' || msg === null) return;
    const { playerId, player } = who;
    const budget = this.budgets.get(playerId);
    if (!budget) return;

    const m = msg as Record<string, unknown>;
    // Position calculée dans une autre zone (message parti avant un changement de zone) : ignorée.
    if (m.zone !== player.zone) return;
    const proposed = { x: Number(m.x), z: Number(m.z) };
    const seq = Number(m.seq) || 0;
    const rotY = Number(m.rotY);

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
    if (!who || typeof msg !== 'object' || msg === null) return;
    const { playerId, player } = who;
    const locationId = String((msg as Record<string, unknown>).locationId ?? '');
    const loc = gameData.locations.get(locationId);
    if (!loc) return this.notify(client, false, "Ce lieu n'existe pas (encore).");
    if (player.zone !== STREET) return this.notify(client, false, "Sors d'abord d'ici.");
    const d = distance(player, interactionPoint(loc));
    if (d > loc.interactRadius + config.world.interactTolerance)
      return this.notify(client, false, `Trop loin de : ${loc.name}`, loc.id);
    const interior = interiorForLocation(gameData, loc.id);
    if (interior) this.moveToZone(playerId, player, interior.id, interior.spawn);
    this.notify(client, true, loc.enterText, loc.id);
  }

  /** Action sur un poste d'intérieur. Vérifie zone, poste, distance et type d'action. */
  private handleStation(client: Client, msg: unknown): void {
    const who = this.playerOf(client);
    if (!who || typeof msg !== 'object' || msg === null) return;
    const { playerId, player } = who;
    const m = msg as Record<string, unknown>;
    const action = m.action as StationAction;
    if (!STATION_ACTIONS.includes(action)) return this.notify(client, false, 'Action inconnue.');
    const interior = gameData.interiors.get(player.zone);
    const station = interior?.stations.find((s) => s.id === m.stationId);
    if (!interior || !station) return this.notify(client, false, "Ce poste n'est pas ici.");
    if (
      distance(player, station.position) >
      station.interactRadius + config.world.interactTolerance
    )
      return this.notify(client, false, `Trop loin : ${station.label}`);

    if (station.kind === 'exit' && action === 'exit') {
      const loc = gameData.locations.get(interior.entranceLocationId)!;
      this.moveToZone(playerId, player, STREET, interactionPoint(loc));
      return this.notify(client, true, `Retour dans la rue, devant ${loc.name}.`);
    }
    this.notify(client, false, `Impossible ici : ${station.label}`);
  }

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
