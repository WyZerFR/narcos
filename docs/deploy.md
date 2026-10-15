# Déploiement

Un seul service : le serveur Node sert le client compilé (`client/dist`), `/health`, `/info`
et le WebSocket Colyseus (préfixe `/colyseus`) sur le même port et la même origine.

```bash
npm run build   # client/dist
npm start       # serveur de production (PORT, NARCO_DATA_DIR…)
```

## Variables

| Variable            | Rôle                                                                            |
| ------------------- | ------------------------------------------------------------------------------- |
| `PORT`              | Port d'écoute (imposé par Railway / Fly). Repli `NARCO_SERVER_PORT`, puis 2567. |
| `NARCO_DATA_DIR`    | Dossier des sauvegardes (`rooms.json`), créé si absent. Défaut `server/.data`.  |
| `NARCO_ACCESS_CODE` | Optionnel : code demandé au lobby, vérifié par le serveur.                      |
| `NODE_ENV`          | `production` coupe les commandes debug (sauf `NARCO_DEBUG=1`).                  |
| `NARCO_DEBUG`       | `1` pour garder les commandes debug en production (tests entre amis).           |

Parties simultanées : `config.json` → `room.maxRooms` (5). Sauvegarde toutes les
`persistence.snapshotSeconds` et à l'arrêt propre (SIGTERM).

## Railway

1. Pousser le dépôt (privé) sur GitHub.
2. Railway → New Project → Deploy from GitHub repo → choisir le dépôt (autoriser l'accès
   au dépôt privé). Railway détecte le `Dockerfile`.
3. Service → Settings → Volumes → Add Volume, point de montage `/data`.
4. Service → Variables :
   - `NARCO_DATA_DIR=/data`
   - `NODE_ENV=production`
   - `NARCO_ACCESS_CODE=<code à partager avec les joueurs>`
   - `PORT` : fourni par Railway, ne pas le fixer (sinon mettre la même valeur que le port cible
     du domaine).
5. Service → Settings → Networking → Generate Domain (HTTPS, donc WebSocket en `wss`).
6. Settings → Deploy → Healthcheck Path : `/health`.
7. Ouvrir le domaine sur l'iPad (Safari → Partager → Sur l'écran d'accueil pour la PWA).

Chaque push sur `main` redéploie ; le service worker récupère la nouvelle version (numéro
affiché dans Options). Une seule instance : ne pas augmenter le nombre de réplicas (l'état des
parties vit en mémoire).

## Alternative : Fly.io

```bash
fly launch --no-deploy            # détecte le Dockerfile ; refuser la base de données
fly volumes create narco_data --size 1
```

Dans `fly.toml` : `internal_port = 2567` (ou `PORT`), puis

```toml
[env]
  NODE_ENV = "production"
  NARCO_DATA_DIR = "/data"

[mounts]
  source = "narco_data"
  destination = "/data"

[[http_service.checks]]
  path = "/health"
```

`fly secrets set NARCO_ACCESS_CODE=...`, puis `fly deploy`. Garder une seule machine
(`fly scale count 1`) et désactiver l'arrêt automatique si les parties doivent continuer.
