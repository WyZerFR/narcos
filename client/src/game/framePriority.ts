/**
 * Ordre des `useFrame` dans une frame (croissant ; négatif = sans prendre la main sur le rendu).
 * Les personnages bougent d'abord, la caméra les suit ensuite, puis les étiquettes DOM (0) sont
 * projetées avec la caméra de cette frame : sinon caméra et étiquettes ont une frame de retard
 * et tremblent quand le pas de temps varie.
 */
export const FRAME_PRIORITY = {
  actors: -2,
  camera: -1,
} as const;
