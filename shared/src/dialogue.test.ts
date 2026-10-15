import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import {
  availableChoices,
  chooseInDialogue,
  dialogueStart,
  dialogueVars,
  fillText,
  type DialogueContext,
} from './dialogue';

const banker = gameData.dialogues.get('banker')!;
const noAccount: DialogueContext = { hasAccount: false, pact: true };
const withAccount: DialogueContext = { hasAccount: true, pact: true };

describe('dialogues — courtier', () => {
  it('entrée selon le compte : bonjour sans compte, « compte ouvert » sinon', () => {
    expect(dialogueStart(banker, noAccount)?.id).toBe('hello');
    expect(dialogueStart(banker, withAccount)?.id).toBe('already_open');
  });

  it('conditions : « ouvrir un compte » seulement sans compte ; pacte exigé si demandé', () => {
    const hello = banker.nodes.find((n) => n.id === 'hello')!;
    expect(availableChoices(hello, noAccount).map((c) => c.id)).toEqual(['ask_account', 'nothing']);
    expect(availableChoices(hello, withAccount).map((c) => c.id)).toEqual(['nothing']);
    const refs = banker.nodes.find((n) => n.id === 'references')!;
    expect(availableChoices(refs, { hasAccount: false, pact: false }).map((c) => c.id)).toEqual([
      'never_mind',
    ]);
  });

  it('parcours : références, offre, accepter → action open_account ; refuser → fin relançable', () => {
    expect(chooseInDialogue(banker, 'hello', 'ask_account', noAccount)).toEqual({
      ok: true,
      next: 'references',
    });
    expect(chooseInDialogue(banker, 'references', 'jefe', noAccount)).toMatchObject({
      next: 'offer',
    });
    expect(chooseInDialogue(banker, 'offer', 'accept', noAccount)).toEqual({
      ok: true,
      next: 'welcome',
      action: 'open_account',
    });
    expect(chooseInDialogue(banker, 'offer', 'refuse', noAccount)).toEqual({
      ok: true,
      next: 'refused',
    });
    expect(chooseInDialogue(banker, 'refused', 'end', noAccount)).toEqual({ ok: true, next: null });
  });

  it('choix interdit ou inconnu : refusé', () => {
    expect(chooseInDialogue(banker, 'hello', 'ask_account', withAccount)).toMatchObject({
      ok: false,
    });
    expect(chooseInDialogue(banker, 'hello', 'braquage', noAccount)).toMatchObject({ ok: false });
    expect(chooseInDialogue(banker, 'nulle_part', 'end', noAccount)).toMatchObject({ ok: false });
  });

  it('variables : {fee} = commission de economy.json en %', () => {
    const vars = dialogueVars(gameData.economy);
    expect(vars.fee).toBe(String(Math.round(gameData.economy.bank.fee * 100)));
    const offer = banker.nodes.find((n) => n.id === 'offer')!;
    expect(fillText(offer.text, vars)).toContain(`${vars.fee} %`);
    expect(fillText('{inconnu}', vars)).toBe('{inconnu}');
  });
});
