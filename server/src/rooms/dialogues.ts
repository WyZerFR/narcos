import {
  chooseInDialogue,
  dialogueStart,
  gameData,
  type DialogueAction,
  type DialogueContext,
  type DialogueNodeMessage,
  type Station,
} from '@narco/shared';
import type { Player } from './schema';

/**
 * Dialogues côté serveur : conversation en cours par joueur (en mémoire, non sauvegardée),
 * validation de chaque choix (zone, proximité du personnage, conditions), exécution des actions.
 */

const { config, dialogues } = gameData;

export function dialogueContext(player: Pick<Player, 'hasAccount'>): DialogueContext {
  return { hasAccount: player.hasAccount, pact: !config.dialogue.requirePact };
}

/** Actions de dialogue : renvoient un refus, ou null si c'est fait. */
const ACTIONS: Record<DialogueAction, (player: Player) => string | null> = {
  open_account: (player) => {
    if (player.hasAccount) return 'Votre compte est déjà ouvert.';
    player.hasAccount = true;
    return null;
  },
};

interface Talk {
  dialogueId: string;
  stationId: string;
  zone: string;
  nodeId: string;
}

export type DialogueReply =
  | { ok: true; node: DialogueNodeMessage; action?: DialogueAction }
  | { ok: false; text: string; node?: DialogueNodeMessage };

export interface ChooseRequest {
  dialogueId: string;
  nodeId: string;
  choiceId: string;
}

export class DialogueDesk {
  private talks = new Map<string, Talk>();

  /** « Parler » sur un poste `talk` : ouvre son dialogue au nœud d'entrée. */
  start(playerId: string, player: Player, station: Station): DialogueReply {
    const d = station.dialogue ? dialogues.get(station.dialogue) : undefined;
    if (!d) return { ok: false, text: `${station.vendor ?? station.label} n'a rien à dire.` };
    const node = dialogueStart(d, dialogueContext(player));
    if (!node) return { ok: false, text: `${station.vendor ?? station.label} vous ignore.` };
    this.talks.set(playerId, {
      dialogueId: d.id,
      stationId: station.id,
      zone: player.zone,
      nodeId: node.id,
    });
    return { ok: true, node: { dialogueId: d.id, stationId: station.id, nodeId: node.id } };
  }

  /**
   * Choix d'une réponse : la conversation doit être en cours sur ce nœud, le joueur dans la
   * zone et à portée du personnage, le choix autorisé par ses conditions.
   */
  choose(
    playerId: string,
    player: Player,
    req: ChooseRequest,
    isNear: (station: Station) => boolean,
  ): DialogueReply {
    const talk = this.talks.get(playerId);
    const d = dialogues.get(req.dialogueId);
    if (!talk || !d || talk.dialogueId !== req.dialogueId || talk.nodeId !== req.nodeId) {
      const ended = { dialogueId: req.dialogueId, stationId: talk?.stationId ?? '', nodeId: null };
      return { ok: false, text: 'Cette conversation est terminée.', node: ended };
    }
    const close = (text: string): DialogueReply => {
      this.talks.delete(playerId);
      return {
        ok: false,
        text,
        node: { dialogueId: d.id, stationId: talk.stationId, nodeId: null },
      };
    };
    const station = gameData.interiors
      .get(player.zone)
      ?.stations.find((s) => s.id === talk.stationId);
    if (player.zone !== talk.zone || !station) return close("Vous n'êtes plus au comptoir.");
    if (!isNear(station)) return { ok: false, text: `Trop loin : ${station.label}` };
    const r = chooseInDialogue(d, req.nodeId, req.choiceId, dialogueContext(player));
    if (!r.ok) return { ok: false, text: r.message };
    if (r.action) {
      const refused = ACTIONS[r.action](player);
      if (refused) return close(refused);
    }
    if (r.next === null) this.talks.delete(playerId);
    else this.talks.set(playerId, { ...talk, nodeId: r.next });
    return {
      ok: true,
      node: { dialogueId: d.id, stationId: talk.stationId, nodeId: r.next },
      ...(r.action ? { action: r.action } : {}),
    };
  }

  /** Joueur parti (zone, déconnexion) : conversation oubliée. */
  end(playerId: string): void {
    this.talks.delete(playerId);
  }
}
