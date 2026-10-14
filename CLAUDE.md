# CLAUDE.md — NARCO-WEB

Jeu web 3D coopératif 3 joueurs (iPad Safari PWA + PC), ton arcade / humour noir. Le design complet est dans **`GDD.md`** (concept, 4 actes, règles, inventaire, lieux, jalons, roadmap) — le lire avant toute feature de gameplay.

## État actuel

Jalon J1, étapes 1 et 2 terminées : multi (3 joueurs, code 4 lettres, reconnexion auto) ; quartier de la zone 1 jouable (8 lieux, collisions partagées client/serveur, bouton « Entrer : <lieu> » validé par le serveur, mini-carte) ; direction artistique de nuit ; mode debug persistant et panneau caméra. **Pas encore** : inventaire, production, vente, police, survie, persistance (SQLite prévu plus tard).

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
shared/src/         schemas.ts (zod → types), data.ts (chargement + cohérence de la carte),
                    geometry.ts, locations.ts (portes, lieu proche), collision.ts (cercle/rectangles),
                    movement.ts (validateMove), navgrid.ts (plus courts chemins), roomCode.ts,
                    protocol.ts (messages client↔serveur), *.test.ts
server/src/         index.ts (bootstrap), rooms/NarcoRoom.ts, rooms/schema.ts (state Colyseus)
server/test/        tests d'intégration de room
client/src/net/     connexion, lobby, reconnexion
client/src/game/    scène R3F : city/ (ville fusionnée, décor instancié), joueurs, caméra, labels.tsx
client/src/input/   joystick, bouton action, clavier
client/src/ui/      lobby, HUD, mini-carte, interaction (ACTION + toast), options, panneau caméra, debug
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
9. **Direction artistique** (détail dans `GDD.md` §6) : low-poly, nuit urbaine. Couleurs uniquement via `config.palette` (nuances dérivées par `shade`/`mix`) et `color`/`neonColor` des lieux ; jamais de couleur en dur. Lumières : hémisphère + lune seulement ; tout point lumineux est émissif. Bâtiments générés et **fusionnés par matériau** (`client/src/game/city/buildCity.ts`), décor en `InstancedMesh`, étiquettes en DOM (`game/labels.tsx` ; pas de `Html` de drei, qui casse au démontage avec React 19). Pas de glTF pour les bâtiments principaux. **Découpe** (`game/city/cutout.ts`) : les deux matériaux des bâtiments percent un trou tramé entre la caméra et le joueur local (attribut `aCut` par sommet : 1 = bâtiment, 0 = sol ; le décor a ses propres matériaux sans découpe) ; réglages `config.cutout`, ajustables dans le panneau caméra. Les autres joueurs cachés ont un marqueur DOM (`game/labels.tsx`, test `segmentHitsBox`).
10. Texte de jeu et docs en **français**.
11. **Collisions** : une seule implémentation, `shared/src/collision.ts`, utilisée par la prédiction client et par `validateMove` côté serveur. Tout nouvel obstacle passe par `obstaclesFrom`.

## Réseau

- Room `narco`, `roomId` = code 4 lettres (sans I/O), privée, 3 joueurs distincts max (`onAuth`).
- Identité : `playerId` (UUID en `localStorage`) passé au join ; le state indexe les joueurs par `playerId`. Déconnexion → `connected=false`, l'état est gardé ; rejoindre avec le même `playerId` réattache le joueur.
- Le client se reconnecte seul (backoff + `visibilitychange`/`pageshow`/`online`). La room survit vide pendant `config.room.emptyRoomTtlSeconds`.
- Le code de la dernière room est gardé en `localStorage` : après un rechargement (iOS tue souvent les onglets en arrière-plan), le client y retourne seul.
- Les rooms vivent **en mémoire** : un redémarrage serveur (y compris `tsx watch` après modif d'un JSON) les efface, les clients retombent au lobby. Normal tant que SQLite n'est pas branché.

## Debug / tests manuels

- `?joueur=2` : profil d'identité distinct (plusieurs joueurs dans un même navigateur PC).
- `?debug=1` / `?debug=0` : mode debug **mémorisé** (localStorage), aussi dans Options. Active l'overlay FPS / draw calls / triangles et le panneau caméra ; `window.narco.three` expose `{gl, scene, camera}`, `window.narco.local` la position prédite.
- Captures de rendu (dev) : `POST /__shot?name=x` avec une data URL d'image → `.shots/x.jpg` (ignoré par git).
- Console : `narco.dropSocket()` simule une coupure réseau.
- Variables d'env : `NARCO_SERVER_PORT` (défaut 2567), `NARCO_SERVER_HOST` (défaut 0.0.0.0). Ne pas utiliser `PORT` (souvent injecté par les outils).
