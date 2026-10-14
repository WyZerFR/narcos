# Rendu, direction artistique, performance

- **Budget iPad** : < 200 draw calls, < 300k triangles, pas d'ombres temps réel, 30 fps mini. Matériaux plats (`MeshLambertMaterial` / `MeshBasicMaterial`). Qualité basse par défaut. Vérifier avec l'overlay `?debug=1`.
- **DA** (détail `GDD.md` §6) : low-poly, nuit urbaine. Couleurs uniquement via `config.palette` (nuances `shade` / `mix`) et `color` / `neonColor` des lieux ; jamais de couleur en dur. Lumières : hémisphère + lune ; tout point lumineux est émissif. Bloom seulement en qualité haute.
- **Bâtiments** générés et fusionnés par matériau (`client/src/game/city/buildCity.ts`, classe `Batch`). Pas de glTF pour les bâtiments principaux. Décor répété en `InstancedMesh`.
- **Étiquettes** en DOM (`game/labels.tsx`, ancres projetées à chaque frame) ; pas de `Html` de drei (casse au démontage avec React 19).
- **Découpe** (`game/city/cutout.ts`) : trou tramé entre caméra et joueur local, attribut `aCut` par sommet : 1 = murs, toits et ce qui y est plaqué ; 0 = sol et tout le mobilier (`Batch.cuttable = false` / `furniture()`). Le décor instancié a ses propres matériaux, sans découpe. Réglages `config.cutout`, panneau caméra. Joueurs cachés : marqueur DOM (`segmentHitsBox`).
- **Intérieurs** : pièce fusionnée (`interior/buildRoom.ts`) ; mobilier du labo en 2 `InstancedMesh` de cubes (`FixtureProps`, `fixtureParts.ts`) ; plantes et bottes en 2 autres (`LabProps`). Labo tout équipé : 8 draw calls.
- **PNJ** : 2 `InstancedMesh` (corps, tête), positions lissées (`Npcs.tsx`, `npcState.ts`).
