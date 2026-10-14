# Labo, production, inventaire

- **Labo livré vide** (bloc 1 de 3) : seuls le robinet et la porte (`stations`), `fixtures: []` ; ni déco, ni caisse. Le stock commun est désactivé (plus de `lab.stock`, de `Transfer`, de `clearStock`) ; la logique pure (`transfer`, `moveStack`, `stockSlots`) reste dans `shared/` pour la future caisse posable.
- **Tests** : les emplacements de l'ancien labo meublé vivent dans `shared/src/testing/labFixtures.json`, injectés par `installTestLabFixtures()` (tests shared et serveur).
- **Postes fixes** dans `stations` de `zones.json` ; **mobilier** dans `fixtures` (type accepté `pot | drying_rack | cutting_table | lamp`). Un objet du sac avec `installs` (items.json) s'y installe (`ClientMsg.Fixture`, `server/src/rooms/fixtures.ts`).
- État par emplacement : `lab.fixtures`, `lab.pots`, `lab.racks`, `lab.cuts` (clé = id d'emplacement). Un emplacement installé devient un poste (`fixtureStation`) et, sauf les lampes, un obstacle (`fixtureObstacles`, recalculé serveur et client via `zoneArea(..., extra)`).
- Démontage refusé si pot planté, étendoir chargé, découpe en cours ; installation refusée si un joueur est sur l'emplacement.
- **Lampes** : vitesse de pousse par pot (`Pot.rate`, `lampRate`), changée par `rebankPot` (progression mise en banque : aucun saut). Réglages `economy.lab.lamp`, contrôle `maxLamps × réduction < 1`.
- **Production** pure dans `shared/src/production.ts` : pot (arrosage requis), étendoir, découpe ; `completeCuts` dans la boucle serveur.
- **Inventaire** positionnel (`ArraySchema<Slot>` de longueur fixe, slot vide = `itemId ''`), logique dans `shared/src/inventory.ts` (`add`, `remove`, `transfer`, `moveStack`). Glisser dans le sac seul : appui long `config.ui.longPressMs`, garde anti-concurrence par `itemId` attendu.
- **Fin de découpe sac plein** : la découpe ne se termine pas, les pochons attendent sur la table, un seul message (`ok: false`) ; livraison automatique dès qu'un slot se libère.
- Client : `stationView.ts` / `placeView` (libellés ACTION, statuts), `fixtureState.ts` (collisions, endroits).
- Persistance : `schemaVersion` 3, sans migration : une partie v1/v2 est ignorée au chargement (log `[narco] partie … ignorée, partie neuve`).
