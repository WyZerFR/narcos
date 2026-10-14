import { moveStack, type Inventory, type ItemLookup } from './inventory';

/**
 * Prédiction côté client des glisser-déposer du sac : le déplacement s'affiche tout de suite,
 * puis le serveur tranche. Refus → la prédiction est retirée (rollback). Accord → elle reste
 * jusqu'à ce que l'état serveur change (le patch arrive après la réponse), pour éviter un
 * clignotement. Pur, sans état : le client garde la liste des coups en attente.
 */

export interface PredictedMove {
  requestId: number;
  fromSlot: number;
  toSlot: number;
  /** Objet attendu dans le slot de départ (même garde que le serveur). */
  itemId: string;
  /** Signature du sac serveur au moment de l'envoi. */
  base: string;
  /** Le serveur a accepté ; on attend son patch d'état. */
  confirmed: boolean;
}

export const bagSignature = (inv: Inventory): string =>
  inv.map((s) => (s ? `${s.itemId}×${s.qty}` : '-')).join(',');

/** Coup déjà présent dans l'état serveur (accepté, et le sac a changé depuis l'envoi). */
const applied = (m: PredictedMove, signature: string) => m.confirmed && m.base !== signature;

/** Sac à afficher : état serveur + coups en attente rejoués dans l'ordre (les invalides sautés). */
export function predictedBag(
  server: Inventory,
  moves: readonly PredictedMove[],
  items: ItemLookup,
): Inventory {
  const signature = bagSignature(server);
  let inv = server;
  for (const m of moves) {
    if (applied(m, signature) || inv[m.fromSlot]?.itemId !== m.itemId) continue;
    const r = moveStack(inv, m.fromSlot, null, m.toSlot, items);
    if (r.ok) inv = r.from;
  }
  return inv;
}

/** Réponse du serveur : accord → confirmé ; refus → retiré (rollback). */
export function settleMove(
  moves: readonly PredictedMove[],
  requestId: number,
  ok: boolean,
): PredictedMove[] {
  return ok
    ? moves.map((m) => (m.requestId === requestId ? { ...m, confirmed: true } : m))
    : moves.filter((m) => m.requestId !== requestId);
}

/** Retire les coups acceptés que l'état serveur contient désormais. */
export function pruneMoves(server: Inventory, moves: readonly PredictedMove[]): PredictedMove[] {
  const signature = bagSignature(server);
  return moves.filter((m) => !applied(m, signature));
}
