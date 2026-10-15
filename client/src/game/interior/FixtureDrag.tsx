import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Plane, Raycaster, Vector2, Vector3 } from 'three';
import {
  expandRect,
  fixtureAt,
  fixtureUser,
  gameData,
  rectFromCenter,
  rotatedSize,
  type Occupant,
  type Vec2,
} from '@narco/shared';
import { connection, type GameRoom } from '../../net/connection';
import { readCut } from '../../net/gameView';
import { input } from '../../input/inputState';
import { labFixtures } from '../fixtureState';
import { localPlayer } from '../localPlayer';
import {
  abortDrag,
  beginDrag,
  drag,
  dragTo,
  endDrag,
  getPlacement,
  startPlacement,
} from '../../ui/placementStore';

const { longPressMs, dragCancelPx } = gameData.config.ui;
const { grabMarginM } = gameData.config.placement;
const tolerance = gameData.config.world.interactTolerance;

/** Joueurs de la pièce (le local à sa position prédite). */
function occupants(room: GameRoom): Occupant[] {
  const out: Occupant[] = [];
  room.state.players?.forEach((p) => {
    if (p.zone !== localPlayer.zone) return;
    const pos = p.id === connection.playerId ? localPlayer : p;
    out.push({ id: p.id, name: p.name, x: pos.x, z: pos.z });
  });
  return out;
}

const inRect = (at: Vec2, r: { minX: number; maxX: number; minZ: number; maxZ: number }) =>
  at.x >= r.minX && at.x <= r.maxX && at.z >= r.minZ && at.z <= r.maxZ;

/**
 * Glisser des meubles au doigt ou à la souris (labo). Pas de rendu : écoute les pointeurs du
 * canvas et projette sur le sol.
 * - appui long (`ui.longPressMs`) sur un meuble posé : il se soulève et suit le pointeur ;
 *   un mouvement avant la fin de l'appui (`ui.dragCancelPx`) l'annule, un tap ne fait rien ;
 * - en mode placement (inventaire, « Déplacer ») : le fantôme s'attrape directement.
 * Les commandes à l'écran (joystick, ACTION) sont du DOM au-dessus : elles ne passent pas ici.
 */
export function FixtureDrag({ room }: { room: GameRoom }) {
  const gl = useThree((s) => s.gl);
  const get = useThree((s) => s.get);

  useEffect(() => {
    const el = gl.domElement;
    const ray = new Raycaster();
    const floor = new Plane(new Vector3(0, 1, 0), 0);
    const hit = new Vector3();
    const ndc = new Vector2();
    let pointer: number | null = null;
    let press: ReturnType<typeof setTimeout> | null = null;
    let start = { x: 0, y: 0 };

    const ground = (e: PointerEvent): Vec2 | null => {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, get().camera);
      return ray.ray.intersectPlane(floor, hit) ? { x: hit.x, z: hit.z } : null;
    };
    const release = () => {
      if (press) clearTimeout(press);
      press = null;
      if (pointer !== null && el.hasPointerCapture(pointer)) el.releasePointerCapture(pointer);
      pointer = null;
    };
    const capture = (id: number) => {
      pointer = id;
      el.setPointerCapture(id);
    };

    const onDown = (e: PointerEvent) => {
      if (pointer !== null || e.button !== 0) return;
      const at = ground(e);
      if (!at) return;
      const pl = getPlacement();
      if (pl) {
        // fantôme du mode placement : attrapé tout de suite s'il est sous le doigt
        const def = gameData.items.get(pl.itemId)?.placeable;
        if (pl.direct || !def) return;
        const rect = expandRect(rectFromCenter(pl, rotatedSize(def, pl.rot)), grabMarginM);
        if (inRect(at, rect) && beginDrag(at)) capture(e.pointerId);
        return;
      }
      // joystick tenu par un autre doigt : pas d'appui long
      if (input.joyX !== 0 || input.joyY !== 0) return;
      const f = fixtureAt(at, labFixtures(room));
      if (!f) return;
      pointer = e.pointerId;
      start = { x: e.clientX, y: e.clientY };
      press = setTimeout(() => {
        press = null;
        if (getPlacement()) return release();
        const cutter = readCut(room, f.id)?.playerId || undefined;
        const user = fixtureUser(f, occupants(room), connection.playerId, tolerance, cutter);
        if (user) {
          connection.localNotice({ ok: false, text: `${user} utilise ce poste.` });
          return release();
        }
        startPlacement({
          mode: 'move',
          direct: true,
          fixtureId: f.id,
          itemId: f.itemId,
          x: f.position.x,
          z: f.position.z,
          rot: f.rot,
        });
        if (beginDrag(at)) capture(e.pointerId);
        else release();
      }, longPressMs);
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if (press) {
        // bougé avant la fin de l'appui long : ce n'était pas pour le meuble
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > dragCancelPx) release();
        return;
      }
      const at = drag.active ? ground(e) : null;
      if (at) dragTo(at);
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      release();
      endDrag(room);
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      release();
      abortDrag();
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    return () => {
      release();
      abortDrag();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
    };
  }, [gl, get, room]);

  return null;
}
