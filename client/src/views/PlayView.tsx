import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  C2S,
  TEAM_AVATARS,
  VOTES_PER_TEAM,
  type GameState,
  type TeamJoinAck,
} from "@armabar/shared";
import { emitAck, socket } from "../socket";
import { useGameState } from "../hooks";
import { unlockAudio } from "../sound";

function storageKey(room: string) {
  return `armabar:team:${room}`;
}

export function PlayView() {
  const [params] = useSearchParams();
  const room = (params.get("room") ?? "").toUpperCase();
  const state = useGameState();
  const [teamId, setTeamId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reconnexion automatique si on a deja rejoint cette room.
  useEffect(() => {
    if (!room) return;
    const saved = localStorage.getItem(storageKey(room));
    if (!saved) return;
    const { teamId: savedId, name } = JSON.parse(saved);
    const doJoin = () =>
      emitAck<TeamJoinAck>(C2S.TeamJoin, {
        roomCode: room,
        teamName: name,
        teamId: savedId,
      }).then((res) => {
        if (res.ok && res.data) setTeamId(res.data.teamId);
      });
    doJoin();
    socket.on("connect", doJoin);
    return () => {
      socket.off("connect", doJoin);
    };
  }, [room]);

  const join = async (name: string, avatar: string) => {
    unlockAudio();
    const res = await emitAck<TeamJoinAck>(C2S.TeamJoin, {
      roomCode: room,
      teamName: name,
      avatar,
    });
    if (res.ok && res.data) {
      setTeamId(res.data.teamId);
      localStorage.setItem(storageKey(room), JSON.stringify({ teamId: res.data.teamId, name }));
    } else {
      setError(res.error ?? "Impossible de rejoindre");
    }
  };

  if (!room) {
    return (
      <div className="screen play center">
        <p>Scanne le QR code affiché sur la TV pour rejoindre.</p>
      </div>
    );
  }

  if (!teamId) {
    return <JoinForm onJoin={join} error={error} room={room} />;
  }

  if (!state) {
    return <div className="screen play center"><p>Connexion…</p></div>;
  }

  return <PlayBody state={state} teamId={teamId} room={room} />;
}

function JoinForm({
  onJoin,
  error,
  room,
}: {
  onJoin: (name: string, avatar: string) => void;
  error: string | null;
  room: string;
}) {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(TEAM_AVATARS[0]);
  return (
    <div className="screen play join">
      <h1 className="play-logo">ArmaBarGames</h1>
      <p className="muted">Room {room}</p>
      <label className="field-label">Nom de l'équipe</label>
      <input
        className="text-input"
        placeholder="Les Bg du fond"
        value={name}
        maxLength={20}
        onChange={(e) => setName(e.target.value)}
      />
      <label className="field-label">Avatar</label>
      <div className="avatar-picker">
        {TEAM_AVATARS.map((a) => (
          <button
            key={a}
            className={`avatar-option ${a === avatar ? "selected" : ""}`}
            onClick={() => setAvatar(a)}
          >
            {a}
          </button>
        ))}
      </div>
      {error && <p className="error-text">{error}</p>}
      <button
        className="btn big"
        disabled={!name.trim()}
        onClick={() => onJoin(name.trim(), avatar)}
      >
        Rejoindre 🎉
      </button>
    </div>
  );
}

function PlayBody({
  state,
  teamId,
  room,
}: {
  state: GameState;
  teamId: string;
  room: string;
}) {
  const me = state.teams.find((t) => t.id === teamId);
  const rank =
    [...state.teams].sort((a, b) => b.score - a.score).findIndex((t) => t.id === teamId) + 1;

  return (
    <div className="screen play">
      <div className="play-header">
        <span className="play-avatar">{me?.avatar}</span>
        <span className="play-name">{me?.name}</span>
        <span className="play-score">{me?.score ?? 0} pts</span>
      </div>
      {state.paused && <div className="pause-banner small">⏸ En pause</div>}

      {state.phase === "lobby" && (
        <div className="center grow">
          <p className="big-emoji">🍻</p>
          <p>Tu es dans la partie ! En attente du lancement…</p>
        </div>
      )}

      {state.phase === "theme_voting" && <VotePanel state={state} />}

      {(state.phase === "question" || state.phase === "reveal") && (
        <AnswerPanel state={state} teamId={teamId} />
      )}

      {state.phase === "finished" && (
        <div className="center grow">
          <p className="big-emoji">{rank === 1 ? "🥇" : rank <= 3 ? "🏅" : "🎉"}</p>
          <h2>{rank}ᵉ place</h2>
          <p>{me?.score} points</p>
        </div>
      )}
    </div>
  );
}

function VotePanel({ state }: { state: GameState }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  const voting = !!state.voteEndsAt;

  const toggle = (id: string) => {
    setPicked((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length < VOTES_PER_TEAM
          ? [...prev, id]
          : prev
    );
  };

  const submit = () => {
    socket.emit(C2S.TeamVote, { themeIds: picked });
    setSent(true);
  };

  if (!voting) {
    return (
      <div className="center grow">
        <p className="big-emoji">✅</p>
        <p>Vote terminé ! Regarde la TV pour les thèmes retenus.</p>
      </div>
    );
  }

  return (
    <div className="vote-panel">
      <p className="vote-instruction">
        Choisis jusqu'à {VOTES_PER_TEAM} thèmes ({picked.length}/{VOTES_PER_TEAM})
      </p>
      <div className="vote-list">
        {state.themes.map((t) => (
          <button
            key={t.id}
            className={`vote-item ${picked.includes(t.id) ? "picked" : ""}`}
            onClick={() => toggle(t.id)}
            disabled={sent}
          >
            <span className="vote-emoji">{t.emoji}</span>
            {t.name}
          </button>
        ))}
      </div>
      <button className="btn big" disabled={picked.length === 0 || sent} onClick={submit}>
        {sent ? "Vote envoyé ✅ (modifiable)" : "Valider mon vote"}
      </button>
      {sent && (
        <button className="btn ghost" onClick={() => setSent(false)}>
          Modifier
        </button>
      )}
    </div>
  );
}

const OPTION_LETTERS = ["A", "B", "C", "D"];

function AnswerPanel({ state, teamId }: { state: GameState; teamId: string }) {
  const q = state.question;
  const [choice, setChoice] = useState<string | null>(null);

  // Reinitialise le choix a chaque nouvelle question.
  useEffect(() => {
    setChoice(null);
  }, [q?.id]);

  if (!q) return null;
  const revealing = state.phase === "reveal";
  const correctId = state.reveal?.correctOptionId;
  const gain = state.reveal?.gains[teamId] ?? 0;
  const answered = state.answeredTeamIds.includes(teamId) || choice !== null;

  const pick = (optId: string) => {
    if (answered || revealing) return;
    setChoice(optId);
    socket.emit(C2S.TeamAnswer, { questionId: q.id, optionId: optId });
  };

  return (
    <div className="answer-panel">
      {revealing && (
        <div className={`reveal-banner ${gain > 0 ? "good" : "bad"}`}>
          {gain > 0 ? `+${gain} points ! 🎉` : choice ? "Raté 😅" : "Pas de réponse"}
        </div>
      )}
      <div className="answer-buttons">
        {q.options.map((opt, i) => {
          const isMine = choice === opt.id;
          const isCorrect = correctId === opt.id;
          let cls = "answer-btn";
          if (revealing) {
            if (isCorrect) cls += " correct";
            else if (isMine) cls += " wrong";
            else cls += " dimmed";
          } else if (isMine) {
            cls += " picked";
          }
          return (
            <button
              key={opt.id}
              className={cls}
              disabled={answered || revealing}
              onClick={() => pick(opt.id)}
            >
              <span className="answer-btn-letter">{OPTION_LETTERS[i]}</span>
              {opt.label}
            </button>
          );
        })}
      </div>
      {!revealing && answered && (
        <p className="locked-note">Réponse verrouillée 🔒 — regarde la TV !</p>
      )}
    </div>
  );
}
