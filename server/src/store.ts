// Archivage durable des parties + statistiques globales.
//
// Deux backends possibles, choisis automatiquement :
//  - SQLite (better-sqlite3) si le module natif est disponible ;
//  - sinon repli sur un fichier JSON (100% JS, aucune compilation).
// Dans les deux cas l'archive persiste sur disque. Le code appelant
// (index.ts) ne voit qu'une seule API : saveGame / loadGames / computeStats.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GameRecord, GlobalStats, TeamProfile } from "@armabar/shared";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = join(__dirname, "..", "..", "data", "archive");
if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });

interface Backend {
  kind: string;
  saveGame(record: GameRecord): void;
  loadGames(): GameRecord[];
}

// --- Backend JSON (repli universel) ---------------------------------------

function makeJsonBackend(): Backend {
  const file = process.env.ARMABAR_ARCHIVE
    ? join(process.env.ARMABAR_ARCHIVE, "history.json")
    : join(ARCHIVE_DIR, "history.json");

  const read = (): GameRecord[] => {
    try {
      if (!existsSync(file)) return [];
      const data = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(data) ? (data as GameRecord[]) : [];
    } catch {
      return [];
    }
  };

  return {
    kind: "json",
    loadGames: read,
    saveGame(record) {
      try {
        if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
        const games = read();
        games.push(record);
        writeFileSync(file, JSON.stringify(games, null, 2));
      } catch (e) {
        console.error("Archivage impossible :", e);
      }
    },
  };
}

// --- Backend SQLite (si better-sqlite3 est installé) ----------------------

function makeSqliteBackend(): Backend {
  // Chargement dynamique : si le module natif manque, on lèvera et on
  // basculera sur le backend JSON.
  const Database = require("better-sqlite3");
  const dbPath = process.env.ARMABAR_DB || join(ARCHIVE_DIR, "armabar.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY, startedAt INTEGER, endedAt INTEGER,
      themeIds TEXT, universeIds TEXT, totalQuestions INTEGER, awards TEXT
    );
    CREATE TABLE IF NOT EXISTS game_teams (
      gameId TEXT, name TEXT, avatar TEXT, finalScore INTEGER, finalRank INTEGER,
      correct INTEGER, answered INTEGER, buzzerWins INTEGER, maxStreak INTEGER, avgAnswerMs INTEGER
    );
    CREATE TABLE IF NOT EXISTS game_rounds (
      gameId TEXT, questionId TEXT, text TEXT, type TEXT, difficulty TEXT,
      universeId TEXT, answerCount INTEGER, correctCount INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_teams_game ON game_teams(gameId);
    CREATE INDEX IF NOT EXISTS idx_rounds_game ON game_rounds(gameId);
  `);

  const insertGame = db.prepare(
    `INSERT OR REPLACE INTO games VALUES (@id,@startedAt,@endedAt,@themeIds,@universeIds,@totalQuestions,@awards)`
  );
  const insertTeam = db.prepare(
    `INSERT INTO game_teams VALUES (@gameId,@name,@avatar,@finalScore,@finalRank,@correct,@answered,@buzzerWins,@maxStreak,@avgAnswerMs)`
  );
  const insertRound = db.prepare(
    `INSERT INTO game_rounds VALUES (@gameId,@questionId,@text,@type,@difficulty,@universeId,@answerCount,@correctCount)`
  );
  const saveTx = db.transaction((r: GameRecord) => {
    insertGame.run({
      id: r.id, startedAt: r.startedAt, endedAt: r.endedAt,
      themeIds: JSON.stringify(r.themeIds), universeIds: JSON.stringify(r.universeIds),
      totalQuestions: r.totalQuestions, awards: JSON.stringify(r.awards),
    });
    for (const t of r.teams) insertTeam.run({ gameId: r.id, ...t });
    for (const q of r.rounds) insertRound.run({ gameId: r.id, ...q });
  });

  const backend: Backend = {
    kind: "sqlite",
    saveGame(record) {
      try { saveTx(record); } catch (e) { console.error("Archivage impossible :", e); }
    },
    loadGames() {
      const games = db.prepare(`SELECT * FROM games ORDER BY endedAt ASC`).all();
      const teamsStmt = db.prepare(`SELECT * FROM game_teams WHERE gameId = ?`);
      const roundsStmt = db.prepare(`SELECT * FROM game_rounds WHERE gameId = ?`);
      return games.map((g: any) => ({
        id: g.id, startedAt: g.startedAt, endedAt: g.endedAt,
        themeIds: JSON.parse(g.themeIds), universeIds: JSON.parse(g.universeIds),
        totalQuestions: g.totalQuestions, awards: JSON.parse(g.awards),
        teams: teamsStmt.all(g.id).map(({ gameId, ...t }: any) => t),
        rounds: roundsStmt.all(g.id).map(({ gameId, ...q }: any) => q),
      }));
    },
  };

  // Import unique d'une ancienne archive JSON vers la base, si besoin.
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM games`).get() as { n: number }).n;
  if (count === 0) {
    const legacy = join(ARCHIVE_DIR, "history.json");
    if (existsSync(legacy)) {
      try {
        const data = JSON.parse(readFileSync(legacy, "utf8"));
        if (Array.isArray(data)) {
          for (const rec of data) backend.saveGame(rec);
          console.log(`Archive JSON importée dans SQLite : ${data.length} partie(s).`);
        }
      } catch { /* ignore */ }
    }
  }

  return backend;
}

function selectBackend(): Backend {
  if (process.env.ARMABAR_STORE === "json") return makeJsonBackend();
  try {
    const b = makeSqliteBackend();
    console.log("Archivage : SQLite");
    return b;
  } catch {
    console.log("Archivage : fichier JSON (better-sqlite3 indisponible, repli automatique)");
    return makeJsonBackend();
  }
}

const backend = selectBackend();

export function saveGame(record: GameRecord): void {
  backend.saveGame(record);
}
export function loadGames(): GameRecord[] {
  return backend.loadGames();
}

// --- Statistiques agregees (identique quel que soit le backend) -----------

const norm = (s: string) => s.trim().toLowerCase();

/** Ensemble des noms d'equipes (normalises) ayant deja joue. */
export function knownTeamNames(): Set<string> {
  const set = new Set<string>();
  for (const g of loadGames()) for (const t of g.teams) set.add(norm(t.name));
  return set;
}

/** Fiche agregee d'une equipe recurrente (null si inconnue). */
export function teamProfile(name: string): TeamProfile | null {
  const key = norm(name);
  const games = loadGames().filter((g) => g.teams.some((t) => norm(t.name) === key));
  if (games.length === 0) return null;

  const profile: TeamProfile = {
    name,
    games: 0,
    wins: 0,
    bestScore: 0,
    totalCorrect: 0,
    buzzerWins: 0,
    lastPlayed: null,
    recent: [],
  };

  const sorted = [...games].sort((a, b) => b.endedAt - a.endedAt);
  for (const g of sorted) {
    const t = g.teams.find((x) => norm(x.name) === key)!;
    profile.games += 1;
    if (t.finalRank === 1) profile.wins += 1;
    profile.bestScore = Math.max(profile.bestScore, t.finalScore);
    profile.totalCorrect += t.correct;
    profile.buzzerWins += t.buzzerWins;
    if (profile.lastPlayed === null) profile.lastPlayed = g.endedAt;
    if (profile.recent.length < 10) {
      profile.recent.push({
        endedAt: g.endedAt,
        rank: t.finalRank,
        score: t.finalScore,
        teamsCount: g.teams.length,
      });
    }
  }
  return profile;
}

export function computeStats(games: GameRecord[]): GlobalStats {
  const stats: GlobalStats = {
    games: games.length,
    questionsPlayed: 0,
    distinctTeams: 0,
    totalCorrect: 0,
    highestScore: null,
    favoriteUniverse: null,
    longestStreak: null,
    buzzerKing: null,
    hardestQuestion: null,
    easiestQuestion: null,
    typeBreakdown: {},
    topTeams: [],
  };

  const names = new Set<string>();
  const universeCount: Record<string, number> = {};
  const buzzerByName: Record<string, { name: string; wins: number }> = {};
  const questionAgg: Record<string, { text: string; correct: number; answered: number }> = {};
  const teamAgg: Record<string, { name: string; games: number; wins: number; totalScore: number }> = {};

  for (const g of games) {
    stats.questionsPlayed += g.totalQuestions;

    for (const r of g.rounds) {
      stats.typeBreakdown[r.type] = (stats.typeBreakdown[r.type] ?? 0) + 1;
      universeCount[r.universeId] = (universeCount[r.universeId] ?? 0) + 1;
      const qa = (questionAgg[r.questionId] ??= { text: r.text, correct: 0, answered: 0 });
      qa.correct += r.correctCount;
      qa.answered += r.answerCount;
    }

    for (const t of g.teams) {
      const key = norm(t.name);
      names.add(key);
      stats.totalCorrect += t.correct;

      if (!stats.highestScore || t.finalScore > stats.highestScore.value) {
        stats.highestScore = { value: t.finalScore, teamName: t.name };
      }
      if (!stats.longestStreak || t.maxStreak > stats.longestStreak.value) {
        stats.longestStreak = { value: t.maxStreak, teamName: t.name };
      }
      if (t.buzzerWins > 0) {
        const b = (buzzerByName[key] ??= { name: t.name, wins: 0 });
        b.wins += t.buzzerWins;
      }
      const ta = (teamAgg[key] ??= { name: t.name, games: 0, wins: 0, totalScore: 0 });
      ta.games += 1;
      ta.totalScore += t.finalScore;
      if (t.finalRank === 1) ta.wins += 1;
    }
  }

  stats.distinctTeams = names.size;

  const favUniv = Object.entries(universeCount).sort((a, b) => b[1] - a[1])[0];
  if (favUniv) stats.favoriteUniverse = { universeId: favUniv[0], count: favUniv[1] };

  const king = Object.values(buzzerByName).sort((a, b) => b.wins - a.wins)[0];
  if (king) stats.buzzerKing = { teamName: king.name, wins: king.wins };

  const rated = Object.values(questionAgg)
    .filter((q) => q.answered >= 3)
    .map((q) => ({ text: q.text, rate: q.correct / q.answered }));
  if (rated.length) {
    stats.hardestQuestion = [...rated].sort((a, b) => a.rate - b.rate)[0];
    stats.easiestQuestion = [...rated].sort((a, b) => b.rate - a.rate)[0];
  }

  stats.topTeams = Object.values(teamAgg)
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 10);

  return stats;
}
