# CLAUDE.md — NARCO-WEB

Jeu web 3D coopératif 3 joueurs (iPad Safari PWA + PC), ton arcade / humour noir. Le design complet est dans **`GDD.md`** (concept, 4 actes, règles, inventaire, lieux, jalons, roadmap) — le lire avant toute feature de gameplay.

## État actuel

Jalon J1, étape 1 terminée : multi minimal (cubes colorés synchronisés sur un sol plat), lobby par code 4 lettres, reconnexion automatique, données `shared/data/*.json` chargées et typées (pas encore utilisées par le gameplay). **Pas encore** : map, inventaire, production, police, persistance (SQLite prévu plus tard).

## Stack

- Monorepo **npm workspaces** : `client/`, `server/`, `shared/`.
- `client/` : Vite + React + TypeScript + React Three Fiber + drei, `colyseus.js`.
- `server/` : Node + TypeScript + Colyseus 0.16 (`@colyseus/core`, `@colyseus/ws-transport`, `@colyseus/schema` v3), lancé par `tsx`.
- `shared/` : types, schémas zod, données JSON, logique pure. Consommé **en source TS** (pas de build) par client et serveur.
- Tests : Vitest (`shared/` et `server/`, `@colyseus/testing` pour les rooms).
- ESLint (flat config, typescript-eslint) + Prettier.

## Commandes

```bash
npm install
npm run dev          # serveur (0.0.0.0:2567) + client Vite (0.0.0.0:5173), HTTP
npm run dev:https    # idem avec cert auto-signé (nécessaire pour le service worker sur iPad)
npm test             # Vitest shared + server
npm run lint
npm run typecheck
npm run format
```

Le client parle au serveur via le proxy Vite (`/colyseus` → `localhost:2567`) : une seule origine, LAN et HTTPS sans config.

## Structure

```
shared/data/        economy.json, items.json, locations.json, config.json  ← TOUT l'équilibrage
shared/src/         schemas.ts (zod → types), data.ts (chargement validé), movement.ts,
                    roomCode.ts, protocol.ts (messages client↔serveur), *.test.ts
server/src/         index.ts (bootstrap), rooms/NarcoRoom.ts, rooms/schema.ts (state Colyseus)
server/test/        tests d'intégration de room
client/src/net/     connexion, lobby, reconnexion
client/src/game/    scène R3F (sol, joueurs, caméra)
client/src/input/   joystick, bouton action, clavier
client/src/ui/      lobby, HUD, options, overlay debug, overlay portrait
client/public/      manifest PWA, service worker, icônes
```

## Conventions (obligatoires)

1. **TypeScript strict** partout (`strict`, `noUncheckedIndexedAccess`). Pas de `any`.
2. **Serveur autoritaire** : économie, inventaires, argent, police, timers, positions vivent sur le serveur. Le client envoie des **intentions** (messages définis dans `shared/src/protocol.ts`), le serveur valide et diffuse via le state Colyseus. Seule tolérance : le mouvement, où le client propose une position prédite que le serveur valide (`validateMove`) et corrige.
3. **Logique pure dans `shared/`** : toute règle de jeu (mouvement, inventaire, économie…) est une fonction pure, sans I/O, testée en Vitest, appelée par le serveur (et par le client pour la prédiction).
4. **Tout l'équilibrage en JSON** (`shared/data/`) : prix, coûts, timers, plafonds, positions de lieux, vitesses, tailles de sac… **Aucune valeur d'équilibrage ou de lieu en dur dans le code.** Chaque JSON a un schéma zod dans `shared/src/schemas.ts` ; ajouter un champ = mettre à jour le schéma. Changer un prix dans le JSON doit suffire (le serveur `tsx watch` redémarre seul).
5. **Tests Vitest** obligatoires pour la logique pure, en particulier **l'inventaire** (stacks, slots, transferts, cas limites) dès qu'il existe.
6. **Un commit par étape terminée** (message clair en français, tests/lint/typecheck verts avant).
7. **Budget iPad** : < 200 draw calls, < 300k triangles, pas d'ombres temps réel, `InstancedMesh` pour les décors répétés, 30 fps mini. Matériaux plats (`MeshLambertMaterial`/`MeshBasicMaterial`). Qualité bas par défaut. Vérifier avec l'overlay debug (`?debug=1`).
8. **UI tactile** : cibles ≥ 44 px, aucune action par drag-and-drop, paysage uniquement, pas de hover obligatoire.
9. **Visuel** : blockout uniquement (cubes, couleurs plates), aucun modèle externe pour l'instant.
10. Texte de jeu et docs en **français**.

## Réseau

- Room `narco`, `roomId` = code 4 lettres (sans I/O), privée, 3 joueurs distincts max (`onAuth`).
- Identité : `playerId` (UUID en `localStorage`) passé au join ; le state indexe les joueurs par `playerId`. Déconnexion → `connected=false`, l'état est gardé ; rejoindre avec le même `playerId` réattache le joueur.
- Le client se reconnecte seul (backoff + `visibilitychange`/`pageshow`/`online`). La room survit vide pendant `config.room.emptyRoomTtlSeconds`.
