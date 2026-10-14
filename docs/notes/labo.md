# Labo, production, inventaire

- **Postes fixes** (eau, caisse, porte) dans `stations` de `zones.json` ; **mobilier** dans `fixtures` (type accepté `pot | drying_rack | cutting_table | lamp`). Un objet du sac avec `installs` (items.json) s'y installe (`ClientMsg.Fixture`, `server/src/rooms/fixtures.ts`).
- État par emplacement : `lab.fixtures`, `lab.pots`, `lab.racks`, `lab.cuts` (clé = id d'emplacement). Un emplacement installé devient un poste (`fixtureStation`) et, sauf les lampes, un obstacle (`fixtureObstacles`, recalculé serveur et client via `zoneArea(..., extra)`).
- Démontage refusé si pot planté, étendoir chargé, découpe en cours ; installation refusée si un joueur est sur l'emplacement.
- **Lampes** : vitesse de pousse par pot (`Pot.rate`, `lampRate`), changée par `rebankPot` (progression mise en banque : aucun saut). Réglages `economy.lab.lamp`, contrôle `maxLamps × réduction < 1`.
- **Production** pure dans `shared/src/production.ts` : pot (arrosage requis), étendoir, découpe ; `completeCuts` dans la boucle serveur.
- **Inventaire** positionnel (`ArraySchema<Slot>` de longueur fixe, slot vide = `itemId ''`), logique dans `shared/src/inventory.ts` (`add`, `remove`, `transfer`, `moveStack`). Glisser : appui long `config.ui.longPressMs`, garde anti-concurrence par `itemId` attendu, tout ce qui touche le stock exige d'être près de la caisse.
- Client : `stationView.ts` / `placeView` (libellés ACTION, statuts), `fixtureState.ts` (collisions, endroits).
- Persistance : `schemaVersion` 2 ; `migrateLab` convertit une partie v1 (labo meublé) en installant pot_1, pot_2, rack_1, table_1 avec leur contenu.
