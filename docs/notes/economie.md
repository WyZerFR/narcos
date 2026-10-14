# Argent, magasins, survie, vente de rue

- **Argent** : sale = objet `cash_dirty` du sac (confiscable), propre = compte `Player.cleanMoney`.
- **Magasins** : prix uniquement dans `shops.json`, calculés par le serveur (`Player.cart`, `cartTotal`, `rooms/shop.ts`) ; le panier réserve en rayon, paiement au comptoir tout ou rien, panier rendu en sortant / à la déconnexion / au KO.
- **Survie** : jauges réglées par le serveur depuis `survivalAt` (temps de jeu × `clock.survivalScale` en debug), uniquement pour les joueurs connectés. Ralentissement sous le seuil bas (même facteur dans la prédiction client), KO = perte d'argent sale + réapparition au carton. Aucune logique de survie côté client.
- **Vente de rue** : PNJ simulés par le serveur (`rooms/npcs.ts`), grille `findPath`, positions écrites à `config.npc.broadcastHz`. Demande tirée à l'apparition (`rollDemand`, profils `npcs.json`), prix = `pouchSellPrice` × (1 ± `economy.sale.priceVariance`).
- `sale.open` réserve le PNJ pour un seul joueur jusqu'à la fin de sa patience ; `sale.accept` / `sale.decline`. Verrou levé si le joueur change de zone, se déconnecte ou tombe KO. Cooldown puis nouvelle demande.
- Chaque vente émet `sale_completed` (`SaleCompletedEvent`) sur `room.events` : point d'accroche du Heat et de la police.
- `npm run balance` : rentabilité par cycle / minute et débouché de la rue, depuis les JSON.
