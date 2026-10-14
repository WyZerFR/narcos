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
}

let state: Placement | null = null;
let nextRequest = 1;
const listeners = new Set<() => void>();

function set(next: Placement | null): void {
  state = next;
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

/** Garde le meuble dans la pièce (le serveur refuserait de toute façon). */
function clampIn(p: Placement): Placement {
  const interior = gameData.interiors.get(localPlayer.zone);
  const def = gameData.items.get(p.itemId)?.placeable;
  if (!interior || !def) return p;
  const b = interiorBounds(interior);
  const size = rotatedSize(def, p.rot);
  const cx = Math.min(b.maxX - size.w / 2, Math.max(b.minX + size.w / 2, p.x));
  const cz = Math.min(b.maxZ - size.d / 2, Math.max(b.minZ + size.d / 2, p.z));
  return { ...p, x: snap(cx, stepM), z: snap(cz, stepM) };
}

/** Lance le mode placement ; le personnage s'arrête (joystick et ACTION masqués). */
export function startPlacement(
  init: Pick<Placement, 'mode' | 'itemId' | 'x' | 'z' | 'rot'> & { fixtureId?: string },
): void {
  input.joyX = input.joyY = 0;
  input.up = input.down = input.left = input.right = input.run = false;
  const origin = { x: init.x, z: init.z, rot: normRot(init.rot) };
  set(clampIn({ ...init, rot: origin.rot, origin, pending: null, error: null }));
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
  set(r.ok ? null : { ...state, pending: null, error: r.text });
});
