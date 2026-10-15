# NARCO-WEB — Game Design Document

> Version 0.1 — 2026-10-13. Document de référence du design. Les **valeurs chiffrées** (prix, timers, plafonds) ne vivent pas ici mais dans `shared/data/*.json` ; ce document décrit les règles et les intentions.

## 1. Concept

Jeu web 3D **coopératif à 3 joueurs**, jouable sur **iPad (Safari, PWA paysage)** et PC. Trois amis expulsés de leur appart montent un cartel et prennent le contrôle d'un quartier.

- **Aucun rôle attribué** : les trois joueurs peuvent tout faire (cultiver, vendre, blanchir, conduire…).
- **Ton** : arcade, humour noir, absurde assumé. Aucun réalisme (ni procédural, ni visuel).
- **Cadre** : jeu privé entre amis, aucune monétisation, aucun matchmaking.
- **Visuel actuel** : blockout (cubes, sol, couleurs plates), caméra 3/4 vue de dessus.

## 2. Progression en 4 actes

| Acte                  | Contenu                                                                                                                                                                                                                                                               | Zone | Budget temps (à 3) |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------ |
| **I — La rue**        | Départ expulsés dans la rue. Jauges faim/soif, épicerie, local abandonné. Pacte avec **El Jefe** : il fournit les graines de base contre une **taxe sur les ventes**. Tuto fabrication : plantation → arrosage → pousse → séchage → mise en pochons → première vente. | 1    | 1 h                |
| **II — Roue libre**   | XP et compétences (temps de pousse, vitesse de déplacement, taille du sac). **Téléphone** : messages de clients PNJ, rendez-vous, GPS. **Premier dealer** (100 $/semaine). Nouvelles variétés.                                                                        | 1    | 5 h                |
| **III — Blanchiment** | **Laverie** (argent sale → propre). Rénovation du local en **labo**. **Banque**. Façade **« iReconditionné »** (le stockage du téléphone = le grammage : 64 Go = 64 g, 128 Go = 128 g, 256 Go = 256 g, 512 Go = 512 g, 1 To = 1000 g). **Concessionnaire**.           | 2    | 7 h                |
| **IV — L'empire**     | Commerces de façade, **usine** (production de masse), **armurier**, réseau de dealers. **El Jefe devient hostile** (PvE, IA scriptée). **Aéroport** (fin de partie).                                                                                                  | 3    | 11 h               |

**Durée cible** : 24 h de jeu actif à 3, soit ~8 sessions de 3 h.

## 3. Règles de design

### 3.1 Coopération par ressources partagées

La coop naît de la **rareté partagée**, pas de rôles :

- **Caisse commune** (argent propre sur compte commun).
- **Stock commun** dans le local (60 slots).
- **Sac limité par joueur** (10 slots) → il faut se répartir les tâches et les trajets.
- **Heat commune** : la bêtise d'un joueur pèse sur les trois.
- **Un seul dealer au début** → il faut décider ensemble où l'affecter.

### 3.2 Map

3 zones débloquables, chacune **traversable à pied en moins de 60 s**.

| Zone       | Débloquée                     | Lieux                                                           |
| ---------- | ----------------------------- | --------------------------------------------------------------- |
| **Zone 1** | Acte I                        | Local, épicerie, repaire d'El Jefe, ruelles, point relais, shop |
| **Zone 2** | Acte III                      | Laverie, banque, concessionnaire, premiers magasins             |
| **Zone 3** | Acte IV (via concessionnaire) | Usine, armurier, commerces lourds, aéroport                     |

### 3.2 bis Île

La carte est une île (`areas.json`), d'ouest en est. Chaque area a son nom, son bandeau d'entrée, sa teinte de mini-carte, son prix, sa demande et son danger. Les valeurs ci-dessous sont lues dans le JSON, rien n'est en dur :

| Area                                   | Contenu                                                                 | Prix PNJ | Danger (0-5) | Tenue par |
| -------------------------------------- | ----------------------------------------------------------------------- | -------- | ------------ | --------- |
| **Bas-fonds** (`bas_fonds`)            | départ, carton, épicerie de Momo ; référence des prix                   | ×1,00    | 3            | personne  |
| **Chez nous** (`chez_nous`)            | notre U de maisons, le Local, la cave du blanchisseur                   | ×1,30    | 1            | nous      |
| **Centre-ville** (`centre_ville`)      | tours seedées, carrefour, banque, commissariat, concessionnaire         | ×1,00    | 5            | personne  |
| **Quartier commercial** (`commercial`) | Bricoshop, AMMU-NATION, laverie, barbier, kebab, commerces, parking     | ×1,15    | 3            | personne  |
| **Quartier d'El Jefe** (`cartel`)      | le U d'El Jefe, son repaire                                             | ×1,30    | 1            | El Jefe   |
| **Aéroport** (`aeroport`)              | piste, hangars, avions, conteneurs, clôture et portail ; **verrouillé** | —        | 5            | —         |

- **Interactions** : seuls les lieux à intérieur ou à dialogue ont un bouton ACTION (banque, Bricoshop, épicerie, Local, repaire, cave). Commissariat, concession, armurerie, laverie, barbier, kebab, tours et commerces sont des façades de repère avec une enseigne.
- **Aéroport** : on le voit depuis la ville et on bute sur son portail. Le champ `locked` est lu par la collision et le rendu : son déblocage (acte IV) n'est qu'un changement de données.
- **PNJ** : simulés seulement dans les areas où se trouve un joueur (au plus 14 au total, serveur à 0,1 CPU).
- **HUD** : bandeau à l'entrée d'une area, mini-carte de toute l'île teintée par area, pastille de danger et de bonus de prix.
- **Trajets** : depuis le départ, la banque et le Bricoshop sont à moins de 45 s à pied, et l'île se traverse en moins de 150 s (`npm run balance` donne le détail par lieu et par area).
- **Rôle futur** : la police sera pondérée par `dangerLevel`, le conflit avec El Jefe passera par `controlledBy`, et l'aéroport s'ouvrira à l'acte IV.

### 3.2 ter Blanchisseur du Sud

- **Cachette** : un passage étroit entre deux maisons de l'impasse Sud mène à un jardin arrière clos ; une trappe y descend à la cave du blanchisseur. Aucune étiquette ni marqueur : seule une lueur filtre de la trappe, et « Descendre » n'apparaît qu'à 1,5 m.
- **Tarif** : 15 % de commission (contre 50 % à la banque), plafond de 1500 $ par demi-heure, séparé de celui de la banque. Le net est versé sur le compte bancaire : **compte exigé** (« Pas de compte, pas de lessive »).
- **Rôle** : la banque reste nécessaire au-delà du plafond de la cave ; la cave, plus rentable, est un secret de quartier (futur : Heat, descentes de police, El Jefe qui veut sa part).

### 3.3 Lieux et fonction de gameplay

| Lieu                           | Zone | Fonction                                                                                                                        |
| ------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| Local                          | 1    | Base : stock commun, plantations, séchage, mise en pochons. Heat propre (monte avec stock et ventes). Devient labo en Acte III. |
| Épicerie                       | 1    | Eau et nourriture (faim/soif).                                                                                                  |
| Repaire d'El Jefe              | 1    | Graines de base, pacte, taxe sur ventes. Devient hostile en Acte IV.                                                            |
| Ruelles                        | 1    | Points de vente de rue, raccourcis hors des patrouilles.                                                                        |
| Point relais                   | 1    | Dépôt/retrait de colis, rendez-vous clients.                                                                                    |
| Shop                           | 1    | Sacs (plus de slots), pots, outils, guetteur.                                                                                   |
| Laverie                        | 2    | Premier blanchiment : argent sale → propre, plafond par jour.                                                                   |
| Banque                         | 2    | Dépôt d'argent propre, prêts, plafond de dépôt journalier, compte gelé si Heat haute.                                           |
| Concessionnaire                | 2    | Voitures (vitesse, coffre, discrétion). Débloque la zone 3.                                                                     |
| Magasins (dont iReconditionné) | 2-3  | Façades de blanchiment, chacune avec son plafond.                                                                               |
| Usine                          | 3    | Production de masse.                                                                                                            |
| Armurier                       | 3    | Armes : font monter la Heat, confiscables en fouille.                                                                           |
| Aéroport                       | 3    | Export / fin de partie.                                                                                                         |

### 3.4 Police (PNJ, logique serveur uniquement)

- 2-3 patrouilles sur **waypoints** avec **cône de vision**.
- Repèrent : une **vente**, un **joueur qui court**, une présence en **zone sensible**.
- **Contrôle = fouille du sac** :
  - marchandise trouvée → perte du sac + amende **ou** arrestation (quelques minutes hors jeu) ;
  - sac propre → relâché.
- **Heat du local** : monte avec le stock et les ventes, déclenche des **perquisitions**.
- **Pot-de-vin** et **guetteur** réduisent le risque.

### 3.5 Événements aléatoires

Vol de stock, rival qui casse les prix, descente de police.

### 3.6 Monde persistant

Le monde continue quand un joueur est offline (cultures, dealers). À la reconnexion, le serveur calcule le temps écoulé (implémentation avec SQLite plus tard).

## 4. Inventaire

- **Sac par joueur** : 10 slots. **Stock commun du local** : 60 slots.
- **Stack par type d'item**, avec une limite de stack propre à chaque item (`items.json`).
- **Items** :

| Item           | Notes                                                          |
| -------------- | -------------------------------------------------------------- |
| Graines        | Par variété.                                                   |
| Plante fraîche | Récoltée, à sécher.                                            |
| Plante séchée  | À mettre en pochons.                                           |
| Pochon         | Unité de vente.                                                |
| Eau            | Arrosage + soif.                                               |
| Nourriture     | Faim.                                                          |
| Argent sale    | **Item physique**, occupe un slot, **confiscable** en fouille. |
| Argent propre  | **Compte** (pas un item), non confiscable.                     |

- **Actions** : ramasser, poser, transférer sac ↔ stock, utiliser, vendre.
- **UI** : aucune action ne dépend du drag-and-drop (tap pour sélectionner, bouton pour agir).

## 5. Contraintes techniques de design

- **Serveur autoritaire** : économie, inventaires, argent, police, timers. Le client envoie des intentions.
- **Données** : tout l'équilibrage et tous les lieux dans `shared/data/*.json` (`economy.json`, `items.json`, `locations.json`, `config.json`). Changer un prix dans le JSON doit suffire.
- **iPad** : < 200 draw calls, < 300k triangles, pas d'ombres temps réel, instancing des décors, 30 fps mini, qualité bas/moyen/haut (bas par défaut).
- **Contrôles** : joystick virtuel à gauche, bouton d'action contextuel à droite ; clavier ZQSD/WASD + souris en bonus. Cibles tactiles ≥ 44 px.
- **Réseau** : room privée de 3 joueurs max, code 4 lettres. Reconnexion automatique après arrière-plan.

## 6. Direction artistique

**Low-poly stylisé, arcade, nuit urbaine.** Une capture du quartier doit donner envie de jouer.

- **Palette** : 6 couleurs de base dans `config.json` (`palette` : ciel, sol, rue, murs, néon, végétation). Toutes les nuances en sont dérivées (éclaircir, assombrir, mélanger). Chaque lieu a en plus sa `color` et sa `neonColor` dans `locations.json`.
- **Nuit** : fond et brouillard bleu-violet, lumière ambiante douce (hémisphère + lune : 2 lumières dynamiques au maximum), aucune ombre temps réel. Les points lumineux (fenêtres, portes, enseignes, lampadaires, guirlandes) sont des **matériaux émissifs**, pas des lumières.
- **Bâtiments** : blocs de hauteurs variées, toits avec parapets et équipements, fenêtres et portes en petits panneaux émissifs (une partie allumée au hasard, de façon déterministe), une enseigne néon par lieu.
- **Silhouettes reconnaissables sans étiquette** :

| Lieu              | Silhouette                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Local             | Entrepôt bas et large, bardage, rideau métallique, lucarnes roses (on devine le labo), tags |
| Épicerie          | Deux étages, vitrine éclairée, store rayé, étals de fruits                                  |
| Repaire d'El Jefe | Le plus haut : podium, tour, couronne et liserés dorés, colonnes                            |
| Bricoshop         | Toit en dents de scie, grand panneau sur le toit, porte de garage ouverte                   |
| Point relais      | Kiosque bas, auvent, mur de consignes lumineuses                                            |
| Ruelles           | Sol sombre, guirlandes lumineuses en travers, flaque qui reflète le néon                    |

- **Sol** : routes, trottoirs surélevés, passages piétons, marquage central, en couleurs plates.
- **Décor instancié** : lampadaires (avec halo au sol), arbres low-poly, voitures garées (solides), poubelles, caisses, carton de départ. Tout est procédural pour l'instant ; des modèles glTF gratuits (Kenney, Quaternius) pourront remplacer le petit décor, chargés en lazy, **jamais** pour les bâtiments principaux.
- **Post-traitement** : bloom discret seulement en qualité moyen/haut ; désactivé en qualité basse (défaut).
- **Budget** : < 200 draw calls ; ~13 en pratique en qualité basse (bâtiments fusionnés en 2 géométries, décor instancié, étiquettes en DOM). Si le budget saute, on réduit le décor, jamais la lisibilité des lieux.

## 7. Jalons

| Jalon  | Contenu                                    | Temps de jeu |
| ------ | ------------------------------------------ | ------------ |
| **J1** | Actes I et II, zone 1 complète             | 6 h          |
| **J2** | Acte III, zone 2                           | 7 h          |
| **J3** | Acte IV, zone 3, El Jefe hostile, aéroport | 11 h         |

## 8. Roadmap

### J1 — Actes I-II

1. ✅ **Fondations** : monorepo, multi minimal (cubes synchronisés), reconnexion, JSON chargés et typés, test anti-téléportation.
2. ✅ **Map zone 1** : quartier de nuit (8 lieux, immeubles, routes, décor), collisions partagées client/serveur, bouton « Entrer : <lieu> », mini-carte, mode debug persistant, réglage caméra.
3. ✅ **Inventaire** : sac (10 slots), stock commun (60), piles, transferts tout ou rien ; réorganisation par appui long puis glisser (déplacer, fusionner, échanger), validée par le serveur.
4. ✅ **Survie et magasins** : faim, soif, santé, KO (réapparition au carton, perte d’argent sale) ; Bricoshop et supérette en intérieurs, étagères, panier et paiement au comptoir ; argent sale (objet) et propre (compte).
5. ✅ **Labo et production** : intérieur 3D séparé, pots (arrosage nécessaire), étendoir, table de découpe, timers en temps de jeu côté serveur, barres de progression partagées ; sauvegarde JSON des parties. Le labo est livré **vide** : point d'eau, caisse et porte seulement ; 11 emplacements (4 pots, 2 étendoirs, 1 table, 4 lampes) à équiper avec du mobilier acheté au Bricoshop (« Installer : <objet> », « Démonter » si au repos). Les **lampes** raccourcissent la pousse des pots à portée (cumul plafonné). L'argent sale de départ (100 $) paie le kit minimal + 3 graines.
6. ◐ **Vente aux PNJ** : 8 passants simulés par le serveur sur les trottoirs ; certains veulent 1 à 3 pochons (budget, patience, prix du pochon ± 20 %) ; « Vendre à <PNJ> », panneau d'offre (quantité, prix, total, Accepter / Refuser), payé en argent sale ; un PNJ ne traite qu'avec un joueur à la fois, puis s'éloigne avant de revenir avec une nouvelle envie. Reste : taxe d'El Jefe.
7. Police : patrouilles, cône de vision, fouille, Heat, perquisition.
8. Acte I scripté (tuto, pacte El Jefe).
9. XP / compétences, téléphone (messages, rendez-vous, GPS), premier dealer, nouvelles variétés.
10. Persistance SQLite + calcul du temps écoulé hors-ligne.

### J2 — Acte III

Zone 2, laverie, banque (plafonds, prêts, gel), labo, iReconditionné, concessionnaire + voitures, événements aléatoires.

### J3 — Acte IV

Zone 3, usine, armurier, magasins de façade, réseau de dealers, El Jefe hostile (IA PvE), aéroport, fin de partie.
