# QR Resto — commande et paiement à table

Le client scanne le QR code de sa table, parcourt le menu, commande et paie par carte (ou choisit de payer plus tard).
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

Au premier lancement, 12 tables sont créées avec un lien secret chacune (`data/tables.json`).

## Configuration (variables d'environnement)

| Variable | Rôle |
|---|---|
| `PORT` | Port HTTP (3000 par défaut) |
| `BASE_URL` | URL publique du site, encodée dans les QR codes (ex. `https://menu.mon-resto.fr`) |
| `TABLE_SECRET` | Rend les liens des tables stables même si les fichiers sont effacés (recommandé en ligne) |
| `ADMIN_PIN` | Code PIN de l'interface restaurant |
| `STRIPE_SECRET_KEY` | Active le vrai paiement par carte via Stripe Checkout. Sans cette clé, le paiement est **simulé** (mode démo) |
| `STRIPE_WEBHOOK_SECRET` | (Optionnel) confirme les paiements via le webhook `/api/stripe/webhook` |

## Fonctionnalités

**Client (mobile)** : écran d'accueil animé, catégories collantes, ajout rapide au panier avec animation, fiche plat avec
précision (« sans oignons »), note pour la cuisine, paiement CB ou plus tard, suivi en direct
(Reçue → En préparation → Prête → Servie), appel serveur et demande d'addition.

**Restaurant** : tableau des commandes en temps réel avec son, colonnes par statut, alerte de retard (> 20 min),
statut de paiement et bouton « Encaissée », appels des tables, statistiques du jour, génération et impression des QR,
plats marqués « épuisés » en un clic (retirés instantanément chez les clients).

## Modifier le menu

Éditez `data/menu.json` (prix en centimes), puis redémarrez le serveur.

## Structure

```
server.js          API, Socket.IO, Stripe, QR codes
data/menu.json     carte du restaurant
data/tables.json   tables et liens secrets (généré)
data/orders.json   commandes (généré)
public/client.*    interface client
public/admin.*     interface restaurant
```
