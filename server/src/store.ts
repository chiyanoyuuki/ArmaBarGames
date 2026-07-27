// Archivage durable des parties (SQLite) + calcul des statistiques globales.
// Base fichier unique, robuste, sans serveur. Le chemin est configurable via
// ARMABAR_DB ; par defaut data/archive/armabar.db.
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GameRecord, GlobalStats, TeamGameStats, RoundLog } from "@armabar/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = join(__dirname, "..", "..", "data", "archive");
const DB_PATH = process.env.ARMABAR_DB || join(ARCHIVE_DIR, "armabar.db");

if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL"); // durabilite + ecritures concurrentes sereines
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    startedAt INTEGER NOT NULL,
    endedAt INTEGER NOT NULL,
    themeIds TEXT NOT NULL,
    universeIds TEXT NOT NULL,
    totalQuestions INTEGER NOT NULL,
    awards TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS game_teams (
    gameId TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL,
    finalScore INTEGER NOT NULL,
    finalRank INTEGER NOT NULL,
    correct INTEGER NOT NULL,
    answered INTEGER NOT NULL,
    buzzerWins INTEGER NOT NULL,
    maxStreak INTEGER NOT NULL,
    avgAnswerMs INTEGER
  );
  CREATE TABLE IF NOT EXISTS game_rounds (
    gameId TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    questionId TEXT NOT NULL,
    text TEXT NOT NULL,
    type TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    universeId TEXT NOT NULL,
    answerCount INTEGER NOT NULL,
    correctCount INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_teams_game ON game_teams(gameId);
  CREATE INDEX IF NOT EXISTS idx_rounds_game ON game_rounds(gameId);
`);

const insertGame = db.prepare(
  `INSERT OR REPLACE INTO games (id, startedAt, endedAt, themeIds, universeIds, totalQuestions, awards)
   VALUES (@id, @startedAt, @endedAt, @themeIds, @universeIds, @totalQuestions, @awards)`
);
const insertTeam = db.prepare(
  `INSERT INTO game_teams (gameId, name, avatar, finalScore, finalRank, correct, answered, buzzerWins, maxStreak, avgAnswerMs)
   VALUES (@gameId, @name, @avatar, @finalScore, @finalRank, @correct, @answered, @buzzerWins, @maxStreak, @avgAnswerMs)`
);
const insertRound = db.prepare(
  `INSERT INTO game_rounds (gameId, questionId, text, type, difficulty, universeId, answerCount, correctCount)
   VALUES (@gameId, @questionId, @text, @type, @difficulty, @universeId, @answerCount, @correctCount)`
);

const saveTx = db.transaction((record: GameRecord) => {
  insertGame.run({
    id: record.id,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    themeIds: JSON.stringify(record.themeIds),
    universeIds: JSON.stringify(record.universeIds),
    totalQuestions: record.totalQuestions,
    awards: JSON.stringify(record.awards),
  });
  for (const t of record.teams) {
    insertTeam.run({ gameId: record.id, ...t });
  }
  for (const r of record.rounds) {
    insertRound.run({ gameId: record.id, ...r });
  }
});

export function saveGame(record: GameRecord): void {
  try {
    saveTx(record);
  } catch (e) {
    console.error("Archivage impossible :", e);
  }
}

export function loadGames(): GameRecord[] {
  const games = db.prepare(`SELECT * FROM games ORDER BY endedAt ASC`).all() as any[];
  const teamsStmt = db.prepare(`SELECT * FROM game_teams WHERE gameId = ?`);
  const roundsStmt = db.prepare(`SELECT * FROM game_rounds WHERE gameId = ?`);
  return games.map((g) => ({
    id: g.id,
    startedAt: g.startedAt,
    endedAt: g.endedAt,
    themeIds: JSON.parse(g.themeIds),
    universeIds: JSON.parse(g.universeIds),
    totalQuestions: g.totalQuestions,
    awards: JSON.parse(g.awards),
    teams: (teamsStmt.all(g.id) as any[]).map(
      ({ gameId, ...t }): TeamGameStats => t
    ),
    rounds: (roundsStmt.all(g.id) as any[]).map(
      ({ gameId, ...r }): RoundLog => r
    ),
  }));
}

/** Nombre de parties archivees (leger, sans tout charger). */
export function gameCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM games`).get() as { n: number }).n;
}

// --- Import unique de l'ancienne archive JSON (retro-compatibilite) --------
(function importLegacyJson() {
  try {
    if (gameCount() > 0) return;
    const legacy = process.env.ARMABAR_ARCHIVE
      ? join(process.env.ARMABAR_ARCHIVE, "history.json")
      : join(ARCHIVE_DIR, "history.json");
    if (!existsSync(legacy)) return;
    const data = JSON.parse(readFileSync(legacy, "utf8"));
    if (Array.isArray(data)) {
      for (const rec of data as GameRecord[]) saveGame(rec);
      console.log(`Archive JSON importée : ${data.length} partie(s).`);
    }
  } catch (e) {
    console.error("Import de l'ancienne archive impossible :", e);
  }
})();

const norm = (s: string) => s.trim().toLowerCase();

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
