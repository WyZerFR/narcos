import { Client, ErrorCode, type Room } from 'colyseus.js';
import type { Camera, Scene, WebGLRenderer } from 'three';
import {
  ROOM_NAME,
  ServerMsg,
  gameData,
  normalizeRoomCode,
  type CorrectionMessage,
  type NoticeMessage,
  type MoveResultMessage,
  type FixtureResultMessage,
  type SaleClosedMessage,
  type SaleOfferMessage,
  type DialogueNodeMessage,
  type LaunderOpenMessage,
  type LaunderResultMessage,
  type JoinOptions,
} from '@narco/shared';
import { syncClock } from './gameView';
import {
  getAccessCode,
  getPlayerId,
  getSavedName,
  getSavedRoomCode,
  saveName,
  saveRoomCode,
} from './identity';

/** Vue client du state serveur (`server/src/rooms/schema.ts`), décodé par réflexion. */
export interface PlayerView {
  id: string;
  name: string;
  color: string;
  x: number;
  z: number;
  rotY: number;
  connected: boolean;
  zone: string;
  area: string;
  bag: SlotView[];
  /** 0 = poches, 1 = sac à dos (economy.bag). */
  bagTier: number;
  cleanBalance: number;
  hasAccount: boolean;
  pactAccepted: boolean;
  launderLog: { at: number; amount: number }[];
  cellarLaunderLog: { at: number; amount: number }[];
  cart: CartLineView[];
  cartTotal: number;
  cartDirty: number;
  cartClean: number;
  hunger: number;
  thirst: number;
  health: number;
}

export interface CartLineView {
  stationId: string;
  itemId: string;
  qty: number;
  unitPrice: number;
  currency: string;
}

export interface SlotView {
  itemId: string;
  qty: number;
}

export interface PotView {
  planted: boolean;
  strainId: string;
  growMsDone: number;
  bankedAt: number;
  wateredUntil: number;
  rate: number;
}

export interface RackEntryView {
  strainId: string;
  qty: number;
  readyAt: number;
}

export interface CutJobView {
  playerId: string;
  strainId: string;
  qty: number;
  readyAt: number;
}

export interface NpcView {
  id: string;
  name: string;
  profileId: string;
  x: number;
  z: number;
  rotY: number;
  interested: boolean;
  strainId: string;
  qty: number;
  unitPrice: number;
  busyWith: string;
}

export interface StateView {
  code: string;
  players: Map<string, PlayerView>;
  lab: {
    /** Meubles posés (clé = id du meuble) : objet, position, rotation (quarts de tour). */
    fixtures: Map<string, { itemId: string; x: number; z: number; rot: number }>;
    pots: Map<string, PotView>;
    racks: Map<string, { entries: RackEntryView[] }>;
    cuts: Map<string, CutJobView>;
  };
  clock: { now: number; scale: number; survivalScale: number };
  shelves: Map<string, { stock: number }>;
  npcs: Map<string, NpcView>;
}

export type GameRoom = Room<StateView>;

export type Status = 'idle' | 'connecting' | 'connected' | 'reconnecting';

export interface Snapshot {
  status: Status;
  code: string | null;
  room: GameRoom | null;
  error: string | null;
  attempt: number;
}

const { room: roomCfg, net } = gameData.config;

/** Masqué plus longtemps que ça, on considère le socket comme suspect (iOS) et on le renouvelle. */
const STALE_AFTER_HIDDEN_MS = 3000;

/** Le serveur demande-t-il un code d'accès ? (même origine que le jeu) */
export async function fetchServerInfo(): Promise<{ accessRequired: boolean }> {
  try {
    const res = await fetch(`${location.origin}/colyseus/info`, { cache: 'no-store' });
    if (!res.ok) return { accessRequired: false };
    const info = (await res.json()) as { accessRequired?: unknown };
    return { accessRequired: info.accessRequired === true };
  } catch {
    return { accessRequired: false };
  }
}

function endpoint(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/colyseus`;
}

function errorMessage(err: unknown): string {
  const e = err as { code?: number; message?: string };
  if (e?.code === ErrorCode.MATCHMAKE_INVALID_ROOM_ID) return 'Aucune partie avec ce code.';
  if (e?.message) return e.message;
  return 'Connexion impossible au serveur.';
}

/** Erreurs après lesquelles réessayer ne sert à rien. */
function isFatal(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  return code === ErrorCode.MATCHMAKE_INVALID_ROOM_ID || code === 403 || code === 400;
}

type CorrectionListener = (c: CorrectionMessage) => void;
type NoticeListener = (n: NoticeMessage) => void;
type MoveResultListener = (r: MoveResultMessage) => void;
type FixtureResultListener = (r: FixtureResultMessage) => void;
type DialogueListener = (n: DialogueNodeMessage) => void;
type LaunderListener = (e: { open: LaunderOpenMessage } | { result: LaunderResultMessage }) => void;
type SaleListener = (e: { offer: SaleOfferMessage } | { closed: SaleClosedMessage }) => void;

class Connection {
  private client = new Client(endpoint());
  private listeners = new Set<() => void>();
  private correctionListeners = new Set<CorrectionListener>();
  private noticeListeners = new Set<NoticeListener>();
  private moveResultListeners = new Set<MoveResultListener>();
  private fixtureResultListeners = new Set<FixtureResultListener>();
  private saleListeners = new Set<SaleListener>();
  private dialogueListeners = new Set<DialogueListener>();
  private launderListeners = new Set<LaunderListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenAt: number | null = null;
  private joining = false;

  private snapshot: Snapshot = {
    status: 'idle',
    code: null,
    room: null,
    error: null,
    attempt: 0,
  };

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pageshow', this.onResume);
    window.addEventListener('online', this.onResume);
  }

  // ---------- store pour React (useSyncExternalStore) ----------
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): Snapshot => this.snapshot;

  private set(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** Offres de vente : ouverture (panneau) et fermeture (vente, refus, patience épuisée). */
  /** Nœud de dialogue à afficher (null = fin). */
  onDialogue(fn: DialogueListener): () => void {
    this.dialogueListeners.add(fn);
    return () => this.dialogueListeners.delete(fn);
  }

  /** Guichet : ouverture du panneau, réponse à un blanchiment. */
  onLaunder(fn: LaunderListener): () => void {
    this.launderListeners.add(fn);
    return () => this.launderListeners.delete(fn);
  }

  onSale(fn: SaleListener): () => void {
    this.saleListeners.add(fn);
    return () => this.saleListeners.delete(fn);
  }

  onMoveResult(fn: MoveResultListener): () => void {
    this.moveResultListeners.add(fn);
    return () => this.moveResultListeners.delete(fn);
  }

  /** Réponse du serveur à une pose / un déplacement / une reprise de meuble. */
  onFixtureResult(fn: FixtureResultListener): () => void {
    this.fixtureResultListeners.add(fn);
    return () => this.fixtureResultListeners.delete(fn);
  }

  onNotice(fn: NoticeListener): () => void {
    this.noticeListeners.add(fn);
    return () => this.noticeListeners.delete(fn);
  }

  /** Message local affiché comme une notice serveur (refus décidé côté client). */
  localNotice(n: NoticeMessage): void {
    for (const fn of this.noticeListeners) fn(n);
  }

  onCorrection(fn: CorrectionListener): () => void {
    this.correctionListeners.add(fn);
    return () => this.correctionListeners.delete(fn);
  }

  get playerId(): string {
    return getPlayerId();
  }

  private joinOptions(): JoinOptions {
    const accessCode = getAccessCode();
    return { playerId: getPlayerId(), name: getSavedName(), ...(accessCode ? { accessCode } : {}) };
  }

  // ---------- actions du lobby ----------
  async create(name: string): Promise<void> {
    saveName(name);
    this.set({ status: 'connecting', error: null });
    try {
      const room = await this.client.create<StateView>(ROOM_NAME, this.joinOptions());
      this.attach(room);
    } catch (err) {
      this.set({ status: 'idle', error: errorMessage(err) });
    }
  }

  async join(rawCode: string, name: string): Promise<void> {
    const code = normalizeRoomCode(rawCode, roomCfg.codeAlphabet, roomCfg.codeLength);
    if (!code) {
      this.set({ error: `Le code fait ${roomCfg.codeLength} lettres.` });
      return;
    }
    saveName(name);
    this.set({ status: 'connecting', error: null });
    try {
      const room = await this.client.joinById<StateView>(code, this.joinOptions());
      this.attach(room);
    } catch (err) {
      this.set({ status: 'idle', error: errorMessage(err) });
    }
  }

  /** Au lancement : si on était dans une partie (rechargement iOS), on y retourne. */
  resumeSavedRoom(): void {
    const code = getSavedRoomCode();
    if (code && this.snapshot.status === 'idle') {
      this.set({ status: 'reconnecting', code, attempt: 0 });
      void this.tryReconnect();
    }
  }

  async leave(): Promise<void> {
    this.clearReconnectTimer();
    saveRoomCode(null);
    const room = this.snapshot.room;
    this.set({ status: 'idle', room: null, code: null, attempt: 0, error: null });
    if (room) await room.leave(true).catch(() => undefined);
  }

  // ---------- cycle de vie de la room ----------
  private attach(room: GameRoom): void {
    this.clearReconnectTimer();
    saveRoomCode(room.roomId);

    room.onStateChange(() => syncClock(room));
    room.onMessage(ServerMsg.MoveResult, (r: MoveResultMessage) => {
      for (const fn of this.moveResultListeners) fn(r);
    });
    room.onMessage(ServerMsg.FixtureResult, (r: FixtureResultMessage) => {
      for (const fn of this.fixtureResultListeners) fn(r);
    });
    room.onMessage(ServerMsg.SaleOffer, (offer: SaleOfferMessage) => {
      for (const fn of this.saleListeners) fn({ offer });
    });
    room.onMessage(ServerMsg.SaleClosed, (closed: SaleClosedMessage) => {
      for (const fn of this.saleListeners) fn({ closed });
    });
    room.onMessage(ServerMsg.Dialogue, (n: DialogueNodeMessage) => {
      for (const fn of this.dialogueListeners) fn(n);
    });
    room.onMessage(ServerMsg.LaunderOpen, (open: LaunderOpenMessage) => {
      for (const fn of this.launderListeners) fn({ open });
    });
    room.onMessage(ServerMsg.LaunderResult, (result: LaunderResultMessage) => {
      for (const fn of this.launderListeners) fn({ result });
    });
    room.onMessage(ServerMsg.Notice, (n: NoticeMessage) => {
      for (const fn of this.noticeListeners) fn(n);
    });
    room.onMessage(ServerMsg.Correction, (c: CorrectionMessage) => {
      for (const fn of this.correctionListeners) fn(c);
    });
    room.onLeave((code) => {
      if (this.snapshot.room !== room) return; // ancienne room remplacée volontairement
      console.info(`[net] socket fermé (code ${code})`);
      if (this.snapshot.status === 'idle') return;
      this.set({ room: null });
      this.scheduleReconnect();
    });
    room.onError((code, message) => console.warn(`[net] erreur room ${code}: ${message ?? ''}`));

    this.set({ status: 'connected', room, code: room.roomId, attempt: 0, error: null });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.joining || !this.snapshot.code) return;
    const backoff = net.reconnectBackoffMs;
    const attempt = this.snapshot.attempt;
    const delay = Math.min(
      backoff[Math.min(attempt, backoff.length - 1)] ?? net.reconnectMaxDelayMs,
      net.reconnectMaxDelayMs,
    );
    this.set({ status: 'reconnecting' });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryReconnect();
    }, delay);
  }

  private async tryReconnect(): Promise<void> {
    const code = this.snapshot.code;
    if (!code || this.joining) return;
    this.joining = true;
    this.set({ status: 'reconnecting', attempt: this.snapshot.attempt + 1 });
    try {
      const room = await this.client.joinById<StateView>(code, this.joinOptions());
      this.joining = false;
      if (this.snapshot.status === 'idle') {
        // le joueur a quitté pendant la tentative
        await room.leave(true);
        return;
      }
      console.info(`[net] reconnecté à ${code}`);
      this.attach(room);
    } catch (err) {
      this.joining = false;
      if (isFatal(err)) {
        saveRoomCode(null);
        this.set({ status: 'idle', room: null, code: null, attempt: 0, error: errorMessage(err) });
        return;
      }
      this.scheduleReconnect();
    }
  }

  /** Force un nouveau socket (l'ancien est peut-être à moitié mort après une veille iOS). */
  private renewNow(): void {
    if (!this.snapshot.code || this.snapshot.status === 'idle') return;
    this.clearReconnectTimer();
    const old = this.snapshot.room;
    this.set({ room: null });
    if (old) old.connection.close();
    void this.tryReconnect();
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.hiddenAt = Date.now();
      return;
    }
    const hiddenFor = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
    this.hiddenAt = null;
    const room = this.snapshot.room;
    if (!room || !room.connection.isOpen || hiddenFor > STALE_AFTER_HIDDEN_MS) this.renewNow();
  };

  private onResume = (): void => {
    const room = this.snapshot.room;
    if (this.snapshot.code && (!room || !room.connection.isOpen)) this.renewNow();
  };

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Debug : simule une coupure réseau brutale (console : `narco.dropSocket()`). */
  dropSocket(): void {
    this.snapshot.room?.connection.close();
  }
}

export const connection = new Connection();

declare global {
  interface Window {
    narco?: {
      connection: Connection;
      dropSocket: () => void;
      /** Renseigné par la scène en mode debug. */
      three?: { gl: WebGLRenderer; scene: Scene; camera: Camera };
      /** Position prédite du joueur local (debug). */
      local?: { x: number; z: number; rotY: number; seq: number; initialized: boolean };
      /** Exécute une frame complète à la demande (useFrame + rendu), utile hors écran. */
      advance?: () => void;
    };
  }
}
window.narco = { connection, dropSocket: () => connection.dropSocket() };
