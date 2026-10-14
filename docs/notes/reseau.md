# Réseau, zones, sauvegarde

- Room `narco`, `roomId` = code 4 lettres (sans I/O), privée, 3 joueurs distincts max (`onAuth`).
- Identité : `playerId` (UUID en `localStorage`) passé au join ; joueurs indexés par `playerId`. Déconnexion → `connected=false`, état gardé ; même `playerId` = réattachement.
- Reconnexion auto (backoff + `visibilitychange` / `pageshow` / `online`). Room vide conservée `config.room.emptyRoomTtlSeconds`. Code de la dernière room en `localStorage` (iOS tue les onglets).
- Proxy Vite `/colyseus` → `localhost:2567` : une seule origine, LAN et HTTPS sans config.
- **Zones** : `Player.zone` = `street` ou id d'intérieur ; une seule room ; le client ne rend que sa zone. Les messages `move` portent la zone (ignorés si périmés). Ne pas confondre avec les quartiers zone1/2/3 de `locations.json`.
- **Mouvement** : le client propose une position prédite, `validateMove` la valide/corrige. Collisions : une seule implémentation (`shared/src/collision.ts`), obstacles par zone via `zoneArea`.
- **Horloge** : `shared/src/clock.ts`, accélérable en debug, extrapolée par le client depuis `state.clock`.
- **Sauvegarde** : snapshot JSON toutes les `config.persistence.snapshotSeconds` et à l'arrêt, `server/.data/rooms.json` (`NARCO_DATA_DIR`). Parties recréées avec leur code, joueurs hors ligne jusqu'à reconnexion, temps figé pendant l'arrêt. `schemaVersion` par partie (voir `labo.md`). SQLite plus tard.
- Env : `NARCO_SERVER_PORT` (2567), `NARCO_SERVER_HOST` (0.0.0.0). Ne pas utiliser `PORT`.
