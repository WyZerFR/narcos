import { useEffect, useState } from 'react';
import type { GameRoom, NpcView } from '../net/connection';
import { subscribeState } from '../net/gameView';

/** État client des PNJ de la rue (partagé par le rendu, l'interaction et les étiquettes). */

/** Positions lissées des PNJ (lues par l'interaction et les étiquettes). */
export const npcSmoothed = new Map<string, { x: number; z: number; rotY: number }>();

export interface NpcInfo {
  id: string;
  name: string;
  interested: boolean;
  busyWith: string;
}

/** Liste des PNJ pour React : ne change que si un nom, l'intérêt ou le verrou change. */
export function useNpcList(room: GameRoom): NpcInfo[] {
  const [list, setList] = useState<NpcInfo[]>([]);
  useEffect(() => {
    let signature = '';
    const refresh = () => {
      const next: NpcInfo[] = [];
      room.state.npcs?.forEach((n: NpcView) =>
        next.push({ id: n.id, name: n.name, interested: n.interested, busyWith: n.busyWith }),
      );
      const sig = next.map((n) => `${n.id}|${n.name}|${n.interested}|${n.busyWith}`).join(';');
      if (sig !== signature) {
        signature = sig;
        setList(next);
      }
    };
    refresh();
    return subscribeState(room, refresh);
  }, [room]);
  return list;
}
