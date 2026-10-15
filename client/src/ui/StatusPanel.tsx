import { count, gameData } from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';
import { readBag, useRoomVersion } from '../net/gameView';

const rules = gameData.economy.survival;

function Gauge({
  icon,
  label,
  value,
  low,
}: {
  icon: string;
  label: string;
  value: number;
  low: boolean;
}) {
  const pct = Math.max(0, Math.min(100, (value / rules.max) * 100));
  return (
    <div className={`gauge${low ? ' low' : ''}`} aria-label={`${label} ${Math.round(value)}`}>
      <span className="gauge-icon">{icon}</span>
      <span className="gauge-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="gauge-value">{Math.round(value)}</span>
    </div>
  );
}

/** Argent (en banque si compte ouvert, sale en espèces dans le sac) et jauges de survie, lus dans l'état serveur. */
export function StatusPanel({ room }: { room: GameRoom }) {
  useRoomVersion(room);
  const me = room.state.players?.get(connection.playerId);
  if (!me) return null;
  const dirty = count(readBag(room, connection.playerId), 'cash_dirty');
  const vitals = { hunger: me.hunger, thirst: me.thirst, health: me.health };
  return (
    <div className="status-panel">
      <div className="money">
        <span className="money-clean" title="Argent en banque (propre)">
          💳 {me.hasAccount ? `${me.cleanBalance} $` : '—'}
        </span>
        <span className="money-dirty" title="Argent sale (espèces du sac)">
          💵 {dirty} $
        </span>
      </div>
      <Gauge
        icon="🍔"
        label="Faim"
        value={vitals.hunger}
        low={vitals.hunger < rules.lowThreshold}
      />
      <Gauge
        icon="💧"
        label="Soif"
        value={vitals.thirst}
        low={vitals.thirst < rules.lowThreshold}
      />
      <Gauge
        icon="❤️"
        label="Santé"
        value={vitals.health}
        low={vitals.health < rules.lowThreshold || vitals.hunger <= 0 || vitals.thirst <= 0}
      />
    </div>
  );
}
