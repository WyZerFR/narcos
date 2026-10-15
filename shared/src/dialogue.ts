import type {
  Dialogue,
  DialogueAction,
  DialogueChoice,
  DialogueCondition,
  DialogueNode,
  Economy,
  LaunderVenue,
} from './schemas';

/**
 * Dialogues pilotés par les données (`dialogues.json`) : nœud d'entrée, choix disponibles,
 * validation d'un choix. Pur : le serveur s'en sert pour valider, le client pour afficher.
 */

/** Ce que les conditions regardent chez le joueur. */
export interface DialogueContext {
  hasAccount: boolean;
  /** Pacte d'El Jefe conclu (ou non exigé : config.dialogue.requirePact faux), voir `hasPact`. */
  pact: boolean;
}

export function conditionMet(c: DialogueCondition, ctx: DialogueContext): boolean {
  switch (c) {
    case 'account':
      return ctx.hasAccount;
    case 'no_account':
      return !ctx.hasAccount;
    case 'pact':
      return ctx.pact;
    case 'no_pact':
      return !ctx.pact;
  }
}

export const allMet = (requires: readonly DialogueCondition[] | undefined, ctx: DialogueContext) =>
  (requires ?? []).every((c) => conditionMet(c, ctx));

export function dialogueNode(d: Dialogue, nodeId: string): DialogueNode | undefined {
  return d.nodes.find((n) => n.id === nodeId);
}

/** Nœud d'entrée : le premier de `start` dont les conditions sont remplies. */
export function dialogueStart(d: Dialogue, ctx: DialogueContext): DialogueNode | null {
  const entry = d.start.find((s) => allMet(s.requires, ctx));
  return entry ? (dialogueNode(d, entry.node) ?? null) : null;
}

/** Choix proposés au joueur sur ce nœud. */
export function availableChoices(node: DialogueNode, ctx: DialogueContext): DialogueChoice[] {
  return node.choices.filter((c) => allMet(c.requires, ctx));
}

export type ChooseResult =
  { ok: true; next: string | null; action?: DialogueAction } | { ok: false; message: string };

/** Valide un choix sur le nœud courant. */
export function chooseInDialogue(
  d: Dialogue,
  nodeId: string,
  choiceId: string,
  ctx: DialogueContext,
): ChooseResult {
  const node = dialogueNode(d, nodeId);
  if (!node) return { ok: false, message: 'Cette conversation est terminée.' };
  const choice = node.choices.find((c) => c.id === choiceId);
  if (!choice) return { ok: false, message: 'Réponse inconnue.' };
  if (!allMet(choice.requires, ctx)) return { ok: false, message: 'Cette réponse ne tient plus.' };
  return { ok: true, next: choice.next, ...(choice.action ? { action: choice.action } : {}) };
}

/**
 * Variables utilisables dans les textes : `{fee}` / `{cap}` / `{window}` = commission (%),
 * plafond ($) et fenêtre du plafond (min) du
 * lieu de blanchiment du dialogue (banque par défaut), `{pactSeeds}` = graines d'El Jefe.
 */
export function dialogueVars(
  economy: Pick<Economy, 'launder' | 'pact'>,
  venue: LaunderVenue = 'bank',
): Record<string, string> {
  const rules = economy.launder.venues[venue];
  return {
    fee: String(Math.round(rules.fee * 100)),
    cap: String(rules.cap),
    window: String(Math.round(rules.windowSeconds / 60)),
    pactSeeds: String(economy.pact.startSeeds),
  };
}

/** Le joueur a-t-il le pacte au sens des dialogues (conclu, ou non exigé par la config) ? */
export function hasPact(pactAccepted: boolean, requirePact: boolean): boolean {
  return pactAccepted || !requirePact;
}

/** Remplace `{nom}` par sa valeur ; une variable inconnue reste telle quelle. */
export function fillText(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m);
}

/** Variables citées dans un texte. */
export function textVars(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}
