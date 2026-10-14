/**
 * Horloge de jeu : le temps de jeu avance à `scale` fois le temps réel (x1, x10, x60 en debug).
 * Tous les timestamps de production (`readyAt`, `wateredUntil`…) sont en temps de jeu (ms) ;
 * changer la vitesse ne fait que « rebaser » l'horloge, sans toucher aux timestamps.
 */
export interface GameClock {
  /** Temps de jeu (ms) au moment `realBase`. */
  base: number;
  /** Temps réel (ms) de référence. */
  realBase: number;
  scale: number;
}

export function createClock(realNow: number, gameNow = realNow, scale = 1): GameClock {
  return { base: gameNow, realBase: realNow, scale };
}

export function clockNow(clock: GameClock, realNow: number): number {
  return clock.base + (realNow - clock.realBase) * clock.scale;
}

/** Change la vitesse sans saut : le temps de jeu courant est conservé. */
export function setClockScale(clock: GameClock, scale: number, realNow: number): GameClock {
  return { base: clockNow(clock, realNow), realBase: realNow, scale };
}
