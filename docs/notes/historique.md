# Historique des étapes

Jalon J1, étapes 1 à 4C terminées (détail de la roadmap dans `GDD.md` §8) :

- **1** Fondations : monorepo, multi minimal, reconnexion, JSON typés, anti-téléportation.
- **2** Map zone 1 : 8 lieux, immeubles, collisions partagées, mini-carte, « Entrer : <lieu> », caméra, découpe des murs.
- **3** Inventaire : sac 10 slots, stock commun 60, piles, transferts tout ou rien.
- **4A** Labo : intérieur séparé, pot → étendoir → table → pochons, timers serveur, sauvegarde JSON.
- **4B** Argent (sale = objet, propre = compte), shop et supérette (étagères, panier serveur, comptoir), survie (faim, soif, santé, KO).
- **4C** Glisser-déposer par appui long ; labo vide à équiper (emplacements, mobilier du Bricoshop, lampes) ; vente de rue aux PNJ.

**Pas encore** : taxe d'El Jefe, police, téléphone, laverie, XP, SQLite.

## Décisions notables

- Glisser = pile entière ; le transfert « 1 » reste dans les boutons.
- « Démonter » est un bouton secondaire, ACTION reste l'action principale du poste.
- Argent de départ 100 $ : couvre pot + étendoir + table + 3 graines (test `kit de départ`).
- Équilibrage actuel (`npm run balance`) : ~23 $/min de jeu par pot, kit remboursé en 1,3 cycle — sans doute trop rapide, à revoir (leviers : `growSeconds`, `pouchSellPrice`, cooldown des PNJ).
- Les PNJ ne sont pas sauvegardés ; la taxe d'El Jefe n'est pas appliquée aux ventes.
