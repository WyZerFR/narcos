import { count, dangerAt, gameData, STREET } from '@narco/shared';
import { connection, type GameRoom } from '../net/connection';
import { readBag, useRoomVersion } from '../net/gameView';

const rules = gameData.economy.survival;
const AREAS = [...gameData.areas.values()];
/** Échelle de danger des areas (0 à 5, voir areas.json). */
const DANGER_MAX = 5;

/** Couleur #rrggbb entre `a` (t = 0) et `b` (t = 1). */
function lerpHex(a: string, b: string, t: number): string {
  const c = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const ch = (i: number) =>
    Math.round(c(a, i) + (c(b, i) - c(a, i)) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${ch(0)}${ch(1)}${ch(2)}`;
}

/** Danger de l'area où l'on est (barres, vert → rouge). Aucun effet de jeu pour l'instant. */
function DangerMeter({ level }: { level: number }) {
  const { ok, danger } = gameData.config.palette;
  const color = lerpHex(ok, danger, level / DANGER_MAX);
  return (
    <div className="danger-meter" aria-label={`Danger ${level} sur ${DANGER_MAX}`}>
      <span className="gauge-icon">⚠️</span>
      {Array.from({ length: DANGER_MAX }, (_, i) => (
        <i key={i} style={{ background: i < level ? color : undefined }} />
      ))}
    </div>
  );
}

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

/** Argent (propre, dépensable sans compte ; sale en espèces dans le sac) et jauges de survie, lus dans l'état serveur. */
export function StatusPanel({ room }: { room: GameRoom }) {
  useRoomVersion(room);
  const me = room.state.players?.get(connection.playerId);
  if (!me) return null;
  const dirty = count(readBag(room, connection.playerId), 'cash_dirty');
  const vitals = { hunger: me.hunger, thirst: me.thirst, health: me.health };
  const danger = me.zone === STREET ? dangerAt(AREAS, me) : null;
  return (
    <div className="status-panel">
      <div className="money">
        <span className="money-clean" title="Argent propre (dépensable sans compte)">
          💳 {me.cleanBalance} $
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
      {danger !== null && <DangerMeter level={danger} />}
    </div>
  );
}
