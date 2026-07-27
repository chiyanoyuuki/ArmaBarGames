# 🍻 ArmaBarGames

Jeux pour animer les soirées en bar : une **TV** partagée affiche le jeu, chaque
**équipe** joue depuis un téléphone, et l'**animateur** pilote tout depuis le
sien. Premier jeu : un **quiz** temps réel.

## Le principe

- 📺 **TV** (`/tv?room=CODE`) — l'écran de la soirée : QR pour rejoindre, vote
  des thèmes en direct, questions, réponses animées, classement, podium.
- 📱 **Joueur** (`/play?room=CODE`) — une équipe par table : vote les thèmes,
  répond aux questions (points selon la **vitesse** de réponse).
- 🎛️ **Animateur** (`/host`) — ton téléphone : créer la partie, ajouter/gérer
  les équipes, lancer le vote, lancer la partie, mettre en pause, corriger les
  scores.

Le déroulé d'une partie : **Salon** → **Vote des thèmes** → **Questions**
chronométrées → **Reveal** (bonne réponse + points) → **Podium**.

## Architecture

Monorepo npm workspaces, tout en TypeScript.

```
shared/   Types + protocole Socket.io + règles de scoring (source unique)
server/   Node + Express + Socket.io — machine à états d'une partie = une room
client/   React (Vite) — 3 vues : /tv, /play, /host
data/     Banque de contenu (catalogue de thèmes/univers + questions) + validateur
```

Le serveur diffuse un **état complet** (`GameState`) à chaque changement : la TV,
l'animateur et les téléphones restent synchronisés et les reconnexions sont
gérées sans logique de patch côté client. La bonne réponse n'est jamais envoyée
aux téléphones avant le reveal.

## Démarrer en local

```bash
npm install
npm run dev        # serveur (:3001) + client Vite (:5173)
```

Ouvre ensuite :

- Animateur : http://localhost:5173/host → « Créer une partie »
- TV : le lien affiché sur l'écran animateur (`/tv?room=CODE`)
- Joueurs : scan du QR sur la TV (`/play?room=CODE`)

### Build de production (déploiement cloud, une seule URL)

```bash
npm run build      # compile le client dans client/dist
npm start          # le serveur sert le client + Socket.io sur $PORT (défaut 3001)
```

## Le scoring

- Points de base par difficulté : facile 100 · moyen 200 · dur 300 · pro 400.
- Pondérés par la **vitesse** : réponse instantanée = 100 % des points, à la
  limite du temps = 50 % (jamais moins).
- **Bonus de série** : +10 % par bonne réponse consécutive (plafond +50 %).

Ces règles sont centralisées dans `shared/src/index.ts`.

## Ajouter du contenu

Le contenu vit dans `data/` :

- `data/catalog.json` — les **thèmes** (gros : Manga, Jeux vidéo, Musique…) et
  les **univers** (précis : Naruto, The Witcher, Ed Sheeran…) rattachés à un thème.
- `data/questions/<univers>.json` — les questions d'un univers.

Objectif par univers : **100 questions** — 10 faciles, 20 moyennes, 30 dures,
40 pro. Règles de qualité (vérifiées par le validateur) :

- exactement **4 propositions**, toutes distinctes et non vides ;
- la **réponse ne doit pas apparaître dans l'énoncé** ;
- propositions **homogènes** (même format, ex. tous des noms de famille) ;
- `correctOptionId` doit pointer vers une proposition existante.

Valider la banque :

```bash
npm run validate
```

Les erreurs de structure font échouer la commande (utile en CI) ; les
avertissements (univers incomplet, propositions non homogènes) ne bloquent pas.

### Format d'une question

```json
{
  "id": "naruto-f1",
  "difficulty": "facile",
  "text": "Dans quel village se déroule la majeure partie de l'histoire ?",
  "options": [
    { "id": "a", "label": "Konoha" },
    { "id": "b", "label": "Suna" },
    { "id": "c", "label": "Kiri" },
    { "id": "d", "label": "Iwa" }
  ],
  "correctOptionId": "a",
  "funFact": "Anecdote affichée au reveal (optionnelle)."
}
```

## Archivage & statistiques

Chaque partie terminée est **archivée** automatiquement (équipes, scores,
trophées, trace des questions). Une page **`/stats`** agrège au fil des
soirées des statistiques rigolotes : meilleur score, plus longue série, roi
du buzzer, univers favori, question la plus ratée / la plus facile,
répartition par type, classement des habitués et historique des parties. À
la fin de chaque partie, la TV affiche aussi des **trophées** (⚡ L'Éclair,
🔔 Roi du buzzer, 🔥 Série record, 🧠 Le Cerveau).

- API : `GET /api/stats`, `GET /api/history`, `GET /api/catalog`.
- Stockage **durable** (`server/src/store.ts`) avec deux backends choisis
  automatiquement :
  - **fichier JSON** par défaut (`data/archive/history.json`, 100 % JS,
    aucune dépendance native) — fonctionne partout, y compris Windows ;
  - **SQLite** (base `data/archive/armabar.db`, tables normalisées,
    requêtable) si le module `better-sqlite3` est installé.
- SQLite est **optionnel** et non installé par défaut (module natif, parfois
  difficile à compiler selon l'OS/Node). Pour l'activer :
  `npm install better-sqlite3 -w server` — le store le détecte au démarrage
  et importe automatiquement l'archive JSON existante dans la base.
- Chemins configurables : `ARMABAR_DB` (SQLite), `ARMABAR_ARCHIVE` (dossier
  JSON). `ARMABAR_STORE=json` force le backend JSON.

> ⚠️ En environnement cloud éphémère, le fichier `.db` vit avec le
> conteneur. Pour une conservation durable, pointez `ARMABAR_DB` vers un
> **volume persistant** (ou une base réseau). En local / auto-hébergé, la
> base persiste normalement d'une soirée à l'autre.

## État d'avancement

✅ Scaffold complet et jouable de bout en bout (lobby → vote → quiz → podium),
temps réel testé. Contenu de démo : Naruto + The Witcher (extraits).

Prochaines pistes : remplir les univers à 100 questions, univers/sous-thèmes
votables en 2 temps, effets/musiques, historique des parties.
