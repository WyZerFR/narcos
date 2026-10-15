import type {
  Dialogue,
  DialogueAction,
  DialogueChoice,
  DialogueCondition,
  DialogueNode,
  Economy,
} from './schemas';

/**
 * Dialogues pilotés par les données (`dialogues.json`) : nœud d'entrée, choix disponibles,
 * validation d'un choix. Pur : le serveur s'en sert pour valider, le client pour afficher.
 */

/** Ce que les conditions regardent chez le joueur. */
export interface DialogueContext {
  hasAccount: boolean;
  /** Pacte d'El Jefe conclu (ou non exigé : config.dialogue.requirePact faux). */
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
  | { ok: true; next: string | null; action?: DialogueAction }
  | { ok: false; message: string };

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

/** Variables utilisables dans les textes (`{fee}` = commission de la banque en %). */
export function dialogueVars(economy: Pick<Economy, 'bank'>): Record<string, string> {
  return { fee: String(Math.round(economy.bank.fee * 100)) };
}

/** Remplace `{nom}` par sa valeur ; une variable inconnue reste telle quelle. */
export function fillText(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m);
}

/** Variables citées dans un texte. */
export function textVars(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}
