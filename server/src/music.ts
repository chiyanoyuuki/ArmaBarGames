// Playlist de musique d'ambiance a partir de fichiers deposes par l'animateur.
// Depose tes .mp3 (ou .ogg/.m4a/.wav) dans data/music/ (ou ARMABAR_MUSIC).
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, basename } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MUSIC_DIR =
  process.env.ARMABAR_MUSIC || join(__dirname, "..", "..", "data", "music");

const EXTS = new Set([".mp3", ".ogg", ".m4a", ".wav", ".aac", ".flac"]);

if (!existsSync(MUSIC_DIR)) {
  try {
    mkdirSync(MUSIC_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

/** Transforme un nom de fichier en titre lisible. */
function prettify(file: string): string {
  return basename(file, extname(file)).replace(/[_-]+/g, " ").trim();
}

/** Liste les morceaux disponibles (relu a chaque appel : depose a chaud). */
export function listMusic(): { file: string; title: string }[] {
  try {
    return readdirSync(MUSIC_DIR)
      .filter((f) => EXTS.has(extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, "fr"))
      .map((file) => ({ file, title: prettify(file) }));
  } catch {
    return [];
  }
}
