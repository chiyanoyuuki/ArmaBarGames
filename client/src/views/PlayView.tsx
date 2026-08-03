import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  C2S,
  CHAT_MAX_LENGTH,
  TEAM_AVATARS,
  type GameState,
  type TeamJoinAck,
  type TeamProfile,
} from "@armabar/shared";
import { emitAck, socket } from "../socket";
import { useGameState, useCountdown } from "../hooks";
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
  const [profile, setProfile] = useState<TeamProfile | null>(null);

  const fetchProfile = (name: string) => {
    fetch(`/api/team?name=${encodeURIComponent(name)}`)
      .then((r) => r.json())
      .then((p) => setProfile(p))
      .catch(() => {});
  };

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
        if (res.ok && res.data) {
          setTeamId(res.data.teamId);
          fetchProfile(name);
        }
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
      fetchProfile(name);
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

  return <PlayBody state={state} teamId={teamId} room={room} profile={profile} />;
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
  profile,
}: {
  state: GameState;
  teamId: string;
  room: string;
  profile: TeamProfile | null;
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
          {profile && profile.games > 0 ? (
            <div className="welcome-back">
              <p className="big-emoji">⭐</p>
              <h2>Bon retour !</h2>
              <p className="muted">Ravis de vous revoir, {me?.name}.</p>
              <div className="wb-stats">
                <div><b>{profile.games}</b><span>parties</span></div>
                <div><b>{profile.wins}</b><span>victoires</span></div>
                <div><b>{profile.bestScore}</b><span>record</span></div>
              </div>
              {profile.recent[0] && (
                <p className="muted">
                  Dernière fois : {profile.recent[0].rank}ᵉ sur {profile.recent[0].teamsCount}
                </p>
              )}
            </div>
          ) : (
            <>
              <p className="big-emoji">🍻</p>
              <p>Tu es dans la partie ! En attente du lancement…</p>
            </>
          )}
        </div>
      )}

      {state.phase === "theme_voting" && <VotePanel key="theme" state={state} />}
      {state.phase === "universe_voting" && <VotePanel key="universe" state={state} universe />}

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

      <ChatBar state={state} teamId={teamId} />
    </div>
  );
}

function ChatBar({ state, teamId }: { state: GameState; teamId: string }) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t) return;
    socket.emit(C2S.TeamChat, { text: t });
    setText("");
  };
  // Dernier message envoyé par cette équipe (simple accusé de réception ;
  // le fil complet ne s'affiche que sur la TV, pour éviter toute triche).
  const mine = [...(state.chat ?? [])].reverse().find((m) => m.teamId === teamId);
  return (
    <div className="chat-bar">
      {mine && <p className="chat-bar-last">💬 « {mine.text} » · sur la TV</p>}
      <div className="chat-bar-row">
        <input
          className="chat-bar-input"
          value={text}
          maxLength={CHAT_MAX_LENGTH}
          placeholder="Un mot sur la TV…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
        />
        <button className="btn small" onClick={send} disabled={!text.trim()}>
          Envoyer
        </button>
      </div>
    </div>
  );
}

function VotePanel({ state, universe }: { state: GameState; universe?: boolean }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  const voting = !!state.voteEndsAt;
  const maxVotes = state.config.votesPerTeam;
  const items = universe ? state.universeOptions : state.themes;
  const noun = universe ? "univers" : "thèmes";

  const toggle = (id: string) => {
    setPicked((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length < maxVotes
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
        <p>Vote terminé ! Regarde la TV pour les {noun} retenus.</p>
      </div>
    );
  }

  return (
    <div className="vote-panel">
      <p className="vote-instruction">
        Choisis jusqu'à {maxVotes} {noun} ({picked.length}/{maxVotes})
      </p>
      <div className="vote-list">
        {items.map((t) => (
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
  if (!q) return null;
  switch (q.type) {
    case "buzzer":
      return <BuzzerPanel state={state} teamId={teamId} />;
    case "open":
      return <OpenPanel state={state} teamId={teamId} />;
    case "estimation":
      return <EstimationPanel state={state} teamId={teamId} />;
    case "ordre":
      return <OrdrePanel state={state} teamId={teamId} />;
    default:
      return <QcmPanel state={state} teamId={teamId} />;
  }
}

function RevealBanner({ gain, missed }: { gain: number; missed: boolean }) {
  return (
    <div className={`reveal-banner ${gain > 0 ? "good" : "bad"}`}>
      {gain > 0 ? `+${gain} points ! 🎉` : missed ? "Raté 😅" : "Pas de réponse"}
    </div>
  );
}

function QcmPanel({ state, teamId }: { state: GameState; teamId: string }) {
  const q = state.question!;
  const [choice, setChoice] = useState<string | null>(null);
  useEffect(() => setChoice(null), [q.id]);

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
      {revealing && <RevealBanner gain={gain} missed={choice !== null} />}
      <div className="answer-buttons">
        {(q.options ?? []).map((opt, i) => {
          const isMine = choice === opt.id;
          const isCorrect = correctId === opt.id;
          let cls = "answer-btn";
          if (revealing) cls += isCorrect ? " correct" : isMine ? " wrong" : " dimmed";
          else if (isMine) cls += " picked";
          return (
            <button key={opt.id} className={cls} disabled={answered || revealing} onClick={() => pick(opt.id)}>
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

function BuzzerPanel({ state, teamId }: { state: GameState; teamId: string }) {
  const revealing = state.phase === "reveal";
  const gain = state.reveal?.gains[teamId] ?? 0;
  const buzz = state.buzz;

  // Pénalité de temps après un mauvais buzz : compte à rebours local qui
  // réactive le bouton une fois écoulé (le serveur n'émet pas à l'expiration).
  const penaltyEnd = buzz?.penalties?.[teamId];
  const penaltyRemaining = useCountdown(
    penaltyEnd && penaltyEnd > Date.now() ? penaltyEnd : undefined,
    false
  );
  const penalized = penaltyRemaining > 0;

  if (revealing) {
    return (
      <div className="answer-panel">
        <RevealBanner gain={gain} missed={false} />
        {state.reveal?.correctAnswer && (
          <p className="reveal-answer">Réponse : <strong>{state.reveal.correctAnswer}</strong></p>
        )}
      </div>
    );
  }

  const iAmCurrent = buzz?.current === teamId;
  const someoneElse = buzz?.current && buzz.current !== teamId;
  const currentTeam = state.teams.find((t) => t.id === buzz?.current);

  if (iAmCurrent) {
    return (
      <div className="answer-panel center grow">
        <p className="big-emoji">🎤</p>
        <h2>À toi de répondre !</h2>
        <p className="muted">Réponds à voix haute, l'animateur valide.</p>
      </div>
    );
  }
  if (someoneElse) {
    return (
      <div className="answer-panel center grow">
        <p className="big-emoji">🔔</p>
        <p><strong>{currentTeam?.name}</strong> a buzzé…</p>
      </div>
    );
  }
  if (penalized) {
    return (
      <div className="answer-panel center grow">
        <p className="big-emoji">⏳</p>
        <p>Mauvaise réponse… pénalité !</p>
        <p className="penalty-count">{Math.ceil(penaltyRemaining / 1000)} s</p>
        <p className="muted">Tu pourras rebuzzer ensuite.</p>
      </div>
    );
  }
  return (
    <div className="answer-panel center grow">
      <button className="buzz-button" onClick={() => socket.emit(C2S.TeamBuzz, {})}>
        BUZZ
      </button>
      <p className="muted">Sois le premier à buzzer !</p>
    </div>
  );
}

function OpenPanel({ state, teamId }: { state: GameState; teamId: string }) {
  const q = state.question!;
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  useEffect(() => { setText(""); setSent(false); }, [q.id]);

  const revealing = state.phase === "reveal";
  const gain = state.reveal?.gains[teamId] ?? 0;
  const sub = state.reveal?.submissions?.find((s) => s.teamId === teamId);
  const answered = sent || state.answeredTeamIds.includes(teamId);

  const submit = () => {
    if (!text.trim() || answered) return;
    socket.emit(C2S.TeamSubmit, { questionId: q.id, text: text.trim() });
    setSent(true);
  };

  if (revealing) {
    return (
      <div className="answer-panel">
        <RevealBanner gain={gain} missed={!!sub} />
        <p className="reveal-answer">Bonne réponse : <strong>{state.reveal?.correctAnswer}</strong></p>
        {sub?.text != null && <p className="muted">Ta réponse : « {sub.text || "—"} » {sub.correct ? "✅" : "❌"}</p>}
      </div>
    );
  }
  return (
    <div className="answer-panel">
      <label className="field-label">Ta réponse</label>
      <input className="text-input" value={text} disabled={answered}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Tape ta réponse…" />
      <button className="btn big" disabled={!text.trim() || answered} onClick={submit}>
        {answered ? "Réponse envoyée ✅" : "Valider"}
      </button>
      {answered && <p className="locked-note">Verrouillé 🔒 — regarde la TV !</p>}
    </div>
  );
}

function EstimationPanel({ state, teamId }: { state: GameState; teamId: string }) {
  const q = state.question!;
  const [val, setVal] = useState("");
  const [sent, setSent] = useState(false);
  useEffect(() => { setVal(""); setSent(false); }, [q.id]);

  const revealing = state.phase === "reveal";
  const gain = state.reveal?.gains[teamId] ?? 0;
  const sub = state.reveal?.submissions?.find((s) => s.teamId === teamId);
  const answered = sent || state.answeredTeamIds.includes(teamId);

  const submit = () => {
    if (val === "" || answered) return;
    socket.emit(C2S.TeamSubmit, { questionId: q.id, value: Number(val) });
    setSent(true);
  };

  if (revealing) {
    return (
      <div className="answer-panel">
        <RevealBanner gain={gain} missed={!!sub} />
        <p className="reveal-answer">Réponse exacte : <strong>{state.reveal?.correctAnswer}</strong></p>
        {sub && <p className="muted">Ton estimation : {sub.value} {sub.correct ? "🏆 la plus proche !" : ""}</p>}
      </div>
    );
  }
  return (
    <div className="answer-panel">
      <label className="field-label">Ton estimation {q.unit ? `(en ${q.unit})` : ""}</label>
      <input className="text-input" type="number" inputMode="numeric" value={val} disabled={answered}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Un nombre…" />
      <button className="btn big" disabled={val === "" || answered} onClick={submit}>
        {answered ? "Estimation envoyée ✅" : "Valider"}
      </button>
      {answered && <p className="locked-note">Le plus proche gagne 🎯</p>}
    </div>
  );
}

function OrdrePanel({ state, teamId }: { state: GameState; teamId: string }) {
  const q = state.question!;
  const [order, setOrder] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  useEffect(() => { setOrder([]); setSent(false); }, [q.id]);

  const revealing = state.phase === "reveal";
  const gain = state.reveal?.gains[teamId] ?? 0;
  const answered = sent || state.answeredTeamIds.includes(teamId);
  const items = q.items ?? [];

  const tap = (id: string) => {
    if (answered) return;
    setOrder((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const submit = () => {
    if (order.length !== items.length || answered) return;
    socket.emit(C2S.TeamSubmit, { questionId: q.id, orderIds: order });
    setSent(true);
  };

  if (revealing) {
    const correct = state.reveal?.correctOrder ?? [];
    return (
      <div className="answer-panel">
        <RevealBanner gain={gain} missed={order.length > 0} />
        <p className="reveal-answer">Bon ordre :</p>
        <ol className="ordre-correct">
          {correct.map((it) => <li key={it.id}>{it.label}</li>)}
        </ol>
      </div>
    );
  }
  return (
    <div className="answer-panel">
      <p className="vote-instruction">Tape les éléments dans le bon ordre</p>
      <div className="ordre-list">
        {items.map((it) => {
          const pos = order.indexOf(it.id);
          return (
            <button key={it.id} className={`ordre-item ${pos >= 0 ? "picked" : ""}`} disabled={answered} onClick={() => tap(it.id)}>
              {pos >= 0 && <span className="ordre-badge">{pos + 1}</span>}
              {it.label}
            </button>
          );
        })}
      </div>
      <button className="btn big" disabled={order.length !== items.length || answered} onClick={submit}>
        {answered ? "Ordre envoyé ✅" : "Valider l'ordre"}
      </button>
      {!answered && order.length > 0 && (
        <button className="btn ghost" onClick={() => setOrder([])}>Recommencer</button>
      )}
    </div>
  );
}
