import { useEffect, useRef } from 'react';
import {
  areaAt,
  areaRects,
  discoveredAreaIds,
  discoveryTargets,
  rectsOverlap,
  walkableAreas,
  footprint,
  gameData,
  obstaclesFrom,
  rectFromCenter,
  STREET,
  themedPalette,
  themeOf,
  visibleLocations,
  type Rect,
} from '@narco/shared';
import type { GameRoom, PlayerView } from '../net/connection';
import { connection } from '../net/connection';
import { getCamera } from '../game/cameraState';
import { localPlayer } from '../game/localPlayer';
import { useSettings } from './settings';

/**
 * Taille affichée (px CSS) et cadence de rafraîchissement : décor de HUD, pas besoin de 60 Hz.
 * Plus large que haute : toute l'île (plus étendue d'ouest en est) y tient.
 */
const WIDTH = 160;
const HEIGHT = 120;
const REFRESH_MS = 100;
/** Taille des pictogrammes (px CSS). */
const ICON_PX = 11;

const { config } = gameData;
const { bounds } = config.world;
const mapW = bounds.maxX - bounds.minX;
const mapD = bounds.maxZ - bounds.minZ;
const LAYOUTS = [...gameData.quartierLayouts.values()];
const ROADS = [
  ...config.map.roads.map((r) => rectFromCenter(r, r)),
  ...LAYOUTS.flatMap((l) => [...l.roads, ...l.parking, l.plaza]),
];
const AREAS = [...gameData.areas.values()];
// obstacles sur la terre marchable seulement (la mer et l'aéroport fermé ne sont pas des murs)
const SOLIDS = obstaclesFrom(gameData).filter((r) =>
  walkableAreas(AREAS).some((a) => areaRects(a).some((t) => rectsOverlap(t, r))),
);
const PLACES = visibleLocations(gameData.locations.values()); // jamais la trappe cachée
// pictogrammes des lieux notables, affichés une fois découverts (jamais trappe ni jardins)
const ICONS = discoveryTargets(gameData).filter((t) => t.kind === 'place');

/** Ids découverts par le joueur local (vide tant que le serveur n'a rien envoyé). */
function myDiscoveries(room: GameRoom): Set<string> {
  const out = new Set<string>();
  room.state.players?.get(connection.playerId ?? '')?.discovered?.forEach((id) => out.add(id));
  return out;
}

/**
 * Mini-carte : toute la zone, tournée comme la caméra (le haut de la carte = le haut de l'écran).
 * Brouillard de guerre : les areas non découvertes sont sombres, sans icône ni autre joueur.
 * Canvas 2D, `pointer-events: none` : ne gêne jamais le joystick.
 */
export function Minimap({ room }: { room: GameRoom }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { theme } = useSettings();

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    // teintes du thème (jour : ciel clair, asphalte gris) ; brouillard de guerre propre au thème
    const palette = themedPalette(config, theme);
    const FOG = themeOf(config, theme).fogOfWar ?? palette.sky;

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
      // une teinte par area (pavage exact du polygone)
      ctx.globalAlpha = 0.28;
      for (const a of AREAS) for (const r of areaRects(a)) rect(r, a.themeColor);
      // area verrouillée (aéroport) : voilée
      ctx.globalAlpha = 0.45;
      for (const a of AREAS) if (a.locked) for (const r of areaRects(a)) rect(r, palette.sky);
      ctx.globalAlpha = 1;
      for (const r of ROADS) rect(r, palette.street);
      for (const r of SOLIDS) rect(r, palette.wall);
      for (const loc of PLACES) rect(footprint(loc), loc.neonColor);
      // brouillard : areas non découvertes recouvertes (ciel assombri), sans rien dessus
      const known = myDiscoveries(room);
      const areas = discoveredAreaIds(known);
      ctx.globalAlpha = 0.96;
      for (const a of AREAS) if (!areas.has(a.id)) for (const r of areaRects(a)) rect(r, FOG);
      ctx.globalAlpha = 1;
      // pictogrammes des lieux découverts, toujours droits à l'écran
      ctx.font = `${ICON_PX}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const t of ICONS) {
        if (!known.has(t.id) || !t.icon) continue;
        ctx.save();
        ctx.translate(t.at.x, t.at.z);
        ctx.rotate(-angle);
        ctx.scale(1 / scale, 1 / scale);
        ctx.fillText(t.icon, 0, 0);
        ctx.restore();
      }

      room.state.players?.forEach((p: PlayerView) => {
        // un joueur dans un intérieur (cave comprise) n'est pas sur la carte de la rue
        if (p.zone !== STREET) return;
        const me = p.id === connection.playerId;
        const x = me && localPlayer.initialized ? localPlayer.x : p.x;
        const z = me && localPlayer.initialized ? localPlayer.z : p.z;
        // les autres joueurs : visibles seulement dans une area découverte
        const where = areaAt(AREAS, { x, z });
        if (!me && (!where || !areas.has(where.id))) return;
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
  }, [room, theme]);

  return <canvas ref={ref} className="minimap" style={{ width: WIDTH, height: HEIGHT }} />;
}
