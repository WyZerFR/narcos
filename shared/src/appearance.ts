import type { GameData } from './data';

/**
 * Apparence d'un joueur : id de teinte (`palettes.json`) par slot de son personnage. Un slot
 * absent garde la couleur d'origine du modèle. Purement visuel : sac, comptes et meubles intacts.
 */
export type Appearance = Record<string, string>;

type Data = Pick<GameData, 'characters' | 'appearanceSlots'>;

/** Slots personnalisables d'un personnage, dans l'ordre de `palettes.json`. */
export function slotsOf(data: Data, characterId: string) {
  const own = data.characters.get(characterId)?.slots ?? {};
  return [...data.appearanceSlots.values()].filter((s) => own[s.id]);
}

/**
 * Apparence valide pour ce personnage : seuls ses slots, seules les teintes connues de leur
 * palette ; tout le reste est retiré (= couleur d'origine).
 */
export function resolveAppearance(data: Data, characterId: string, raw: unknown): Appearance {
  const out: Appearance = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const entries = raw as Record<string, unknown>;
  for (const slot of slotsOf(data, characterId)) {
    const v = entries[slot.id];
    if (typeof v === 'string' && slot.swatches.some((s) => s.id === v)) out[slot.id] = v;
  }
  return out;
}

/** Une teinte tirée au hasard pour chaque slot du personnage. */
export function randomAppearance(
  data: Data,
  characterId: string,
  rand: () => number = Math.random,
): Appearance {
  const out: Appearance = {};
  for (const slot of slotsOf(data, characterId)) {
    const pick = slot.swatches[Math.floor(rand() * slot.swatches.length)];
    if (pick) out[slot.id] = pick.id;
  }
  return out;
}

/** Couleur (#rrggbb) par rang de slot (0 = origine, toujours null) pour le shader. */
export function slotColors(data: Data, appearance: Appearance): (string | null)[] {
  const out: (string | null)[] = [null];
  for (const slot of data.appearanceSlots.values())
    out[slot.index] = slot.swatches.find((s) => s.id === appearance[slot.id])?.color ?? null;
  return out;
}

/** Signature stable (comparaison, clés React). */
export function appearanceKey(appearance: Appearance): string {
  return Object.keys(appearance)
    .sort()
    .map((k) => `${k}=${appearance[k]}`)
    .join(',');
}
