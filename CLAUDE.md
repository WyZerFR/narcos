# CLAUDE.md — NARCO-WEB

Jeu web 3D coopératif 3 joueurs (iPad Safari PWA + PC), arcade / humour noir. Design complet : `GDD.md`, à lire seulement pour une nouvelle feature de gameplay. Jalon J1, étapes 1 à 4C faites.

## Stack

- Monorepo npm workspaces : `client/` (Vite, React 19, R3F + drei, colyseus.js), `server/` (Node, Colyseus 0.16, schema v3, lancé par tsx), `shared/` (zod, JSON, logique pure, consommé en source TS).
- Vitest (shared + server), ESLint flat config + Prettier.

## Commandes

```bash
npm run dev          # serveur 0.0.0.0:2567 + client Vite 0.0.0.0:5173 (dev:https pour iPad)
npm run check        # typecheck + lint + tests, sortie courte
npm test             # Vitest (reporter dot, silencieux si vert)
npm run balance      # rentabilité calculée depuis les JSON
npm run format
```

## Structure

```
shared/data/     config, economy, items, locations, zones (intérieurs + emplacements), shops, npcs,
                 props (décor 3D importé), placements (où il remplace le décor généré)
                 ← TOUT l'équilibrage et les positions
shared/src/      schemas.ts (zod → types), data.ts (chargement + cohérence), protocol.ts (messages),
                 collision, movement, navgrid, zones, inventory, production, fixtures, shop,
                 survival, sale, balance, clock ; *.test.ts à côté
server/src/      index.ts, persistence.ts, rooms/NarcoRoom.ts, rooms/schema.ts (state Colyseus),
                 rooms/{lab,shop,fixtures,npcs,stateSync}.ts
server/test/     tests d'intégration de room (un port par fichier, helpers.ts)
client/src/      net/ (connexion, gameView), game/ (scène, city/, interior/, PNJ, labels),
                 input/, ui/ (HUD, inventaire, ACTION, panneaux)
docs/notes/      notes détaillées (voir plus bas)
```

## Règles non négociables

1. TypeScript strict (`noUncheckedIndexedAccess`), pas de `any`.
2. **Serveur autoritaire** : économie, inventaires, argent, timers, positions vivent sur le serveur. Le client envoie des intentions (`shared/src/protocol.ts`) ; seule tolérance : position prédite validée par `validateMove`.
3. **Logique pure dans `shared/`**, sans I/O, testée en Vitest, utilisée par le serveur (et le client pour la prédiction).
4. **Tout en JSON** (`shared/data/`) : prix, timers, plafonds, positions, vitesses. Aucune valeur d'équilibrage en dur. **Chaque champ JSON a son schéma zod** dans `schemas.ts` ; les incohérences sont vérifiées dans `data.ts`.
5. **Timers = timestamps en temps de jeu** côté serveur (`readyAt`…, `float64`), jamais de compteurs décrémentés.
6. Prix et montants calculés par le serveur ; le client affiche.
7. Client : toujours `subscribeState(room, cb)` ; jamais `.clear()` sur `room.onStateChange`.
8. Collisions : une seule implémentation (`shared/src/collision.ts`), obstacles par zone via `zoneArea`.
9. Couleurs uniquement via `config.palette` ; budget iPad < 200 draw calls ; `InstancedMesh` pour le répété.
10. UI tactile : cibles ≥ 44 px, paysage, pas de hover obligatoire. Textes et docs en français.
11. **Un commit par bloc**, message en français, `npm run check` vert avant. Plan d'abord pour toute nouvelle étape.

## Notes détaillées (ne pas charger d'office)

- `docs/notes/historique.md` — lire seulement si tu as besoin de l'état des étapes ou des décisions passées.
- `docs/notes/rendu.md` — lire seulement si tu touches au rendu, à la DA, à la découpe ou aux perfs.
- Thème néo-cartel, néons, ombres blob, brouillard de guerre de la mini-carte : `docs/notes/rendu.md` (thèmes, néons, ombres, découverte).
- `docs/notes/labo.md` — lire seulement si tu touches au labo, à la production, à l'inventaire ou à la sauvegarde v2.
- `docs/notes/economie.md` — lire seulement si tu touches à l'argent, aux magasins, à la survie ou à la vente de rue.
- `docs/notes/reseau.md` — lire seulement si tu touches au réseau, aux zones, au mouvement ou à la sauvegarde.
- `docs/notes/debug.md` — lire seulement si tu touches aux outils debug ou aux tests serveur.
- `docs/notes/quartiers.md` — lire seulement si tu touches aux areas, aux impasses générées ou à la vente par area.
- `docs/notes/modeles.md` — lire seulement si tu touches au décor 3D importé (props.json, placements.json, `npm run models:import`).
- Île (centre-ville, commerces, aéroport verrouillé, chargement par area) : section « Île » de `docs/notes/quartiers.md` et GDD §3.2 bis.
- Blanchisseur caché (cave, 15 %) : lieux de blanchiment dans `docs/notes/economie.md`, cachette dans `docs/notes/quartiers.md`.

## Économie de tokens

- Grep/Glob avant Read ; Read avec offset/limit sur tout fichier de plus de 300 lignes.
- Ne jamais relire un fichier déjà lu dans la session, ni après un Edit.
- Edit ciblé. Write complet seulement pour un fichier neuf ou de moins de 100 lignes ; jamais de réécriture complète d'un fichier de plus de 200 lignes.
- Exploration large via le sous-agent Explore (il ne renvoie que la conclusion).
- Aucun pilotage du navigateur, capture, lecture de console, dump ASCII ou base64, sauf demande explicite : la vérification visuelle est faite par l'utilisateur ; toi, tu vérifies par tests Vitest.
- Commandes shell à sortie limitée (`| tail -40`).
- Rapport final de 25 lignes maximum : ce qui a été fait, ce qu'il faut vérifier à la main.
