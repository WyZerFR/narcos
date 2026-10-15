import { useSyncExternalStore } from 'react';
import {
  checkPlacement,
  ClientMsg,
  gameData,
  interiorBounds,
  normRot,
  rotatedSize,
  snap,
  type FixtureMoveMessage,
  type FixturePlaceMessage,
  type PlacementResult,
  type Vec2,
} from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';
import { localPlayer } from '../game/localPlayer';
import { labFixtures } from '../game/fixtureState';
import { screenToWorld } from '../game/cameraState';
import { input } from '../input/inputState';

/**
 * Mode placement d'un meuble (client) : position et rotation du fantôme, envoi de l'intention,
 * attente de la réponse serveur. Le serveur valide avec la même fonction pure que le fantôme.
 */

const { stepM } = gameData.config.placement;

export interface Placement {
  /** `place` : objet du sac ; `move` : meuble déjà posé (sa position d'origine est gardée). */
  mode: 'place' | 'move';
  itemId: string;
  fixtureId?: string;
  x: number;
  z: number;
  rot: number;
  origin: { x: number; z: number; rot: number };
  /** Requête envoyée, en attente de réponse. */
  pending: number | null;
  /** Dernier refus du serveur (affiché jusqu'au prochain mouvement). */
  error: string | null;
  /**
   * Glisser direct d'un meuble posé (appui long dans la scène) : pas de panneau ni de caméra
   * haute ; au lâcher, envoi immédiat si valide, sinon retour animé à l'origine.
   */
  direct?: boolean;
}

/**
 * Glisser en cours (doigt ou souris) : position vivante du fantôme, mutée à chaque mouvement
 * sans re-rendu React ; recopiée dans l'état au lâcher.
 */
export const drag = { active: false, x: 0, z: 0 };

/** Retour animé à l'origine après un refus (lu par le fantôme à chaque frame). */
let returning: { fromX: number; fromZ: number; start: number } | null = null;
let returnTimer: ReturnType<typeof setTimeout> | null = null;
const { returnMs } = gameData.config.ui;

let state: Placement | null = null;
let nextRequest = 1;
const listeners = new Set<() => void>();

function set(next: Placement | null): void {
  state = next;
  if (!next) {
    drag.active = false;
    returning = null;
    if (returnTimer) clearTimeout(returnTimer);
    returnTimer = null;
  }
  for (const fn of listeners) fn();
}

export function getPlacement(): Placement | null {
  return state;
}

export function usePlacement(): Placement | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

/** Position dans la pièce, alignée sur le pas (le serveur refuserait de toute façon). */
function clampXZ(itemId: string, rot: number, x: number, z: number): { x: number; z: number } {
  const interior = gameData.interiors.get(localPlayer.zone);
  const def = gameData.items.get(itemId)?.placeable;
  if (!interior || !def) return { x, z };
  const b = interiorBounds(interior);
  const size = rotatedSize(def, rot);
  const cx = Math.min(b.maxX - size.w / 2, Math.max(b.minX + size.w / 2, x));
  const cz = Math.min(b.maxZ - size.d / 2, Math.max(b.minZ + size.d / 2, z));
  return { x: snap(cx, stepM), z: snap(cz, stepM) };
}

function clampIn(p: Placement): Placement {
  return { ...p, ...clampXZ(p.itemId, p.rot, p.x, p.z) };
}

/** Lance le mode placement ; le personnage s'arrête (joystick et ACTION masqués). */
export function startPlacement(
  init: Pick<Placement, 'mode' | 'itemId' | 'x' | 'z' | 'rot'> & {
    fixtureId?: string;
    direct?: boolean;
  },
): void {
  input.joyX = input.joyY = 0;
  input.up = input.down = input.left = input.right = input.run = false;
  const origin = { x: init.x, z: init.z, rot: normRot(init.rot) };
  set(clampIn({ ...init, rot: origin.rot, origin, pending: null, error: null }));
}

/** Position affichée du fantôme : glisser en cours, retour animé, sinon l'état. */
export function livePosition(p: Placement, now = performance.now()): { x: number; z: number } {
  if (drag.active) return drag;
  if (returning) {
    const t = Math.min(1, (now - returning.start) / returnMs);
    const e = 1 - (1 - t) * (1 - t);
    return {
      x: returning.fromX + (p.origin.x - returning.fromX) * e,
      z: returning.fromZ + (p.origin.z - returning.fromZ) * e,
    };
  }
  return p;
}

/** Hauteur du fantôme : soulevé pendant un glisser direct, redescend pendant le retour. */
export function liftOf(p: Placement): number {
  return p.direct && (drag.active || returning || p.pending !== null)
    ? gameData.config.placement.liftM
    : 0;
}

/** Attrape le fantôme au point `at` du sol ; `offset` = fantôme − point (garde la prise). */
let grab = { dx: 0, dz: 0 };
export function beginDrag(at: { x: number; z: number }): boolean {
  if (!state || state.pending !== null || returning) return false;
  grab = { dx: state.x - at.x, dz: state.z - at.z };
  Object.assign(drag, { active: true, x: state.x, z: state.z });
  return true;
}

export function dragTo(at: { x: number; z: number }): void {
  if (!state || !drag.active) return;
  Object.assign(drag, clampXZ(state.itemId, state.rot, at.x + grab.dx, at.z + grab.dz));
}

/** Retour animé à l'origine, puis fermeture du mode avec le message de refus. */
function returnToOrigin(from: { x: number; z: number }, message: string): void {
  if (!state) return;
  returning = { fromX: from.x, fromZ: from.z, start: performance.now() };
  set({ ...state, pending: null, error: message });
  returnTimer = setTimeout(() => {
    set(null);
    connection.localNotice({ ok: false, text: message });
  }, returnMs);
}

/**
 * Lâcher : la position vivante devient celle de l'état. En glisser direct, envoi immédiat si
 * la position est valide, sinon retour à l'origine avec le message clair.
 */
export function endDrag(room: GameRoom): void {
  if (!state || !drag.active) return;
  const at = { x: drag.x, z: drag.z };
  drag.active = false;
  const next = { ...state, ...at, error: null };
  if (!next.direct) return set(next);
  if (next.x === next.origin.x && next.z === next.origin.z) return set(null);
  const check = checkCurrent(room, next);
  if (!check?.ok) return returnToOrigin(at, check?.message ?? 'Position invalide.');
  set(next);
  confirmPlacement(room);
  const sent = state?.pending ?? null;
  returnTimer = setTimeout(() => {
    if (state && sent !== null && state.pending === sent)
      returnToOrigin(state, 'Pas de réponse du serveur.');
  }, gameData.config.ui.moveTimeoutMs);
}

/** Glisser interrompu (pointeur perdu) : retour à l'origine sans rien envoyer. */
export function abortDrag(): void {
  if (!state || !drag.active) return;
  drag.active = false;
  if (state.direct) set(null);
}

/** Position de départ d'un objet du sac : devant le joueur, alignée sur le pas. */
export function startPlacingItem(itemId: string): void {
  startPlacement({
    mode: 'place',
    itemId,
    x: snap(localPlayer.x, stepM),
    z: snap(localPlayer.z - 1.6, stepM),
    rot: 0,
  });
}

/**
 * Décale le fantôme d'un pas dans une direction écran (x = droite, y = haut), convertie en
 * direction monde selon la caméra puis ramenée à l'axe dominant (grille du labo).
 */
export function nudge(screenX: number, screenY: number): void {
  if (!state || state.pending !== null) return;
  const w = screenToWorld(screenX, screenY);
  const dx = Math.abs(w.x) >= Math.abs(w.z) ? Math.sign(w.x) * stepM : 0;
  const dz = Math.abs(w.z) > Math.abs(w.x) ? Math.sign(w.z) * stepM : 0;
  set(clampIn({ ...state, x: state.x + dx, z: state.z + dz, error: null }));
}

export function rotatePlacement(): void {
  if (!state || state.pending !== null) return;
  set(clampIn({ ...state, rot: normRot(state.rot + 1), error: null }));
}

export function cancelPlacement(): void {
  set(null);
}

/** Joueurs de la pièce (le local à sa position prédite) : on ne pose pas un meuble sur eux. */
function playersHere(room: GameRoom): Vec2[] {
  const out: Vec2[] = [];
  room.state.players?.forEach((p) => {
    if (p.zone !== localPlayer.zone) return;
    out.push(p.id === connection.playerId ? { x: localPlayer.x, z: localPlayer.z } : p);
  });
  return out;
}

/** Validité de la position courante (même règle que le serveur). */
export function checkCurrent(room: GameRoom, p: Placement): PlacementResult | null {
  const interior = gameData.interiors.get(localPlayer.zone);
  if (!interior) return null;
  return checkPlacement(
    gameData,
    { interior, fixtures: labFixtures(room), players: playersHere(room) },
    {
      itemId: p.itemId,
      x: p.x,
      z: p.z,
      rot: p.rot,
      ...(p.fixtureId ? { ignoreId: p.fixtureId } : {}),
    },
  );
}

/** Envoie l'intention ; le mode se ferme à la réponse positive du serveur. */
export function confirmPlacement(room: GameRoom): void {
  if (!state || state.pending !== null || !room.connection.isOpen) return;
  const requestId = nextRequest++;
  const { x, z, rot } = state;
  if (state.mode === 'move' && state.fixtureId) {
    const msg: FixtureMoveMessage = { requestId, fixtureId: state.fixtureId, x, z, rot };
    room.send(ClientMsg.FixtureMove, msg);
  } else {
    const msg: FixturePlaceMessage = { requestId, itemId: state.itemId, x, z, rot };
    room.send(ClientMsg.FixturePlace, msg);
  }
  set({ ...state, pending: requestId, error: null });
}

connection.onFixtureResult((r) => {
  if (!state || r.requestId !== state.pending) return;
  if (r.ok) set(null);
  else if (state.direct) returnToOrigin(state, r.text);
  else set({ ...state, pending: null, error: r.text });
});
