import { useEffect, useState } from 'react';
import { ClientMsg, gameData, type DebugMessage } from '@narco/shared';
import { connection, type PlayerView } from '../net/connection';
import { subscribeState } from '../net/gameView';

const CHARACTERS = [...gameData.characters.values()];

function send(msg: DebugMessage): void {
  const room = connection.getSnapshot().room;
  if (room?.connection.isOpen) room.send(ClientMsg.Debug, msg);
}

/** Debug personnages : force le modèle de n'importe quel joueur (même si le choix est figé). */
export function DebugCharacterSection() {
  const [players, setPlayers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    const room = connection.getSnapshot().room;
    if (!room) return;
    return subscribeState(room, () => {
      const list: { id: string; name: string }[] = [];
      room.state.players?.forEach((p: PlayerView) => list.push({ id: p.id, name: p.name }));
      setPlayers((prev) =>
        prev.map((p) => p.id + p.name).join() === list.map((p) => p.id + p.name).join()
          ? prev
          : list,
      );
    });
  }, []);
  return (
    <>
      <div className="cam-section">Debug personnages</div>
      <div className="cam-actions">
        {players.flatMap((p) =>
          CHARACTERS.map((c) => (
            <button
              key={`${p.id}:${c.id}`}
              type="button"
              className="btn"
              onClick={() => send({ cmd: 'setCharacter', playerId: p.id, characterId: c.id })}
            >
              {p.name} → {c.name}
            </button>
          )),
        )}
      </div>
    </>
  );
}
