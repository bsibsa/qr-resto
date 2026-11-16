# QR Resto — commande et paiement à table

Le client scanne le QR code de sa table, parcourt le menu et commande. Il règle ensuite au comptoir ou auprès du serveur.
La commande arrive en temps réel sur l'écran du restaurant. Le serveur n'a plus qu'à l'apporter.

## Mettre en ligne

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/bsibsa/qr-resto)

Render lit `render.yaml` : il génère `TABLE_SECRET` (liens de table stables) et te demande `ADMIN_PIN`.
L'adresse publique est détectée automatiquement pour les QR codes.

## Démarrer en local

```bash
npm install
npm start
```

- Interface restaurant : http://localhost:3000/admin (code PIN par défaut : `1234`)
- Les QR codes de chaque table sont dans l'onglet **Tables & QR** (téléchargement, impression, régénération).

Au premier lancement, 12 tables sont créées avec un lien secret chacune, et la carte d'exemple `data/menu.example.json` est chargée.

## Configuration (variables d'environnement)

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Base PostgreSQL (ex. Neon). Sans elle, tout est stocké dans `data/` : à réserver aux tests en local |
| `PORT` | Port HTTP (3000 par défaut) |
| `BASE_URL` | URL publique du site, encodée dans les QR codes (ex. `https://menu.mon-resto.fr`) |
| `TABLE_SECRET` | Rend les liens des tables stables même si les fichiers sont effacés (recommandé en ligne) |
| `ADMIN_PIN` | Code PIN de l'interface restaurant |

## Fonctionnalités

**Client (mobile)** : écran d'accueil animé, catégories collantes, ajout rapide au panier avec animation, fiche plat avec
précision (« sans oignons »), note pour la cuisine, suivi en direct
(Reçue → En préparation → Prête → Servie), appel serveur et demande d'addition.

**Restaurant** : tableau des commandes en temps réel avec son, colonnes par statut, alerte de retard (> 20 min),
bouton « Encaissée » pour suivre ce qui reste à régler, appels des tables, statistiques du jour, génération et impression des QR,
plats marqués « épuisés » en un clic (retirés instantanément chez les clients).

## Modifier la carte

Onglet **Menu** de l'interface restaurant : nom et slogan, catégories, plats (prix, description, emoji,
étiquettes, photo). « Enregistrer » publie la carte instantanément sur les téléphones des clients.
Les photos sont réduites dans le navigateur (1000 px, JPEG) puis stockées en base (table `images`).

## Données

Avec `DATABASE_URL`, le menu, les tables et 90 jours de commandes sont enregistrés dans PostgreSQL
(tables `kv` et `orders`, créées automatiquement). Sans, ils sont dans `data/*.json`.

## Structure

```
server.js              API, Socket.IO, QR codes
storage.js             stockage PostgreSQL ou fichiers
data/menu.example.json carte chargée au premier démarrage
public/client.*    interface client
public/admin.*     interface restaurant
```
