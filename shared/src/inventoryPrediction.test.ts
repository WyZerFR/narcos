import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import { moveStack, type Inventory } from './inventory';
import {
  bagSignature,
  predictedBag,
  pruneMoves,
  settleMove,
  type PredictedMove,
} from './inventoryPrediction';

const { items } = gameData;
const waterMax = items.get('water')!.stackMax;
const inv = (...stacks: ([string, number] | null)[]): Inventory =>
  stacks.map((s) => (s ? { itemId: s[0], qty: s[1] } : null));

function pending(server: Inventory, requestId: number, from: number, to: number): PredictedMove {
  return {
    requestId,
    fromSlot: from,
    toSlot: to,
    itemId: server[from]!.itemId,
    base: bagSignature(server),
    confirmed: false,
  };
}

describe('inventaire — prédiction client', () => {
  const server = inv(['water', 2], ['seed_base', 5], ['water', waterMax - 1], null);

  it('déplacement vers un slot vide affiché tout de suite', () => {
    const moves = [pending(server, 1, 1, 3)];
    expect(predictedBag(server, moves, items)).toEqual(
      inv(['water', 2], null, ['water', waterMax - 1], ['seed_base', 5]),
    );
  });

  it('fusion : surplus laissé à la source, comme le serveur', () => {
    const moves = [pending(server, 1, 0, 2)];
    expect(predictedBag(server, moves, items)).toEqual(
      inv(['water', 1], ['seed_base', 5], ['water', waterMax], null),
    );
  });

  it('échange de deux objets différents', () => {
    const moves = [pending(server, 1, 0, 1)];
    expect(predictedBag(server, moves, items)).toEqual(
      inv(['seed_base', 5], ['water', 2], ['water', waterMax - 1], null),
    );
  });

  it('refus du serveur : rollback, le sac redevient celui du serveur', () => {
    let moves = [pending(server, 7, 1, 3)];
    expect(predictedBag(server, moves, items)).not.toEqual(server);
    moves = settleMove(moves, 7, false);
    expect(moves).toHaveLength(0);
    expect(predictedBag(server, moves, items)).toEqual(server);
  });

  it('accord : la prédiction tient jusqu’au patch d’état, puis disparaît sans clignoter', () => {
    let moves = settleMove([pending(server, 3, 1, 3)], 3, true);
    expect(moves[0]!.confirmed).toBe(true);
    const shown = predictedBag(server, moves, items);
    // le patch n'est pas encore arrivé : toujours la prédiction
    expect(pruneMoves(server, moves)).toHaveLength(1);
    // patch reçu : l'état serveur contient le coup, la liste se vide, l'affichage est identique
    const patched = (moveStack(server, 1, null, 3, items) as { ok: true; from: Inventory }).from;
    moves = pruneMoves(patched, moves);
    expect(moves).toHaveLength(0);
    expect(predictedBag(patched, moves, items)).toEqual(shown);
  });

  it('coups enchaînés avant réponse, et coup devenu invalide ignoré', () => {
    const moves = [pending(server, 1, 1, 3), { ...pending(server, 2, 0, 1), itemId: 'water' }];
    expect(predictedBag(server, moves, items)).toEqual(
      inv(null, ['water', 2], ['water', waterMax - 1], ['seed_base', 5]),
    );
    const stale = [{ ...pending(server, 4, 0, 3), itemId: 'food' }];
    expect(predictedBag(server, stale, items)).toEqual(server);
  });
});
