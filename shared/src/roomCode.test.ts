import { describe, expect, it } from 'vitest';
import { generateRoomCode, normalizeRoomCode } from './roomCode';

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

describe('codes de room', () => {
  it('génère un code de la bonne longueur dans l’alphabet', () => {
    for (let i = 0; i < 200; i++) expect(generateRoomCode(ALPHA, 4)).toMatch(/^[A-HJ-NP-Z]{4}$/);
  });

  it('normalise la saisie et rejette les codes invalides', () => {
    expect(normalizeRoomCode(' abcd ', ALPHA, 4)).toBe('ABCD');
    expect(normalizeRoomCode('ABC', ALPHA, 4)).toBeNull();
    expect(normalizeRoomCode('ABIO', ALPHA, 4)).toBeNull();
  });
});
