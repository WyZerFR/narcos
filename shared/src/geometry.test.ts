import { describe, expect, it } from 'vitest';
import { segmentHitsBox, type Box } from './geometry';

const building: Box = { rect: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 }, height: 10 };
const camera = { x: 0, y: 16, z: 12 };

describe('segmentHitsBox', () => {
  it('détecte un bâtiment entre la caméra et le joueur', () => {
    expect(segmentHitsBox(camera, { x: 0, y: 0.5, z: -3 }, building)).toBe(true);
  });

  it('ignore un joueur devant le bâtiment', () => {
    expect(segmentHitsBox(camera, { x: 0, y: 0.5, z: 4 }, building)).toBe(false);
  });

  it('ignore un bâtiment trop bas pour couper la ligne de vue', () => {
    const low: Box = { ...building, height: 0.3 };
    expect(segmentHitsBox(camera, { x: 0, y: 0.5, z: -3 }, low)).toBe(false);
  });

  it('ignore un bâtiment à côté de la ligne de vue', () => {
    expect(segmentHitsBox(camera, { x: 6, y: 0.5, z: -3 }, building)).toBe(false);
  });
});
