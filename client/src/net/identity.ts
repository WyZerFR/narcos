/**
 * Identité persistante du joueur (localStorage : survit au rechargement de page et à la
 * fermeture de la PWA iOS). Le paramètre d'URL `?joueur=2` sélectionne un profil distinct,
 * pour simuler plusieurs joueurs dans le même navigateur sur PC.
 */

const profile = (() => {
  const p = new URLSearchParams(location.search).get('joueur');
  return p && /^[A-Za-z0-9_-]{1,16}$/.test(p) ? p : 'default';
})();

const key = (name: string) => `narco.${profile}.${name}`;

function safeGet(name: string): string | null {
  try {
    return localStorage.getItem(key(name));
  } catch {
    return null;
  }
}

function safeSet(name: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key(name));
    else localStorage.setItem(key(name), value);
  } catch {
    // stockage indisponible (navigation privée) : on continue sans persistance
  }
}

/** `crypto.randomUUID` n'existe pas hors contexte sécurisé (http://IP-LAN sur iPad). */
function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

let cachedPlayerId: string | null = null;

export function getPlayerId(): string {
  if (cachedPlayerId) return cachedPlayerId;
  let id = safeGet('playerId');
  if (!id) {
    id = randomId();
    safeSet('playerId', id);
  }
  cachedPlayerId = id;
  return id;
}

export const getSavedName = (): string => safeGet('name') ?? '';
export const saveName = (name: string): void => safeSet('name', name);

/** Dernière room rejointe : permet de revenir automatiquement après un rechargement. */
export const getSavedRoomCode = (): string | null => safeGet('roomCode');
export const saveRoomCode = (code: string | null): void => safeSet('roomCode', code);

/** Code d'accès du serveur (si demandé), gardé pour les reconnexions. */
export const getAccessCode = (): string => safeGet('accessCode') ?? '';
export const saveAccessCode = (code: string): void => safeSet('accessCode', code || null);
