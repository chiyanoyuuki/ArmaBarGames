# Déployer ArmaBarGames sur un serveur OVH (HTTPS, 24/7)

Ce guide met l'appli en ligne **à une adresse fixe, disponible en
permanence, en HTTPS** — ce qui débloque aussi le **micro du téléphone**
(la capture micro exige une connexion sécurisée).

## ⚠️ À lire d'abord : quel produit OVH ?

ArmaBarGames n'est **pas** un site PHP/HTML classique : c'est un **serveur
Node.js** qui doit **tourner en permanence** (temps réel + WebSockets). Cela
change tout par rapport à un « dépôt FTP » habituel :

| Produit OVH | Ça marche ? |
|-------------|-------------|
| **Hébergement mutualisé / perso** (FTP, PHP, `www/`) | ❌ Non — on ne peut pas y faire tourner un process Node permanent avec WebSockets. |
| **VPS** (accès SSH root, Linux) | ✅ Oui — c'est la cible de ce guide. |
| **Serveur dédié** | ✅ Oui — même principe que le VPS. |

Donc : **FTP sert à envoyer les fichiers**, mais le **lancement se fait en
SSH**. Si tu as un mutualisé, il faut prendre un VPS (le moins cher suffit
largement pour des soirées en famille).

Dans la suite, on suppose un **VPS OVH sous Ubuntu 22.04/24.04** et un
(sous-)domaine, par ex. `quiz.mondomaine.fr`.

---

## 1. Pointer un domaine vers le VPS

1. Récupère l'**IP publique** du VPS (interface OVH → VPS → onglet « … »).
2. Dans la **zone DNS** de ton domaine (OVH → Domaines → Zone DNS), ajoute un
   enregistrement **A** :
   - Sous-domaine : `quiz`
   - Cible : l'IP du VPS (ex. `51.83.xx.xx`)
3. Attends la propagation (quelques minutes à 1 h). Vérifie :
   ```bash
   ping quiz.mondomaine.fr   # doit répondre l'IP du VPS
   ```

Pas de domaine ? Tu peux utiliser directement l'IP, mais **sans domaine tu
n'auras pas de HTTPS Let's Encrypt** (donc pas de micro). Un sous-domaine est
fortement recommandé.

---

## 2. Se connecter au VPS et préparer la machine

```bash
ssh ubuntu@quiz.mondomaine.fr        # ou root@... selon ta config OVH
sudo apt update && sudo apt upgrade -y

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

node -v    # doit afficher v20.x
```

---

## 3. Envoyer le code sur le VPS

### Option A — Git (recommandé, mises à jour faciles)
```bash
cd ~
git clone <URL_DE_TON_DEPOT> armabar
cd armabar
git checkout claude/bar-quiz-game-opr1eo   # ou la branche voulue
```

### Option B — FTP / SFTP (ce que tu demandais)
Avec **FileZilla** (protocole **SFTP**, port 22, tes identifiants SSH) :
1. Connecte-toi au VPS.
2. Envoie **tout le projet** (dossiers `shared/`, `server/`, `client/`,
   `data/`, et les fichiers `package.json`, etc.) dans `/home/ubuntu/armabar`.
3. **N'envoie pas** `node_modules/` (trop lourd, on l'installe sur place) ni
   `client/dist/` (on le régénère).

> Astuce : le classique **FTP** OVH « mutualisé » ne convient pas ici (voir
> l'avertissement en haut). Sur un VPS, utilise **SFTP** (mêmes identifiants
> que SSH) — c'est plus simple et sécurisé.

---

## 4. Installer, construire, tester

```bash
cd ~/armabar
npm install
npm run build          # génère client/dist

# test rapide
npm start
# -> "🎉 ArmaBarGames est lancé !" sur le port 3001
# Ctrl+C pour arrêter une fois vérifié
```

(Optionnel mais conseillé) activer l'archivage SQLite durable :
```bash
npm install better-sqlite3 -w server
```
Sinon l'appli utilise automatiquement un fichier JSON — ça marche aussi.

---

## 5. Faire tourner l'appli en permanence (PM2)

PM2 relance l'appli automatiquement (crash, reboot du VPS) :
```bash
sudo npm install -g pm2

cd ~/armabar
pm2 start "npm run start" --name armabar
pm2 save
pm2 startup            # copie/colle la commande affichée (démarrage au boot)
```
Commandes utiles : `pm2 logs armabar`, `pm2 restart armabar`, `pm2 status`.

L'appli écoute maintenant sur `http://127.0.0.1:3001` (en local sur le VPS).
On la publie proprement à l'étape suivante.

---

## 6. Nginx en frontal + HTTPS (Let's Encrypt)

### Installer Nginx et Certbot
```bash
sudo apt install -y nginx
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/bin/certbot
```

### Configurer le reverse proxy (avec support WebSocket)
```bash
sudo nano /etc/nginx/sites-available/armabar
```
Colle ceci (adapte le `server_name`) :
```nginx
server {
    listen 80;
    server_name quiz.mondomaine.fr;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        # Indispensable pour Socket.io / WebSockets :
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
    }
}
```
Active le site et recharge Nginx :
```bash
sudo ln -s /etc/nginx/sites-available/armabar /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Générer le certificat HTTPS
```bash
sudo certbot --nginx -d quiz.mondomaine.fr
```
Certbot ajoute tout seul le bloc `listen 443 ssl` et le renouvellement
automatique. Réponds « redirect » pour forcer le HTTPS.

✅ Ton appli est en ligne : **https://quiz.mondomaine.fr**

---

## 7. Pare-feu

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # ouvre 80 + 443
sudo ufw enable
```
Le port **3001 n'a pas besoin d'être ouvert** vers l'extérieur : seul Nginx
(en local) y accède.

---

## 8. Jouer 🎉

Tout le monde ouvre **https://quiz.mondomaine.fr** (depuis n'importe où, pas
besoin d'être sur le même Wi-Fi) :
- **Toi (animateur)** → « Créer une partie » → code à 4 lettres.
- **La TV** → « Ouvrir la TV » + code, puis « 🔊 Activer le son ».
- **Les joueurs** → scannent le QR de la TV (il contient déjà l'adresse
  HTTPS) et rejoignent.
- **Micro au buzzer** : l'équipe qui a la main voit « 🎙️ Parler dans la TV »,
  autorise le micro, et sa voix sort sur la télé.

---

## 9. Mettre à jour l'appli plus tard

En Git :
```bash
cd ~/armabar
git pull
npm install
npm run build
pm2 restart armabar
```
En SFTP : ré-envoie les fichiers modifiés, puis `npm run build && pm2 restart
armabar`.

---

## Notes sur le micro (WebRTC)

- Le micro fonctionne dès que le site est en **HTTPS** (fait ci-dessus).
- La liaison audio est **directe entre les appareils** (pair-à-pair) ; le
  serveur ne fait que la mise en relation. Un serveur **STUN public** de
  Google est déjà configuré, ce qui suffit dans la grande majorité des
  réseaux.
- Sur certains réseaux très restrictifs (NAT symétrique, 4G d'entreprise…),
  la connexion pair-à-pair peut échouer ; il faudrait alors un serveur
  **TURN** (relais). Dis-le-moi si tu rencontres le cas, je t'indiquerai
  comment en ajouter un (ex. `coturn` sur le même VPS).

## Dépannage express

| Symptôme | Piste |
|----------|-------|
| Page blanche / 502 | `pm2 status` (appli lancée ?), `pm2 logs armabar` |
| Les téléphones ne se connectent pas en temps réel | vérifier le bloc `Upgrade/Connection` dans Nginx |
| Le micro reste indisponible | l'URL est-elle bien en `https://` ? (pas `http://`) |
| Certificat expiré | `sudo certbot renew` (normalement automatique) |
