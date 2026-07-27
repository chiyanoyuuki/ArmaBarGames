# 🎵 Musique d'ambiance

Dépose ici tes morceaux d'ambiance (ceux que tu crées par IA, par exemple) et
ils apparaîtront automatiquement dans la playlist pilotable depuis le téléphone
de l'animateur — aucune configuration, aucun redémarrage nécessaire.

## Comment faire

1. Glisse tes fichiers audio dans ce dossier (`data/music/`).
2. Formats acceptés : `.mp3`, `.ogg`, `.m4a`, `.wav`, `.aac`, `.flac`.
3. Le **titre affiché** est le nom du fichier sans extension (les `_` et `-`
   deviennent des espaces). Ex. `neon_bar-01.mp3` → « neon bar 01 ».
4. Ordre de lecture : alphabétique.

## Pilotage (barre musique de l'animateur, toujours visible)

- **🎵 / 🔇** : marche / arrêt.
- **⏭** : morceau suivant.
- **Sélecteur** : choisir un morceau précis (bouton ↻ pour rafraîchir après
  avoir ajouté des fichiers).
- **Curseur** : volume.

La musique est jouée **sur la TV** (le son sort de l'écran de la soirée). En
fin de morceau, la piste suivante s'enchaîne automatiquement (playlist en
boucle). **Sans aucun fichier ici**, la TV se rabat sur une nappe d'ambiance
générative (synthétisée, aucun fichier requis).

> Chemin configurable via la variable d'environnement `ARMABAR_MUSIC`.

Les fichiers audio de ce dossier sont **ignorés par git** (voir `.gitignore`) :
ils restent chez toi et ne sont pas versionnés.
