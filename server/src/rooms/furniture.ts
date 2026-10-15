import {
  bagFullText,
  add,
  checkPlacement,
  distance,
  fixtureObstacles,
  fixtureUser,
  furnitureFixtures,
  gameData,
  generateLayout,
  lampRate,
  LAMP_IN_USE,
  NO_LAMP,
  unlitPlantedPots,
  rebankPot,
  remove,
  FixtureTypeSchema,
  type Fixture,
  type FixtureType,
  type Furniture,
  type Interior,
  type Rect,
  type Vec2,
} from '@narco/shared';
import { CutJob, InstalledFixture, Pot, RackState, type GameState, type Player } from './schema';
import { readInventory, readPot, writeInventory, writePot } from './stateSync';

/**
 * Meubles du labo côté serveur : poser un objet du sac où l'on veut, le déplacer, le reprendre.
 * La validation est la fonction pure `checkPlacement` (la même que le fantôme du client).
 * L'état de production (pot, étendoir, table) est rangé sous l'id du meuble : il le suit.
 */

const { items, economy, config } = gameData;
const LAMP = economy.lab.lamp;
const DEFAULT_STRAIN = economy.strains[0]!;

export interface FurnitureResult {
  ok: boolean;
  text: string;
  fixtureId?: string;
}

const refuse = (text: string): FurnitureResult => ({ ok: false, text });

export function labFurniture(state: GameState): Furniture[] {
  const out: Furniture[] = [];
  state.lab.fixtures.forEach((f, id) =>
    out.push({ id, itemId: f.itemId, x: f.x, z: f.z, rot: f.rot }),
  );
  return out;
}

/** Meubles posés, résolus (empreinte, type, portée). */
export function labFixtures(state: GameState): Fixture[] {
  return furnitureFixtures(labFurniture(state), items);
}

/** Meubles d'un intérieur (seul un intérieur aménageable en a). */
export function fixturesIn(state: GameState, interior: Interior): Fixture[] {
  return interior.furnishable ? labFixtures(state) : [];
}

/** Obstacles du mobilier posé (collisions dynamiques). */
export function furnitureObstacles(state: GameState, interior: Interior): Rect[] {
  return fixtureObstacles(fixturesIn(state, interior));
}

function playersIn(state: GameState, zone: string): (Vec2 & { id: string; name: string })[] {
  const out: (Vec2 & { id: string; name: string })[] = [];
  state.players.forEach((p) => {
    if (p.zone === zone) out.push({ id: p.id, name: p.name, x: p.x, z: p.z });
  });
  return out;
}

/** Recalcule la vitesse de chaque pot selon la distance réelle aux lampes (sans saut). */
export function refreshPotRates(state: GameState, now: number): void {
  const fixtures = labFixtures(state);
  const lamps = fixtures.filter((f) => f.accepts === 'lamp').map((f) => f.position);
  for (const f of fixtures) {
    const potState = state.lab.pots.get(f.id);
    if (f.accepts !== 'pot' || !potState) continue;
    const rate = lampRate(f.position, lamps, LAMP);
    if (Math.abs((potState.rate || 1) - rate) < 1e-9) continue;
    const pot = readPot(potState);
    const strain = economy.strains.find((s) => s.id === pot.strainId) ?? DEFAULT_STRAIN;
    writePot(potState, rebankPot(pot, now, strain, rate));
  }
}

/**
 * Refus si le nouvel agencement laisse sans lampe un pot planté qui en avait une (dernière lampe
 * reprise ou éloignée, pot planté sorti de la lumière) ; `null` sinon.
 */
function lightLost(state: GameState, before: Fixture[], after: Fixture[], moved: Fixture) {
  const planted = (id: string) => Boolean(state.lab.pots.get(id)?.planted);
  const unlit = new Set(unlitPlantedPots(before, planted, LAMP.range));
  if (unlitPlantedPots(after, planted, LAMP.range).every((id) => unlit.has(id))) return null;
  return moved.accepts === 'lamp' ? LAMP_IN_USE : NO_LAMP;
}

/** Crée le meuble et son état de travail (pot vide, étendoir vide, table libre). */
function activate(state: GameState, f: Omit<Furniture, 'id'>, type: FixtureType): string {
  state.lab.nextFixtureId += 1;
  const id = `f${state.lab.nextFixtureId}`;
  const record = new InstalledFixture();
  Object.assign(record, { itemId: f.itemId, x: f.x, z: f.z, rot: f.rot });
  state.lab.fixtures.set(id, record);
  if (type === 'pot') state.lab.pots.set(id, new Pot());
  if (type === 'drying_rack') state.lab.racks.set(id, new RackState());
  if (type === 'cutting_table') state.lab.cuts.set(id, new CutJob());
  return id;
}

function deactivate(state: GameState, id: string): void {
  state.lab.fixtures.delete(id);
  state.lab.pots.delete(id);
  state.lab.racks.delete(id);
  state.lab.cuts.delete(id);
}

/** Pourquoi un meuble ne peut pas être repris (ou null s'il est au repos). */
export function busyReason(state: GameState, id: string): string | null {
  if (state.lab.pots.get(id)?.planted) return 'Le pot contient une plante : récolte-la avant.';
  if ((state.lab.racks.get(id)?.entries.length ?? 0) > 0) return "L'étendoir est chargé.";
  if (state.lab.cuts.get(id)?.playerId) return 'Une découpe est en cours sur cette table.';
  return null;
}

/** Intérieur aménageable où se trouve le joueur, ou un message de refus. */
function labOf(player: Player): Interior | string {
  const interior = gameData.interiors.get(player.zone);
  return interior?.furnishable ? interior : 'À poser dans ton labo.';
}

export interface PlaceRequest {
  itemId: string;
  x: number;
  z: number;
  rot: number;
}

/** Pose un objet du sac à la position demandée. */
export function placeFurniture(
  state: GameState,
  player: Player,
  req: PlaceRequest,
  now: number,
): FurnitureResult {
  const interior = labOf(player);
  if (typeof interior === 'string') return refuse(interior);
  const bag = readInventory(player.bag);
  if (!bag.some((s) => s?.itemId === req.itemId)) return refuse("Tu n'as pas cet objet.");
  const check = checkPlacement(
    gameData,
    { interior, fixtures: labFixtures(state), players: playersIn(state, player.zone) },
    req,
  );
  if (!check.ok) return refuse(check.message);
  const r = remove(bag, req.itemId, 1, items);
  if (!r.ok) return refuse(r.message);
  writeInventory(player.bag, r.inv);
  const { position, rot, accepts, label } = check.fixture;
  const id = activate(state, { itemId: req.itemId, ...position, rot }, accepts);
  refreshPotRates(state, now);
  return { ok: true, text: `Posé : ${label}.`, fixtureId: id };
}

/** Un autre joueur se sert de ce poste (à portée, ou découpe à son nom) ? */
function usedBy(state: GameState, player: Player, f: Fixture): string | null {
  const cut = state.lab.cuts.get(f.id)?.playerId;
  const occupants = playersIn(state, player.zone);
  if (cut && cut !== player.id && !occupants.some((p) => p.id === cut))
    return state.players.get(cut)?.name ?? 'Un associé';
  return fixtureUser(f, occupants, player.id, config.world.interactTolerance, cut || undefined);
}

/** Déplace un meuble posé ; son état de production le suit. */
export function moveFurniture(
  state: GameState,
  player: Player,
  req: { fixtureId: string; x: number; z: number; rot: number },
  now: number,
): FurnitureResult {
  const interior = labOf(player);
  if (typeof interior === 'string') return refuse(interior);
  const fixtures = labFixtures(state);
  const current = fixtures.find((f) => f.id === req.fixtureId);
  const record = state.lab.fixtures.get(req.fixtureId);
  if (!current || !record) return refuse("Ce meuble n'est plus là.");
  const user = usedBy(state, player, current);
  if (user) return refuse(`${user} utilise ce poste.`);
  const check = checkPlacement(
    gameData,
    { interior, fixtures, players: playersIn(state, player.zone) },
    { itemId: record.itemId, x: req.x, z: req.z, rot: req.rot, ignoreId: req.fixtureId },
  );
  if (!check.ok) return refuse(check.message);
  const moved = fixtures.map((f) =>
    f.id === current.id ? { ...f, position: check.fixture.position } : f,
  );
  const dark = lightLost(state, fixtures, moved, current);
  if (dark) return refuse(dark);
  Object.assign(record, { ...check.fixture.position, rot: check.fixture.rot });
  refreshPotRates(state, now);
  return { ok: true, text: `Déplacé : ${current.label}.`, fixtureId: req.fixtureId };
}

/** Reprend un meuble au repos dans le sac (le joueur doit être à côté). */
export function pickupFurniture(
  state: GameState,
  player: Player,
  fixtureId: string,
  now: number,
): FurnitureResult {
  const interior = labOf(player);
  if (typeof interior === 'string') return refuse(interior);
  const fixtures = labFixtures(state);
  const f = fixtures.find((x) => x.id === fixtureId);
  if (!f) return refuse("Ce meuble n'est plus là.");
  if (distance(player, f.position) > f.interactRadius + config.world.interactTolerance)
    return refuse(`Trop loin : ${f.label}`);
  const busy = busyReason(state, fixtureId);
  if (busy) return refuse(busy);
  const dark = lightLost(
    state,
    fixtures,
    fixtures.filter((x) => x.id !== fixtureId),
    f,
  );
  if (dark) return refuse(dark);
  const r = add(readInventory(player.bag), f.itemId, 1, items);
  if (!r.ok) return refuse(bagFullText(player.bagTier, 'impossible de reprendre ce meuble.'));
  writeInventory(player.bag, r.inv);
  deactivate(state, fixtureId);
  refreshPotRates(state, now);
  return { ok: true, text: `Repris : ${f.label}, rangé dans ton sac.`, fixtureId };
}

/** Objet posable de chaque type (le premier trouvé dans items.json). */
const ITEM_OF_TYPE = Object.fromEntries(
  FixtureTypeSchema.options.map((t) => [
    t,
    [...items.values()].find((it) => it.placeable?.type === t)!.id,
  ]),
) as Record<FixtureType, string>;

/** Debug : complète le labo avec le kit `config.debug.equipKit`, placements valides générés. */
export function equipLab(state: GameState, interior: Interior, now: number): number {
  const fixtures = labFixtures(state);
  const kit = config.debug.equipKit;
  const wanted = FixtureTypeSchema.options.map((t) => ({
    itemId: ITEM_OF_TYPE[t],
    count: Math.max(0, kit[t] - fixtures.filter((f) => f.accepts === t).length),
  }));
  const layout = generateLayout(
    gameData,
    { interior, fixtures, players: playersIn(state, interior.id) },
    wanted,
  );
  for (const f of layout) activate(state, f, items.get(f.itemId)!.placeable!.type);
  refreshPotRates(state, now);
  return layout.length;
}

/**
 * Pose directe, sans objet du sac (tests, outils) : même validation que pour un joueur.
 * Renvoie l'id du meuble, ou le message de refus.
 */
export function spawnFurniture(
  state: GameState,
  interior: Interior,
  f: Omit<Furniture, 'id'>,
  now: number,
): { id: string } | { error: string } {
  const check = checkPlacement(
    gameData,
    { interior, fixtures: labFixtures(state), players: playersIn(state, interior.id) },
    f,
  );
  if (!check.ok) return { error: check.message };
  const id = activate(state, { ...f, rot: check.fixture.rot }, check.fixture.accepts);
  refreshPotRates(state, now);
  return { id };
}

/** Debug : vide le labo (plantes, séchage et découpes en cours compris). */
export function clearLab(state: GameState): void {
  for (const id of [...state.lab.fixtures.keys()]) deactivate(state, id);
}
