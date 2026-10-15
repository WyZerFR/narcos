import { describe, expect, it } from 'vitest';
import { gameData } from './data';
import {
  availableChoices,
  chooseInDialogue,
  dialogueStart,
  dialogueVars,
  fillText,
  hasPact,
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
    expect(vars.fee).toBe(String(Math.round(gameData.economy.launder.venues.bank.fee * 100)));
    const offer = banker.nodes.find((n) => n.id === 'offer')!;
    expect(fillText(offer.text, vars)).toContain(`${vars.fee} %`);
    expect(fillText('{inconnu}', vars)).toBe('{inconnu}');
  });
});

describe('dialogues — El Jefe et le pacte', () => {
  const jefe = gameData.dialogues.get('el_jefe')!;
  const noPact: DialogueContext = { hasAccount: false, pact: false };
  const pact: DialogueContext = { hasAccount: false, pact: true };

  it('le pacte est exigé par la config ; hasPact suit la config', () => {
    expect(gameData.config.dialogue.requirePact).toBe(true);
    expect(hasPact(false, true)).toBe(false);
    expect(hasPact(true, true)).toBe(true);
    expect(hasPact(false, false)).toBe(true);
  });

  it('accueil sans pacte : accepter (action accept_pact) ou refuser (relançable)', () => {
    expect(dialogueStart(jefe, noPact)?.id).toBe('welcome');
    expect(chooseInDialogue(jefe, 'welcome', 'accept', noPact)).toEqual({
      ok: true,
      next: 'deal',
      action: 'accept_pact',
    });
    expect(chooseInDialogue(jefe, 'welcome', 'refuse', noPact)).toEqual({
      ok: true,
      next: 'refused',
    });
    const refused = jefe.nodes.find((n) => n.id === 'refused')!;
    expect(refused.text).toBe('La porte reste ouverte. Pas longtemps.');
  });

  it('pacte conclu : dialogue de rappel, « accepter » ne tient plus', () => {
    expect(dialogueStart(jefe, pact)?.id).toBe('reminder');
    expect(chooseInDialogue(jefe, 'welcome', 'accept', pact).ok).toBe(false);
  });

  it('le texte annonce le nombre de graines du JSON', () => {
    const deal = jefe.nodes.find((n) => n.id === 'deal')!;
    expect(fillText(deal.text, dialogueVars(gameData.economy))).toContain(
      `${gameData.economy.pact.startSeeds} graines`,
    );
  });

  it('courtier sans pacte : renvoie vers El Jefe', () => {
    const node = dialogueStart(banker, noPact)!;
    expect(node.text).toBe("Je ne travaille qu'avec les amis d'El Jefe. Allez le voir.");
    expect(dialogueStart(banker, pact)?.id).toBe('hello');
  });
});

describe('dialogues — blanchisseur de la cave', () => {
  const launderer = gameData.dialogues.get('launderer')!;
  const withAccount: DialogueContext = { hasAccount: true, pact: true };
  const noAccount: DialogueContext = { hasAccount: false, pact: true };
  const cellar = gameData.economy.launder.venues.cellar;

  it('« T’es perdu, petit ? » puis offre (avec compte) ou refus (sans compte)', () => {
    const hello = dialogueStart(launderer, noAccount)!;
    expect(hello.text).toBe("T'es perdu, petit ?");
    expect(availableChoices(hello, noAccount).map((c) => c.id)).toEqual(['ask_no_account', 'oops']);
    expect(chooseInDialogue(launderer, 'hello', 'ask_no_account', noAccount)).toEqual({
      ok: true,
      next: 'no_account',
    });
    const refusal = launderer.nodes.find((n) => n.id === 'no_account')!;
    expect(refusal.text).toBe('Pas de compte, pas de lessive. Va voir le banquier.');
    expect(chooseInDialogue(launderer, 'hello', 'ask', noAccount).ok).toBe(false);
    expect(chooseInDialogue(launderer, 'hello', 'oops', withAccount)).toEqual({
      ok: true,
      next: null,
    });
  });

  it('flux complet : offre → « Je veux blanchir » = action open_launder ; « Pas maintenant » = fin', () => {
    expect(chooseInDialogue(launderer, 'hello', 'ask', withAccount)).toEqual({
      ok: true,
      next: 'offer',
    });
    expect(chooseInDialogue(launderer, 'offer', 'launder', withAccount)).toEqual({
      ok: true,
      next: null,
      action: 'open_launder',
    });
    expect(chooseInDialogue(launderer, 'offer', 'later', withAccount)).toEqual({
      ok: true,
      next: null,
    });
  });

  it('variables {fee} {cap} {window} lues dans economy.launder.venues.cellar', () => {
    expect(launderer.venue).toBe('cellar');
    const vars = dialogueVars(gameData.economy, 'cellar');
    expect(vars).toMatchObject({ fee: '15', cap: String(cellar.cap), window: '30' });
    const offer = launderer.nodes.find((n) => n.id === 'offer')!;
    expect(fillText(offer.text, vars)).toContain(`15 pour cent`);
    expect(fillText(offer.text, vars)).toContain(`${cellar.cap} $`);
    // la banque garde sa commission
    expect(dialogueVars(gameData.economy).fee).toBe('50');
  });
});
