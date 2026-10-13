import { matchMaker, Room, ServerError, type Client, type Delayed } from '@colyseus/core';
import {
  ClientMsg,
  ServerMsg,
  freshBudget,
  gameData,
  generateRoomCode,
  obstaclesFrom,
  resolveCircle,
  sanitizeName,
  validateMove,
  distance,
  interactionPoint,
  type CorrectionMessage,
  type NoticeMessage,
  type JoinOptions,
  type MoveBudget,
  type MoveRules,
} from '@narco/shared';
import { GameState, Player } from './schema';

const { config } = gameData;

const MOVE_RULES: MoveRules = {
  maxSpeed: config.movement.runSpeed,
  toleranceFactor: config.movement.toleranceFactor,
  maxBurstMs: config.movement.maxBurstMs,
  bounds: config.world.bounds,
  collision: { radius: config.world.playerRadius, obstacles: obstaclesFrom(gameData) },
};

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
    this.budgets.set(playerId, freshBudget(Date.now(), MOVE_RULES));
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
      MOVE_RULES.collision!.radius,
      MOVE_RULES.collision!.obstacles,
    );
    player.x = pos.x;
    player.z = pos.z;
    return player;
  }

  private handleMove(client: Client, msg: unknown): void {
    const playerId = this.sessions.get(client.sessionId);
    const player = playerId ? this.state.players.get(playerId) : undefined;
    const budget = playerId ? this.budgets.get(playerId) : undefined;
    if (!playerId || !player || !budget || typeof msg !== 'object' || msg === null) return;

    const m = msg as Record<string, unknown>;
    const proposed = { x: Number(m.x), z: Number(m.z) };
    const seq = Number(m.seq) || 0;
    const rotY = Number(m.rotY);

    const result = validateMove(player, proposed, budget, Date.now(), MOVE_RULES);
    this.budgets.set(playerId, result.budget);
    player.x = result.pos.x;
    player.z = result.pos.z;
    if (Number.isFinite(rotY)) player.rotY = rotY;

    if (result.corrected) {
      const correction: CorrectionMessage = { x: result.pos.x, z: result.pos.z, seq };
      client.send(ServerMsg.Correction, correction);
    }
  }

  /** Entrée dans un lieu : simple vérification de distance, pas encore de gameplay. */
  private handleInteract(client: Client, msg: unknown): void {
    const playerId = this.sessions.get(client.sessionId);
    const player = playerId ? this.state.players.get(playerId) : undefined;
    if (!player || typeof msg !== 'object' || msg === null) return;
    const locationId = String((msg as Record<string, unknown>).locationId ?? '');
    const loc = gameData.locations.get(locationId);
    let notice: NoticeMessage;
    if (!loc) {
      notice = { ok: false, text: "Ce lieu n'existe pas (encore)." };
    } else {
      const d = distance(player, interactionPoint(loc));
      notice =
        d <= loc.interactRadius + config.world.interactTolerance
          ? { ok: true, text: loc.enterText, locationId: loc.id }
          : { ok: false, text: `Trop loin de : ${loc.name}`, locationId: loc.id };
    }
    client.send(ServerMsg.Notice, notice);
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
