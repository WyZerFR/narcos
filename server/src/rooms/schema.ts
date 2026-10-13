import { MapSchema, Schema, type } from '@colyseus/schema';

export class Player extends Schema {
  @type('string') id = '';
  @type('string') name = '';
  @type('string') color = '';
  @type('float32') x = 0;
  @type('float32') z = 0;
  @type('float32') rotY = 0;
  @type('boolean') connected = true;
}

export class GameState extends Schema {
  @type('string') code = '';
  /** Indexé par `playerId` (persistant côté client), pas par sessionId. */
  @type({ map: Player }) players = new MapSchema<Player>();
}
