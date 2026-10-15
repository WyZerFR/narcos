import { useEffect, useRef } from 'react';
import { footprint, gameData, obstaclesFrom, rectFromCenter, type Rect } from '@narco/shared';
import type { GameRoom, PlayerView } from '../net/connection';
import { connection } from '../net/connection';
import { getCamera } from '../game/cameraState';
import { localPlayer } from '../game/localPlayer';

/**
 * Taille affichée (px CSS) et cadence de rafraîchissement : décor de HUD, pas besoin de 60 Hz.
 * Plus haute que large : la rue centrale et ses deux impasses (nord / sud) y tiennent.
 */
const WIDTH = 104;
const HEIGHT = 168;
const REFRESH_MS = 100;

const { config } = gameData;
const { bounds } = config.world;
const mapW = bounds.maxX - bounds.minX;
const mapD = bounds.maxZ - bounds.minZ;
const LAYOUTS = [...gameData.quartierLayouts.values()];
const ROADS = [
  ...config.map.roads.map((r) => rectFromCenter(r, r)),
  ...LAYOUTS.flatMap((l) => [l.road, ...l.parking, l.plaza]),
];
const AREAS = [...gameData.areas.values()];
const SOLIDS = obstaclesFrom(gameData);
const PLACES = [...gameData.locations.values()];

/**
 * Mini-carte : toute la zone, tournée comme la caméra (le haut de la carte = le haut de l'écran).
 * Canvas 2D, `pointer-events: none` : ne gêne jamais le joystick.
 */
export function Minimap({ room }: { room: GameRoom }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    const { palette } = config;

    const rect = (r: Rect, color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(r.minX, r.minZ, r.maxX - r.minX, r.maxZ - r.minZ);
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      ctx.save();
      ctx.translate(WIDTH / 2, HEIGHT / 2);
      const angle = (getCamera().rotation * Math.PI) / 180;
      ctx.rotate(angle);
      // échelle : la carte tournée tient entière dans le cadre
      const c = Math.abs(Math.cos(angle));
      const s = Math.abs(Math.sin(angle));
      const scale = 0.92 * Math.min(WIDTH / (mapW * c + mapD * s), HEIGHT / (mapW * s + mapD * c));
      ctx.scale(scale, scale);
      ctx.translate(-(bounds.minX + mapW / 2), -(bounds.minZ + mapD / 2));

      rect(bounds, palette.sky);
      // une teinte par area (rue, quartier nord, quartier sud)
      ctx.globalAlpha = 0.28;
      for (const a of AREAS) rect(a.bounds, a.themeColor);
      ctx.globalAlpha = 1;
      for (const r of ROADS) rect(r, palette.street);
      for (const r of SOLIDS) rect(r, palette.wall);
      for (const loc of PLACES) rect(footprint(loc), loc.neonColor);

      room.state.players?.forEach((p: PlayerView) => {
        const me = p.id === connection.playerId;
        const x = me && localPlayer.initialized ? localPlayer.x : p.x;
        const z = me && localPlayer.initialized ? localPlayer.z : p.z;
        ctx.globalAlpha = p.connected ? 1 : 0.4;
        ctx.beginPath();
        ctx.arc(x, z, (me ? 4 : 3) / scale, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        if (me) {
          ctx.lineWidth = 1.5 / scale;
          ctx.strokeStyle = palette.neon;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      });
      ctx.restore();
    };

    draw();
    const id = setInterval(draw, REFRESH_MS);
    return () => clearInterval(id);
  }, [room]);

  return <canvas ref={ref} className="minimap" style={{ width: WIDTH, height: HEIGHT }} />;
}
