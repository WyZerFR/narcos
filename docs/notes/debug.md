# Debug et tests manuels

- `?joueur=2` : identité distincte (plusieurs joueurs dans un navigateur PC).
- `?debug=1` / `?debug=0` : mode debug mémorisé (aussi dans Options) : overlay FPS / draw calls / triangles, panneau caméra ; `window.narco.three` = `{gl, scene, camera}`, `window.narco.local` = position prédite.
- Console : `narco.dropSocket()` (coupure réseau), `narco.advance()` (une frame à la demande).
- Captures (dev) : `POST /__shot?name=x` avec une data URL → `.shots/x.jpg`.
- Panneau debug : donner un objet, vider le stock, équiper / vider le labo, temps x1/x10/x60, acheteur à côté, +5 pochons, +100 $, jauges pleines / vides, survie x1/x10/x60, réapprovisionner (refusé si `config.debug.commands` est faux).
- Tests serveur : chaque fichier démarre son serveur sur un port dédié (`server/test/helpers.ts`, `bootOn`, ports 2570–2577), fichiers en parallèle.
