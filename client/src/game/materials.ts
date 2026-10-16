import { MeshLambertMaterial, type Material, type MeshLambertMaterialParameters } from 'three';

/**
 * Seule fabrique de matériaux éclairés du jeu : rendu low-poly à facettes (`flatShading`, normale
 * par face calculée dans le shader), aucun coût en draw call. Les matériaux non éclairés
 * (`MeshBasicMaterial` : néons, halos, anneaux) n'ont pas d'ombrage.
 */
export function litMaterial(params: MeshLambertMaterialParameters = {}): MeshLambertMaterial {
  return new MeshLambertMaterial({ ...params, flatShading: true });
}

/** Copie d'un matériau importé (glTF), passée en facettes s'il est éclairé. */
export function facetedClone(source: Material): Material {
  const m = source.clone();
  if ('flatShading' in m) {
    m.flatShading = true;
    m.needsUpdate = true;
  }
  return m;
}
