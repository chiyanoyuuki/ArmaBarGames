// Archivage des parties + calcul des statistiques globales.
// Store fichier (JSON) volontairement isole : pour passer a une vraie base
// ou un volume persistant, il suffit de reimplementer loadGames/saveGame.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GameRecord, GlobalStats, QuestionType } from "@armabar/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ARCHIVE_DIR =
  process.env.ARMABAR_ARCHIVE || join(__dirname, "..", "..", "data", "archive");
const FILE = join(ARCHIVE_DIR, "history.json");

export function loadGames(): GameRecord[] {
  try {
    if (!existsSync(FILE)) return [];
    const data = JSON.parse(readFileSync(FILE, "utf8"));
    return Array.isArray(data) ? (data as GameRecord[]) : [];
  } catch {
    return []; // fichier corrompu : on repart proprement plutot que de crasher
  }
}

export function saveGame(record: GameRecord): void {
  try {
    if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });
    const games = loadGames();
    games.push(record);
    writeFileSync(FILE, JSON.stringify(games, null, 2));
  } catch (e) {
    console.error("Archivage impossible :", e);
  }
}

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

  // Questions posees a au moins 3 equipes-reponses, pour eviter le bruit.
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
