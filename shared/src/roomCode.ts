/** Code de room : `length` lettres tirées de `alphabet` (sans I/O, faciles à dicter). */
export function generateRoomCode(
  alphabet: string,
  length: number,
  random: () => number = Math.random,
): string {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += alphabet[Math.floor(random() * alphabet.length)] ?? alphabet[0];
  }
  return code;
}

/** Normalise une saisie utilisateur ; renvoie `null` si ce n'est pas un code valide. */
export function normalizeRoomCode(input: string, alphabet: string, length: number): string | null {
  const code = input.trim().toUpperCase();
  if (code.length !== length) return null;
  for (const ch of code) if (!alphabet.includes(ch)) return null;
  return code;
}
