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

## Équipe

Onglet **Équipe** (gérant) : un code personnel par membre du personnel.
- **Gérant** : commandes, carte, tables, équipe.
- **Serveur** : commandes uniquement.

Le code `ADMIN_PIN` reste toujours valable comme gérant principal (code de secours). Les codes sont
enregistrés chiffrés (scrypt). Supprimer un compte ou changer son code le déconnecte immédiatement.

Anti-abus : 5 commandes maximum par table en 10 minutes, 3 appels du serveur en 2 minutes.

## Modifier la carte

Onglet **Menu** de l'interface restaurant : nom et slogan, catégories, plats (prix, description, emoji,
étiquettes, photo). « Enregistrer » publie la carte instantanément sur les téléphones des clients.
Les photos sont réduites dans le navigateur (1000 px, JPEG) puis stockées en base (table `images`).

## Allergènes et mentions légales

- Chaque plat porte les 14 allergènes à déclaration obligatoire (règlement UE n° 1169/2011),
  cochés dans l'éditeur. Côté client, ils s'affichent sur la fiche du plat ; un plat non renseigné
  affiche « Non renseignés : demandez au personnel ».
- Mentions légales (établissement, adresse, SIRET, responsable de la publication, hébergeur) et
  mention sur les prix se remplissent dans l'onglet Menu ; le client y accède en bas de la carte.

## Bons de commande (impression)

Onglet Commandes : bouton 🖨 sur chaque commande, ticket test, largeur du papier (58 mm, 80 mm, A4)
et impression automatique des nouvelles commandes. Ces réglages sont propres à chaque appareil :
activez l'impression automatique uniquement sur l'ordinateur relié à l'imprimante.

Pour imprimer sans boîte de dialogue, lancez Chrome avec `--kiosk-printing` (l'imprimante à tickets
doit être l'imprimante par défaut) :

- Windows : raccourci vers `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing https://VOTRE-SITE/admin`
- Mac : `open -na "Google Chrome" --args --kiosk-printing https://VOTRE-SITE/admin`

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
