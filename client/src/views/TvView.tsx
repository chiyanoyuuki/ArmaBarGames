import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
import {
  C2S,
  DIFFICULTY_POINTS,
  type GameState,
  type Team,
} from "@armabar/shared";
import { emitAck } from "../socket";
import { useCountdown, useGameState, useSfx } from "../hooks";
import { unlockAudio } from "../sound";

export function TvView() {
  const [params] = useSearchParams();
  const room = (params.get("room") ?? "").toUpperCase();
  const state = useGameState();
  const [joinError, setJoinError] = useState<string | null>(null);
  const [audioOn, setAudioOn] = useState(false);
  useSfx(audioOn);

  useEffect(() => {
    if (!room) return;
    emitAck(C2S.TvJoin, { roomCode: room }).then((res) => {
      if (!res.ok) setJoinError(res.error ?? "Connexion impossible");
    });
  }, [room]);

  if (!room) {
    return (
      <div className="screen tv center">
        <p>Ajoute un code de room à l'URL : <code>/tv?room=XXXX</code></p>
      </div>
    );
  }
  if (joinError) {
    return (
      <div className="screen tv center">
        <p>❌ {joinError}</p>
      </div>
    );
  }
  if (!state) {
    return <div className="screen tv center"><p>Connexion…</p></div>;
  }

  return (
    <div className="screen tv">
      {!audioOn && (
        <button
          className="audio-unlock"
          onClick={() => {
            unlockAudio();
            setAudioOn(true);
          }}
        >
          🔊 Activer le son
        </button>
      )}
      <Scoreboard teams={state.teams} phase={state.phase} />
      {state.paused && <div className="pause-banner">⏸ Partie en pause</div>}
      <TvBody state={state} />
    </div>
  );
}

function TvBody({ state }: { state: GameState }) {
  switch (state.phase) {
    case "lobby":
      return <Lobby state={state} />;
    case "theme_voting":
      return <ThemeVoting state={state} />;
    case "question":
    case "reveal":
      return <QuestionBoard state={state} />;
    case "leaderboard":
      return <LeaderboardScreen state={state} />;
    case "finished":
      return <Podium teams={state.teams} />;
    default:
      return null;
  }
}

function LeaderboardScreen({ state }: { state: GameState }) {
  const rows = state.standings ?? [];
  const maxScore = Math.max(1, ...rows.map((r) => r.score));
  const teamById = (id: string) => state.teams.find((t) => t.id === id);
  return (
    <div className="lb-screen">
      <h2 className="lb-title">Classement</h2>
      <div className="lb-rows">
        {rows.map((r) => {
          const team = teamById(r.teamId);
          const move =
            r.delta == null ? "" : r.delta > 0 ? "up" : r.delta < 0 ? "down" : "same";
          return (
            <div key={r.teamId} className={`lb-row rank-${r.rank}`}>
              <span className="lb-rank">{r.rank}</span>
              <span className="lb-avatar">{team?.avatar}</span>
              <span className="lb-name">{team?.name}</span>
              {r.delta != null && (
                <span className={`lb-move ${move}`}>
                  {r.delta > 0 ? `▲ ${r.delta}` : r.delta < 0 ? `▼ ${-r.delta}` : "="}
                </span>
              )}
              <div className="lb-bar-track">
                <div className="lb-bar-fill" style={{ width: `${(r.score / maxScore) * 100}%` }} />
              </div>
              <span className="lb-score">{r.score}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Scoreboard -----------------------------------------------------------

function Scoreboard({ teams, phase }: { teams: Team[]; phase: string }) {
  if (teams.length === 0 || phase === "lobby") return null;
  const sorted = [...teams].sort((a, b) => b.score - a.score);
  return (
    <div className="scoreboard">
      {sorted.map((t, i) => (
        <div key={t.id} className={`score-chip ${i === 0 ? "leader" : ""}`}>
          <span className="score-rank">{i + 1}</span>
          <span className="score-avatar">{t.avatar}</span>
          <span className="score-name">{t.name}</span>
          <span className="score-pts">{t.score}</span>
        </div>
      ))}
    </div>
  );
}

// --- Lobby ----------------------------------------------------------------

function useQr(text: string) {
  const [url, setUrl] = useState<string>("");
  useEffect(() => {
    QRCode.toDataURL(text, { width: 460, margin: 1 }).then(setUrl).catch(() => {});
  }, [text]);
  return url;
}

function Lobby({ state }: { state: GameState }) {
  const joinUrl = `${window.location.origin}/play?room=${state.roomCode}`;
  const qr = useQr(joinUrl);
  return (
    <div className="lobby">
      <div className="lobby-left">
        <h2 className="lobby-title">Rejoignez la partie !</h2>
        <div className="lobby-code">
          <span className="lobby-code-label">Code</span>
          <span className="lobby-code-value">{state.roomCode}</span>
        </div>
        {qr && <img className="lobby-qr" src={qr} alt="QR pour rejoindre" />}
        <p className="lobby-url">{joinUrl}</p>
      </div>
      <div className="lobby-right">
        <h3>{state.teams.length} équipe{state.teams.length > 1 ? "s" : ""}</h3>
        <div className="team-grid">
          {state.teams.map((t) => (
            <div key={t.id} className={`team-badge ${t.connected ? "" : "off"}`}>
              <span className="team-badge-avatar">{t.avatar}</span>
              <span>{t.name}</span>
            </div>
          ))}
          {state.teams.length === 0 && (
            <p className="muted">En attente des premières équipes…</p>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Vote des themes ------------------------------------------------------

function ThemeVoting({ state }: { state: GameState }) {
  const remaining = useCountdown(state.voteEndsAt, state.paused);
  const maxVotes = Math.max(1, ...Object.values(state.voteTally));
  const sorted = [...state.themes].sort(
    (a, b) => (state.voteTally[b.id] ?? 0) - (state.voteTally[a.id] ?? 0)
  );
  const voting = !!state.voteEndsAt;

  return (
    <div className="voting">
      <div className="voting-head">
        <h2>{voting ? "Votez vos thèmes !" : "Thèmes retenus 🎉"}</h2>
        {voting ? (
          <div className="voting-timer">{Math.ceil(remaining / 1000)}s</div>
        ) : (
          <div className="voting-sub">{state.totalVoters} vote(s)</div>
        )}
      </div>
      <div className="theme-bars">
        {sorted.map((t) => {
          const votes = state.voteTally[t.id] ?? 0;
          const selected = state.selectedThemeIds.includes(t.id);
          return (
            <div
              key={t.id}
              className={`theme-bar ${selected && !voting ? "selected" : ""}`}
            >
              <div className="theme-bar-label">
                <span className="theme-emoji">{t.emoji}</span>
                {t.name}
              </div>
              <div className="theme-bar-track">
                <div
                  className="theme-bar-fill"
                  style={{ width: `${(votes / maxVotes) * 100}%` }}
                />
              </div>
              <div className="theme-bar-count">{votes}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Question / Reveal ----------------------------------------------------

const OPTION_LETTERS = ["A", "B", "C", "D"];

const MODE_LABELS: Record<string, string> = {
  qcm: "QCM",
  buzzer: "Buzzer 🔔",
  open: "Réponse libre ✍️",
  estimation: "Estimation 🎯",
  ordre: "Dans l'ordre 🔢",
};

function QuestionBoard({ state }: { state: GameState }) {
  const q = state.question;
  const remaining = useCountdown(state.questionEndsAt, state.paused);
  if (!q) return null;
  const revealing = state.phase === "reveal";
  const reveal = state.reveal;

  return (
    <div className="question-board">
      <div className="question-head">
        <span className={`diff-badge diff-${q.difficulty}`}>
          {q.difficulty.toUpperCase()} · {DIFFICULTY_POINTS[q.difficulty]} pts
        </span>
        <span className="mode-badge">{MODE_LABELS[q.type] ?? q.type}</span>
        <span className="question-meta">
          {q.themeName} — {q.universeName}
        </span>
        <span className="question-progress">
          {q.index}/{q.total}
        </span>
      </div>

      <h2 className="question-text">{q.text}</h2>

      {!revealing && <TimerRing remaining={remaining} total={state.config.questionTimeMs} />}

      {q.type === "qcm" && <QcmBody state={state} />}
      {q.type === "ordre" && <OrdreBody state={state} />}
      {q.type === "buzzer" && <BuzzerBody state={state} />}
      {q.type === "open" && <OpenBody state={state} />}
      {q.type === "estimation" && <EstimationBody state={state} />}

      {!revealing && q.type !== "buzzer" && <AnswerDots state={state} />}
      {revealing && reveal?.funFact && <p className="fun-fact">💡 {reveal.funFact}</p>}
    </div>
  );
}

function QcmBody({ state }: { state: GameState }) {
  const q = state.question!;
  const reveal = state.reveal;
  const revealing = state.phase === "reveal";
  const totalAnswers = reveal?.optionCounts
    ? Object.values(reveal.optionCounts).reduce((a, b) => a + b, 0)
    : 0;
  return (
    <div className="options-grid">
      {(q.options ?? []).map((opt, i) => {
        const isCorrect = reveal?.correctOptionId === opt.id;
        const count = reveal?.optionCounts?.[opt.id] ?? 0;
        const pct = totalAnswers ? Math.round((count / totalAnswers) * 100) : 0;
        return (
          <div key={opt.id} className={`option ${revealing ? (isCorrect ? "correct" : "dimmed") : ""}`}>
            <span className="option-letter">{OPTION_LETTERS[i]}</span>
            <span className="option-label">{opt.label}</span>
            {revealing && <span className="option-stat">{count} · {pct}%</span>}
          </div>
        );
      })}
    </div>
  );
}

function OrdreBody({ state }: { state: GameState }) {
  const q = state.question!;
  const revealing = state.phase === "reveal";
  const list = revealing ? state.reveal?.correctOrder ?? [] : q.items ?? [];
  return (
    <ol className="tv-ordre">
      {list.map((it, i) => (
        <li key={it.id} className={revealing ? "correct" : ""}>
          <span className="tv-ordre-num">{revealing ? i + 1 : "?"}</span>
          {it.label}
        </li>
      ))}
    </ol>
  );
}

function BuzzerBody({ state }: { state: GameState }) {
  const revealing = state.phase === "reveal";
  if (revealing) {
    const winnerId = Object.entries(state.reveal?.gains ?? {}).find(([, g]) => g > 0)?.[0];
    const winner = state.teams.find((t) => t.id === winnerId);
    return (
      <div className="buzzer-tv">
        <p className="reveal-answer big">Réponse : <strong>{state.reveal?.correctAnswer}</strong></p>
        <p className="muted">{winner ? `🏆 ${winner.name} a trouvé !` : "Personne n'a trouvé 😬"}</p>
      </div>
    );
  }
  const buzz = state.buzz;
  const current = state.teams.find((t) => t.id === buzz?.current);
  return (
    <div className="buzzer-tv">
      {current ? (
        <div className="buzzer-current">🔔 <strong>{current.name}</strong> répond !</div>
      ) : (
        <div className="buzzer-open">Buzzez ! 🔔</div>
      )}
      {buzz && buzz.lockedOut.length > 0 && (
        <p className="muted">
          Éliminés : {buzz.lockedOut.map((id) => state.teams.find((t) => t.id === id)?.name).join(", ")}
        </p>
      )}
    </div>
  );
}

function OpenBody({ state }: { state: GameState }) {
  const revealing = state.phase === "reveal";
  if (!revealing) return null;
  const reveal = state.reveal;
  return (
    <div className="open-tv">
      <p className="reveal-answer big">Réponse : <strong>{reveal?.correctAnswer}</strong></p>
      <div className="open-subs">
        {(reveal?.submissions ?? []).map((s) => {
          const team = state.teams.find((t) => t.id === s.teamId);
          return (
            <div key={s.teamId} className={`open-sub ${s.correct ? "ok" : "ko"}`}>
              <span>{team?.avatar} {team?.name}</span>
              <span className="open-sub-text">« {s.text || "—"} »</span>
              <span>{s.correct ? "✅" : "❌"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EstimationBody({ state }: { state: GameState }) {
  const revealing = state.phase === "reveal";
  if (!revealing) return null;
  const reveal = state.reveal;
  const target = reveal?.answerValue ?? 0;
  const subs = [...(reveal?.submissions ?? [])].sort(
    (a, b) => Math.abs((a.value ?? Infinity) - target) - Math.abs((b.value ?? Infinity) - target)
  );
  return (
    <div className="open-tv">
      <p className="reveal-answer big">
        Réponse exacte : <strong>{reveal?.correctAnswer}</strong>
      </p>
      <div className="open-subs">
        {subs.map((s) => {
          const team = state.teams.find((t) => t.id === s.teamId);
          return (
            <div key={s.teamId} className={`open-sub ${s.correct ? "ok" : ""}`}>
              <span>{team?.avatar} {team?.name}</span>
              <span className="open-sub-text">{s.value}</span>
              <span>{s.correct ? "🏆" : ""}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AnswerDots({ state }: { state: GameState }) {
  const connected = state.teams.filter((t) => t.connected);
  return (
    <div className="answer-dots">
      {connected.map((t) => {
        const answered = state.answeredTeamIds.includes(t.id);
        return (
          <div
            key={t.id}
            className={`answer-dot ${answered ? "answered" : ""}`}
            title={t.name}
          >
            {t.avatar}
          </div>
        );
      })}
      <span className="answer-count">
        {state.answeredTeamIds.length}/{connected.length} ont répondu
      </span>
    </div>
  );
}

function TimerRing({ remaining, total }: { remaining: number; total: number }) {
  const pct = Math.max(0, Math.min(1, remaining / total));
  const seconds = Math.ceil(remaining / 1000);
  return (
    <div className={`timer-ring ${seconds <= 5 ? "urgent" : ""}`}>
      <div className="timer-ring-num">{seconds}</div>
      <div className="timer-ring-track">
        <div className="timer-ring-fill" style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}

// --- Podium ---------------------------------------------------------------

function Confetti() {
  const colors = ["#ff3d81", "#7c4dff", "#ffd23f", "#2ee6a6", "#4dd0ff"];
  const pieces = Array.from({ length: 80 }, (_, i) => i);
  return (
    <div className="confetti" aria-hidden>
      {pieces.map((i) => (
        <span
          key={i}
          style={{
            left: `${Math.random() * 100}%`,
            background: colors[i % colors.length],
            animationDelay: `${Math.random() * 3}s`,
            animationDuration: `${2.5 + Math.random() * 2.5}s`,
          }}
        />
      ))}
    </div>
  );
}

function Podium({ teams }: { teams: Team[] }) {
  const sorted = [...teams].sort((a, b) => b.score - a.score);
  const [first, second, third] = sorted;
  return (
    <div className="podium">
      <Confetti />
      <h2 className="podium-title">🏆 Résultats finaux 🏆</h2>
      <div className="podium-stage">
        {second && <PodiumBlock team={second} place={2} />}
        {first && <PodiumBlock team={first} place={1} />}
        {third && <PodiumBlock team={third} place={3} />}
      </div>
      <div className="podium-rest">
        {sorted.slice(3).map((t, i) => (
          <div key={t.id} className="podium-row">
            <span>{i + 4}.</span> {t.avatar} {t.name}
            <span className="podium-row-pts">{t.score}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PodiumBlock({ team, place }: { team: Team; place: number }) {
  const medals = { 1: "🥇", 2: "🥈", 3: "🥉" } as Record<number, string>;
  return (
    <div className={`podium-block place-${place}`}>
      <div className="podium-medal">{medals[place]}</div>
      <div className="podium-avatar">{team.avatar}</div>
      <div className="podium-name">{team.name}</div>
      <div className="podium-pts">{team.score} pts</div>
      <div className="podium-pillar">{place}</div>
    </div>
  );
}
