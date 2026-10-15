import {
  add,
  chooseInDialogue,
  dialogueStart,
  gameData,
  hasPact,
  interactionPoint,
  STREET,
  type DialogueAction,
  type DialogueContext,
  type DialogueNodeMessage,
  type LaunderVenue,
  type Vec2,
} from '@narco/shared';
import type { Player } from './schema';
import { readInventory, writeInventory } from './stateSync';

/**
 * Dialogues côté serveur : conversation en cours par joueur (en mémoire, non sauvegardée),
 * validation de chaque choix (zone, proximité du personnage, conditions), exécution des actions.
 * On parle à un poste « talk » d'un intérieur, ou depuis la rue devant un lieu à `dialogue`
 * (repaire d'El Jefe).
 */

const { config, dialogues, economy, items } = gameData;

export function dialogueContext(
  player: Pick<Player, 'hasAccount' | 'pactAccepted'>,
): DialogueContext {
  return {
    hasAccount: player.hasAccount,
    pact: hasPact(player.pactAccepted, config.dialogue.requirePact),
  };
}

/** Résultat d'une action : refus (rien n'a changé) ou fait, avec un message éventuel. */
type ActionOutcome = { refused: string } | { done: string | null };

/** Actions de dialogue, exécutées uniquement par le serveur. */
const ACTIONS: Record<DialogueAction, (player: Player, venue: LaunderVenue) => ActionOutcome> = {
  open_account: (player) => {
    if (player.hasAccount) return { refused: 'Votre compte est déjà ouvert.' };
    player.hasAccount = true;
    return { done: null };
  },
  // graines une seule fois par joueur ; sac plein = pacte non conclu, on peut revenir
  accept_pact: (player) => {
    if (player.pactAccepted) return { refused: 'Le pacte est déjà conclu.' };
    const { startSeeds, seedItemId } = economy.pact;
    const r = add(readInventory(player.bag), seedItemId, startSeeds, items);
    const name = items.get(seedItemId)?.name ?? seedItemId;
    if (!r.ok)
      return { refused: `Sac plein : fais de la place pour ${startSeeds} × ${name} et reviens.` };
    writeInventory(player.bag, r.inv);
    player.pactAccepted = true;
    return { done: `Pacte conclu : +${startSeeds} × ${name} dans ton sac.` };
  },
  // le panneau de blanchiment du lieu est ouvert par la room (message LaunderOpen)
  open_launder: (player, venue) => {
    const rules = economy.launder.venues[venue];
    if (rules.requireAccount && !player.hasAccount) return { refused: rules.noAccountText };
    return { done: null };
  },
};

/** Personnage à qui l'on parle : poste « talk » d'un intérieur, ou lieu de la rue. */
interface Speaker {
  id: string;
  name: string;
  dialogue: string | undefined;
  position: Vec2;
  interactRadius: number;
}

function speakerAt(zone: string, id: string): Speaker | undefined {
  if (zone === STREET) {
    const loc = gameData.locations.get(id);
    if (!loc?.dialogue) return undefined;
    const at = interactionPoint(loc);
    return {
      id,
      name: loc.name,
      dialogue: loc.dialogue,
      position: at,
      interactRadius: loc.interactRadius,
    };
  }
  const st = gameData.interiors.get(zone)?.stations.find((s) => s.id === id);
  if (st?.kind !== 'talk') return undefined;
  const name = st.vendor ?? st.label;
  return {
    id,
    name,
    dialogue: st.dialogue,
    position: st.position,
    interactRadius: st.interactRadius,
  };
}

interface Talk {
  dialogueId: string;
  stationId: string;
  zone: string;
  nodeId: string;
}

export type DialogueReply =
  | { ok: true; node: DialogueNodeMessage; action?: DialogueAction; notice?: string }
  | { ok: false; text: string; node?: DialogueNodeMessage };

export interface ChooseRequest {
  dialogueId: string;
  nodeId: string;
  choiceId: string;
}

export class DialogueDesk {
  private talks = new Map<string, Talk>();

  /**
   * « Parler » : ouvre au nœud d'entrée le dialogue du poste `talk` (intérieur) ou du lieu
   * (rue) `speakerId`, dans la zone du joueur. La proximité est vérifiée par l'appelant.
   */
  start(playerId: string, player: Player, speakerId: string): DialogueReply {
    const speaker = speakerAt(player.zone, speakerId);
    if (!speaker) return { ok: false, text: 'Personne à qui parler ici.' };
    const d = speaker.dialogue ? dialogues.get(speaker.dialogue) : undefined;
    if (!d) return { ok: false, text: `${speaker.name} n'a rien à dire.` };
    const node = dialogueStart(d, dialogueContext(player));
    if (!node) return { ok: false, text: `${speaker.name} vous ignore.` };
    this.talks.set(playerId, {
      dialogueId: d.id,
      stationId: speaker.id,
      zone: player.zone,
      nodeId: node.id,
    });
    return { ok: true, node: { dialogueId: d.id, stationId: speaker.id, nodeId: node.id } };
  }

  /**
   * Choix d'une réponse : la conversation doit être en cours sur ce nœud, le joueur dans la
   * zone et à portée du personnage, le choix autorisé par ses conditions.
   */
  choose(
    playerId: string,
    player: Player,
    req: ChooseRequest,
    isNear: (speaker: { position: Vec2; interactRadius: number }) => boolean,
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
    const speaker = speakerAt(player.zone, talk.stationId);
    if (player.zone !== talk.zone || !speaker) return close("Vous n'êtes plus au comptoir.");
    if (!isNear(speaker)) return { ok: false, text: `Trop loin : ${speaker.name}` };
    const r = chooseInDialogue(d, req.nodeId, req.choiceId, dialogueContext(player));
    if (!r.ok) return { ok: false, text: r.message };
    const outcome = r.action ? ACTIONS[r.action](player, d.venue ?? 'bank') : { done: null };
    if ('refused' in outcome) return close(outcome.refused);
    if (r.next === null) this.talks.delete(playerId);
    else this.talks.set(playerId, { ...talk, nodeId: r.next });
    return {
      ok: true,
      node: { dialogueId: d.id, stationId: talk.stationId, nodeId: r.next },
      ...(r.action ? { action: r.action } : {}),
      ...(outcome.done ? { notice: outcome.done } : {}),
    };
  }

  /** Joueur parti (zone, déconnexion) : conversation oubliée. */
  end(playerId: string): void {
    this.talks.delete(playerId);
  }
}
