import { ArraySchema, MapSchema, Schema, type } from '@colyseus/schema';

/** Slot d'inventaire synchronisé ; `itemId === ''` = slot vide. */
export class Slot extends Schema {
  @type('string') itemId = '';
  @type('uint16') qty = 0;
}

/** Ligne de panier : prix unitaire fixé par le serveur au moment où l'article est pris. */
export class CartLine extends Schema {
  @type('string') stationId = '';
  @type('string') itemId = '';
  @type('uint16') qty = 0;
  @type('uint32') unitPrice = 0;
}

/** Stock d'une étagère ; -1 = illimité. */
export class ShelfState extends Schema {
  @type('int32') stock = -1;
}

export class Player extends Schema {
  @type('string') id = '';
  @type('string') name = '';
  @type('string') color = '';
  @type('float32') x = 0;
  @type('float32') z = 0;
  @type('float32') rotY = 0;
  @type('boolean') connected = true;
  /** Zone courante : 'street' ou l'id d'un intérieur (zones.json). */
  @type('string') zone = 'street';
  @type([Slot]) bag = new ArraySchema<Slot>();
  /** Argent propre : compte numérique, non confiscable (la laverie viendra plus tard). */
  @type('uint32') cleanMoney = 0;
  /** Panier dans le magasin courant (réservé en rayon), total calculé par le serveur. */
  @type([CartLine]) cart = new ArraySchema<CartLine>();
  @type('uint32') cartTotal = 0;
  /** Jauges de survie (0..max), mises à jour par le serveur pour les joueurs connectés. */
  @type('float32') hunger = 100;
  @type('float32') thirst = 100;
  @type('float32') health = 100;
  /** Temps de jeu de la dernière mise à jour des jauges. */
  @type('float64') survivalAt = 0;
}

/** Pot du labo (timestamps en temps de jeu, ms : float64 obligatoire). */
export class Pot extends Schema {
  @type('boolean') planted = false;
  @type('string') strainId = '';
  @type('float64') growMsDone = 0;
  @type('float64') bankedAt = 0;
  @type('float64') wateredUntil = 0;
}

export class RackEntry extends Schema {
  @type('string') strainId = '';
  @type('uint8') qty = 0;
  @type('float64') readyAt = 0;
}

/** Découpe en cours à la table ; `playerId === ''` = table libre. */
export class CutJob extends Schema {
  @type('string') playerId = '';
  @type('string') strainId = '';
  @type('uint8') qty = 0;
  @type('float64') readyAt = 0;
}

export class LabState extends Schema {
  @type([Slot]) stock = new ArraySchema<Slot>();
  /** Indexé par id de poste (`pot_1`…). Les emplacements non installés n'ont pas d'entrée. */
  @type({ map: Pot }) pots = new MapSchema<Pot>();
  @type([RackEntry]) rack = new ArraySchema<RackEntry>();
  @type(CutJob) cut = new CutJob();
}

/** Horloge de jeu diffusée : le client extrapole `now` avec `scale` entre deux mises à jour. */
export class ClockState extends Schema {
  @type('float64') now = 0;
  @type('float32') scale = 1;
  /** Multiplicateur debug de la survie seule (faim/soif). */
  @type('float32') survivalScale = 1;
}

export class GameState extends Schema {
  @type('string') code = '';
  /** Indexé par `playerId` (persistant côté client), pas par sessionId. */
  @type({ map: Player }) players = new MapSchema<Player>();
  @type(LabState) lab = new LabState();
  @type(ClockState) clock = new ClockState();
  /** Stock des étagères, clé `intérieur:poste`. */
  @type({ map: ShelfState }) shelves = new MapSchema<ShelfState>();
}
