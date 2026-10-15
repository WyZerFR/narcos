import { useEffect, useState } from 'react';
import {
  availableChoices,
  ClientMsg,
  dialogueNode,
  dialogueVars,
  fillText,
  gameData,
  hasPact,
  type DialogueChooseMessage,
  type DialogueContext,
  type DialogueNodeMessage,
} from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';
import { useRoomVersion } from '../net/gameView';
import { localPlayer, stillAt } from '../game/localPlayer';

/**
 * Dialogue avec un personnage (courtier, El Jefe, plus tard les vendeurs) : nom, texte,
 * boutons de réponse. Textes et choix viennent de dialogues.json ; le serveur valide chaque
 * choix et renvoie le nœud suivant (null = fin). Placé en bas au centre, entre joystick et ACTION.
 */
export function DialoguePanel({ room }: { room: GameRoom }) {
  const [current, setCurrent] = useState<(DialogueNodeMessage & { zone: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  useRoomVersion(room); // conditions (compte ouvert) relues quand l'état change

  useEffect(
    () =>
      connection.onDialogue((n) => {
        setSent(false);
        setError(null);
        setCurrent(n.nodeId ? { ...n, zone: localPlayer.zone } : null);
      }),
    [],
  );
  useEffect(
    () =>
      connection.onNotice((n) => {
        if (!n.ok) {
          setError(n.text);
          setSent(false);
        }
      }),
    [],
  );

  // sortie de la pièce ou du rayon de sortie du poste : la conversation s'arrête
  useEffect(() => {
    if (!current) return;
    const id = setInterval(() => {
      if (!stillAt(current.zone, current.stationId)) setCurrent(null);
    }, 250);
    return () => clearInterval(id);
  }, [current]);

  if (!current?.nodeId) return null;
  const dialogue = gameData.dialogues.get(current.dialogueId)!;
  const node = dialogueNode(dialogue, current.nodeId);
  const me = room.state.players?.get(connection.playerId);
  if (!node || !me) return null;
  const ctx: DialogueContext = {
    hasAccount: me.hasAccount,
    pact: hasPact(me.pactAccepted, gameData.config.dialogue.requirePact),
  };
  const choose = (choiceId: string) => {
    if (!room.connection.isOpen || sent) return;
    const msg: DialogueChooseMessage = {
      dialogueId: current.dialogueId,
      nodeId: node.id,
      choiceId,
    };
    room.send(ClientMsg.DialogueChoose, msg);
    setSent(true);
  };

  return (
    <div className="sale-panel dialogue-panel" role="dialog" aria-label={node.speaker}>
      <h3>💬 {node.speaker}</h3>
      <p className="dialogue-text">
        {fillText(node.text, dialogueVars(gameData.economy, dialogue.venue))}
      </p>
      {error && <div className="sale-error">{error}</div>}
      <div className="dialogue-choices">
        {availableChoices(node, ctx).map((c) => (
          <button
            key={c.id}
            type="button"
            className="btn"
            disabled={sent}
            onClick={() => choose(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
