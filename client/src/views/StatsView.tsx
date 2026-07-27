import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { GlobalStats, GameRecord, Theme, Universe } from "@armabar/shared";

type HistoryGame = Omit<GameRecord, "rounds">;
type Catalog = { themes: Theme[]; universes: Universe[] };

const TYPE_LABELS: Record<string, string> = {
  qcm: "QCM",
  buzzer: "Buzzer",
  open: "Réponse écrite",
  estimation: "Estimation",
  ordre: "Ordre",
};

export function StatsView() {
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const [history, setHistory] = useState<HistoryGame[] | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/stats").then((r) => r.json()),
      fetch("/api/history").then((r) => r.json()),
      fetch("/api/catalog").then((r) => r.json()),
    ])
      .then(([s, h, c]) => {
        setStats(s);
        setHistory(h);
        setCatalog(c);
      })
      .catch(() => setError(true));
  }, []);

  const universeName = (id: string) =>
    catalog?.universes.find((u) => u.id === id)?.name ?? id;

  if (error) {
    return (
      <div className="screen stats center">
        <p>Impossible de charger les statistiques.</p>
        <Link className="btn" to="/">Accueil</Link>
      </div>
    );
  }
  if (!stats) {
    return <div className="screen stats center"><p>Chargement…</p></div>;
  }

  if (stats.games === 0) {
    return (
      <div className="screen stats center">
        <h1 className="stats-title">📊 Statistiques</h1>
        <p className="muted">Aucune partie archivée pour l'instant. Jouez une soirée, et les records apparaîtront ici !</p>
        <Link className="btn" to="/">Accueil</Link>
      </div>
    );
  }

  const records = [
    stats.highestScore && { emoji: "👑", label: "Meilleur score", value: `${stats.highestScore.value} pts`, who: stats.highestScore.teamName },
    stats.longestStreak && { emoji: "🔥", label: "Plus longue série", value: `${stats.longestStreak.value} d'affilée`, who: stats.longestStreak.teamName },
    stats.buzzerKing && { emoji: "🔔", label: "Roi du buzzer", value: `${stats.buzzerKing.wins} buzz`, who: stats.buzzerKing.teamName },
    stats.favoriteUniverse && { emoji: "⭐", label: "Univers favori", value: `${stats.favoriteUniverse.count} questions`, who: universeName(stats.favoriteUniverse.universeId) },
  ].filter(Boolean) as { emoji: string; label: string; value: string; who: string }[];

  const maxType = Math.max(1, ...Object.values(stats.typeBreakdown));

  return (
    <div className="screen stats">
      <div className="stats-header">
        <h1 className="stats-title">📊 Statistiques des soirées</h1>
        <Link className="btn small" to="/">Accueil</Link>
      </div>

      <div className="stat-tiles">
        <StatTile n={stats.games} label="soirées" />
        <StatTile n={stats.questionsPlayed} label="questions jouées" />
        <StatTile n={stats.distinctTeams} label="équipes différentes" />
        <StatTile n={stats.totalCorrect} label="bonnes réponses" />
      </div>

      <h2 className="stats-h2">🏅 Records</h2>
      <div className="record-grid">
        {records.map((r) => (
          <div key={r.label} className="record-card">
            <span className="record-emoji">{r.emoji}</span>
            <div className="record-body">
              <div className="record-label">{r.label}</div>
              <div className="record-who">{r.who}</div>
              <div className="record-value">{r.value}</div>
            </div>
          </div>
        ))}
      </div>

      {(stats.hardestQuestion || stats.easiestQuestion) && (
        <div className="qextremes">
          {stats.hardestQuestion && (
            <div className="qextreme hard">
              <span>😱 La plus ratée</span>
              <p>« {stats.hardestQuestion.text} »</p>
              <small>{Math.round(stats.hardestQuestion.rate * 100)} % de réussite</small>
            </div>
          )}
          {stats.easiestQuestion && (
            <div className="qextreme easy">
              <span>😎 La plus facile</span>
              <p>« {stats.easiestQuestion.text} »</p>
              <small>{Math.round(stats.easiestQuestion.rate * 100)} % de réussite</small>
            </div>
          )}
        </div>
      )}

      <h2 className="stats-h2">🎲 Types de questions</h2>
      <div className="type-bars">
        {Object.entries(stats.typeBreakdown)
          .sort((a, b) => b[1] - a[1])
          .map(([type, n]) => (
            <div key={type} className="type-bar">
              <span className="type-bar-label">{TYPE_LABELS[type] ?? type}</span>
              <div className="type-bar-track">
                <div className="type-bar-fill" style={{ width: `${(n / maxType) * 100}%` }} />
              </div>
              <span className="type-bar-n">{n}</span>
            </div>
          ))}
      </div>

      {stats.topTeams.length > 0 && (
        <>
          <h2 className="stats-h2">🏆 Classement des habitués</h2>
          <table className="top-teams">
            <thead>
              <tr><th>#</th><th>Équipe</th><th>Parties</th><th>Victoires</th><th>Score cumulé</th></tr>
            </thead>
            <tbody>
              {stats.topTeams.map((t, i) => (
                <tr key={t.name + i}>
                  <td>{i + 1}</td>
                  <td>{t.name}</td>
                  <td>{t.games}</td>
                  <td>{t.wins}</td>
                  <td>{t.totalScore}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {history && history.length > 0 && (
        <>
          <h2 className="stats-h2">🕓 Dernières soirées</h2>
          <div className="history-list">
            {history.map((g) => {
              const winner = g.teams.find((t) => t.finalRank === 1);
              const date = new Date(g.endedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
              return (
                <div key={g.id} className="history-row">
                  <span className="history-date">{date}</span>
                  <span className="history-winner">🥇 {winner?.name ?? "—"}</span>
                  <span className="history-meta">{g.teams.length} équipes · {g.totalQuestions} questions</span>
                  <span className="history-awards">{g.awards.map((a) => a.emoji).join(" ")}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function StatTile({ n, label }: { n: number; label: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-tile-n">{n}</div>
      <div className="stat-tile-label">{label}</div>
    </div>
  );
}
