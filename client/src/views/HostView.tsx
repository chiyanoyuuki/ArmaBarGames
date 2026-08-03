import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  C2S,
  CONFIG_LIMITS,
  type CreateRoomAck,
  type GameConfig,
  type GameState,
} from "@armabar/shared";
import { emitAck, socket } from "../socket";
import { useGameState } from "../hooks";

function tokenKey(room: string) {
  return `armabar:host:${room}`;
}

export function HostView() {
  const [params, setParams] = useSearchParams();
  const room = (params.get("room") ?? "").toUpperCase();
  const [token, setToken] = useState<string | null>(null);
  const state = useGameState();
  const [error, setError] = useState<string | null>(null);

  // Charge le jeton host et (re)connecte a la room.
  useEffect(() => {
    if (!room) return;
    const saved = localStorage.getItem(tokenKey(room));
    if (!saved) {
      setError("Aucun jeton animateur pour cette room sur cet appareil.");
      return;
    }
    setToken(saved);
    const doJoin = () =>
      emitAck(C2S.HostJoin, { roomCode: room, hostToken: saved }).then((res) => {
        if (!res.ok) setError(res.error ?? "Connexion impossible");
      });
    doJoin();
    socket.on("connect", doJoin);
    return () => {
      socket.off("connect", doJoin);
    };
  }, [room]);

  const createRoom = async () => {
    const res = await emitAck<CreateRoomAck>(C2S.CreateRoom, {});
    if (res.ok && res.data) {
      localStorage.setItem(tokenKey(res.data.roomCode), res.data.hostToken);
      setToken(res.data.hostToken);
      setParams({ room: res.data.roomCode });
    }
  };

  if (!room) {
    return (
      <div className="screen host center">
        <h1 className="play-logo">Animateur 🎛️</h1>
        <p className="muted">Crée une partie, puis ouvre la TV et partage le QR.</p>
        <button className="btn big" onClick={createRoom}>
          Créer une partie
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="screen host center">
        <p>⚠️ {error}</p>
        <button className="btn" onClick={createRoom}>Créer une nouvelle partie</button>
      </div>
    );
  }

  if (!state || !token) {
    return <div className="screen host center"><p>Connexion…</p></div>;
  }

  return <HostConsole state={state} room={room} token={token} />;
}

function HostConsole({
  state,
  room,
  token,
}: {
  state: GameState;
  room: string;
  token: string;
}) {
  const auth = { roomCode: room, hostToken: token };
  const send = (event: string, extra: Record<string, unknown> = {}) =>
    socket.emit(event, { ...auth, ...extra });

  const tvUrl = `${window.location.origin}/tv?room=${room}`;

  return (
    <div className="screen host">
      <div className="host-topbar">
        <div>
          <span className="host-room-label">Room</span>{" "}
          <span className="host-room-code">{room}</span>
        </div>
        <span className={`host-phase phase-${state.phase}`}>{phaseLabel(state.phase)}</span>
      </div>

      <div className="host-tvlink">
        📺 TV :{" "}
        <a href={tvUrl} target="_blank" rel="noreferrer">
          {tvUrl}
        </a>
        <button
          className="btn tiny"
          onClick={() => navigator.clipboard?.writeText(tvUrl)}
        >
          Copier
        </button>
      </div>

      {/* Contrôles principaux selon la phase */}
      <div className="host-controls">
        {state.phase === "lobby" && (
          <>
            <button
              className="btn big"
              disabled={state.teams.length === 0}
              onClick={() => send(C2S.HostStartVoting)}
            >
              🗳️ Lancer le vote des thèmes
            </button>
            <button
              className="btn ghost"
              disabled={state.teams.length === 0}
              onClick={() => send(C2S.HostStartGame)}
            >
              ▶️ Lancer sans vote (thèmes populaires)
            </button>
            <ConfigPanel state={state} send={send} />
          </>
        )}

        {state.phase === "theme_voting" && (
          <>
            <p className="muted">{state.totalVoters} équipe(s) ont voté</p>
            <button
              className="btn big"
              disabled={state.selectedThemeIds.length === 0}
              onClick={() => send(C2S.HostStartUniverseVoting)}
            >
              🎯 Vote des univers (dans les thèmes en tête)
            </button>
            <button className="btn ghost" onClick={() => send(C2S.HostStartGame)}>
              ▶️ Lancer directement (tous les univers des thèmes)
            </button>
          </>
        )}

        {state.phase === "universe_voting" && (
          <>
            <p className="muted">{state.totalVoters} équipe(s) ont voté</p>
            <button className="btn big" onClick={() => send(C2S.HostStartGame)}>
              ▶️ Lancer la partie avec les univers en tête
            </button>
          </>
        )}

        {(state.phase === "question" || state.phase === "reveal") && (
          <>
            <BuzzerControls state={state} send={send} />
            <GradePanel state={state} send={send} />
            <button className="btn big" onClick={() => send(C2S.HostNext)}>
              {state.phase === "question" ? "⏭️ Révéler la réponse" : "⏭️ Question suivante"}
            </button>
            {state.paused ? (
              <button className="btn" onClick={() => send(C2S.HostResume)}>
                ▶️ Reprendre
              </button>
            ) : (
              <button className="btn" onClick={() => send(C2S.HostPause)}>
                ⏸ Pause
              </button>
            )}
          </>
        )}

        {state.phase === "round_intro" && (
          <button className="btn big" onClick={() => send(C2S.HostNext)}>
            ⏭️ Démarrer la manche
          </button>
        )}

        {state.phase === "leaderboard" && (
          <button className="btn big" onClick={() => send(C2S.HostNext)}>
            ⏭️ Continuer
          </button>
        )}

        {state.phase === "finished" && (
          <button className="btn big" onClick={() => send(C2S.HostStartVoting)}>
            🔁 Nouvelle manche (revote)
          </button>
        )}
      </div>

      {(state.phase === "question" || state.phase === "reveal") && (
        <button className="btn danger ghost" onClick={() => send(C2S.HostEndGame)}>
          Terminer la partie
        </button>
      )}

      {/* Gestion des équipes */}
      <div className="host-teams">
        <div className="host-teams-head">
          <h3>Équipes ({state.teams.length})</h3>
          <button
            className={`btn tiny ${state.chatEnabled ? "" : "ghost"}`}
            onClick={() => send(C2S.HostSetChat, { enabled: !state.chatEnabled })}
            title="Activer/désactiver le chat des équipes"
          >
            {state.chatEnabled ? "💬 Chat ON" : "🚫 Chat OFF"}
          </button>
        </div>
        {state.teams.length === 0 && (
          <p className="muted">Les équipes rejoignent via le QR de la TV.</p>
        )}
        {[...state.teams]
          .sort((a, b) => b.score - a.score)
          .map((t) => (
            <div key={t.id} className={`host-team-row ${t.connected ? "" : "off"}`}>
              <span className="host-team-avatar">{t.avatar}</span>
              <span className="host-team-name" style={{ color: t.color }}>
                {t.name}{t.returning ? " ⭐" : ""}{t.muted ? " 🔇" : ""}
              </span>
              <span className="host-team-score">{t.score}</span>
              <div className="host-team-actions">
                <button onClick={() => send(C2S.HostAdjustScore, { teamId: t.id, delta: -50 })}>−</button>
                <button onClick={() => send(C2S.HostAdjustScore, { teamId: t.id, delta: 50 })}>+</button>
                <button
                  onClick={() => send(C2S.HostMuteTeam, { teamId: t.id, muted: !t.muted })}
                  title={t.muted ? "Réautoriser le chat" : "Mettre en sourdine"}
                >
                  {t.muted ? "🔈" : "🔇"}
                </button>
                <button
                  onClick={() => {
                    const name = prompt("Nouveau nom :", t.name);
                    if (name) send(C2S.HostRenameTeam, { teamId: t.id, name });
                  }}
                >
                  ✏️
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Retirer ${t.name} ?`))
                      send(C2S.HostRemoveTeam, { teamId: t.id });
                  }}
                >
                  🗑️
                </button>
              </div>
            </div>
          ))}
      </div>

      <MusicBar state={state} send={send} />
    </div>
  );
}

type SendFn = (event: string, extra?: Record<string, unknown>) => void;

function MusicBar({ state, send }: { state: GameState; send: SendFn }) {
  const on = state.music.on;
  const track = state.music.track;
  const [tracks, setTracks] = useState<{ file: string; title: string }[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const refresh = () => {
    fetch("/api/music")
      .then((r) => r.json())
      .then((list) => setTracks(Array.isArray(list) ? list : []))
      .catch(() => setTracks([]));
  };
  useEffect(refresh, []);

  const current = tracks.find((t) => t.file === track);
  const hasFiles = tracks.length > 0;
  const label = !on
    ? "Musique coupée"
    : current
      ? current.title
      : hasFiles
        ? "…"
        : "Nappe d'ambiance";

  return (
    <div className="music-bar">
      <button
        className={`music-toggle ${on ? "on" : ""}`}
        onClick={() => send(C2S.HostMusic, { on: !on })}
        title="Musique d'ambiance (TV)"
      >
        {on ? "🎵" : "🔇"}
      </button>
      <button
        className="music-next"
        onClick={() => send(C2S.HostMusic, { next: true })}
        disabled={!on || !hasFiles}
        title="Morceau suivant"
      >
        ⏭
      </button>
      <button
        className={`music-pick ${pickerOpen ? "open" : ""}`}
        onClick={() => {
          if (!pickerOpen) refresh();
          setPickerOpen((v) => !v);
        }}
        title="Choisir un morceau"
      >
        <span className="music-label">{label}</span>
        <span className="music-caret">▾</span>
      </button>
      <input
        className="music-volume"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={state.music.volume}
        disabled={!on}
        onChange={(e) => send(C2S.HostMusic, { volume: Number(e.target.value) })}
      />
      <span className="music-pct">{on ? `${Math.round(state.music.volume * 100)}%` : "🔇"}</span>

      {pickerOpen && (
        <div className="music-picker">
          <div className="music-picker-head">
            <span>Playlist ({tracks.length})</span>
            <button className="music-picker-refresh" onClick={refresh} title="Rafraîchir">
              ↻
            </button>
          </div>
          {tracks.length === 0 ? (
            <p className="music-picker-empty">
              Dépose des .mp3 dans <code>data/music/</code>
            </p>
          ) : (
            <ul className="music-picker-list">
              {tracks.map((t) => (
                <li
                  key={t.file}
                  className={t.file === track ? "active" : ""}
                  onClick={() => {
                    send(C2S.HostMusic, { track: t.file, on: true });
                    setPickerOpen(false);
                  }}
                >
                  {t.file === track ? "▶ " : ""}
                  {t.title}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ConfigPanel({ state, send }: { state: GameState; send: SendFn }) {
  const cfg = state.config;
  const setCfg = (patch: Partial<GameConfig>) =>
    send(C2S.HostConfigure, { config: patch });

  return (
    <details className="config-panel" open>
      <summary>⚙️ Configuration de la partie</summary>
      <div className="config-body">
        <ConfigSlider
          label="Temps par question"
          value={cfg.questionTimeMs}
          limits={CONFIG_LIMITS.questionTimeMs}
          format={(v) => `${Math.round(v / 1000)} s`}
          onChange={(v) => setCfg({ questionTimeMs: v })}
        />
        <ConfigSlider
          label="Durée de la réponse (reveal)"
          value={cfg.revealTimeMs}
          limits={CONFIG_LIMITS.revealTimeMs}
          format={(v) => `${Math.round(v / 1000)} s`}
          onChange={(v) => setCfg({ revealTimeMs: v })}
        />
        <ConfigSlider
          label="Durée du vote des thèmes"
          value={cfg.voteTimeMs}
          limits={CONFIG_LIMITS.voteTimeMs}
          format={(v) => `${Math.round(v / 1000)} s`}
          onChange={(v) => setCfg({ voteTimeMs: v })}
        />
        <ConfigSlider
          label="Nombre de questions"
          value={cfg.totalRounds}
          limits={CONFIG_LIMITS.totalRounds}
          format={(v) => `${v}`}
          onChange={(v) => setCfg({ totalRounds: v })}
        />
        <ConfigSlider
          label="Thèmes retenus après le vote"
          value={cfg.selectedThemeCount}
          limits={CONFIG_LIMITS.selectedThemeCount}
          format={(v) => `${v}`}
          onChange={(v) => setCfg({ selectedThemeCount: v })}
        />
        <ConfigSlider
          label="Univers retenus (2e vote)"
          value={cfg.selectedUniverseCount}
          limits={CONFIG_LIMITS.selectedUniverseCount}
          format={(v) => `${v}`}
          onChange={(v) => setCfg({ selectedUniverseCount: v })}
        />
        <ConfigSlider
          label="Votes par équipe"
          value={cfg.votesPerTeam}
          limits={CONFIG_LIMITS.votesPerTeam}
          format={(v) => `${v}`}
          onChange={(v) => setCfg({ votesPerTeam: v })}
        />
        <ConfigSlider
          label="Classement intermédiaire toutes les…"
          value={cfg.leaderboardEvery}
          limits={CONFIG_LIMITS.leaderboardEvery}
          format={(v) => (v === 0 ? "jamais" : `${v} questions`)}
          onChange={(v) => setCfg({ leaderboardEvery: v })}
        />
        <ConfigSlider
          label="Durée du classement"
          value={cfg.leaderboardTimeMs}
          limits={CONFIG_LIMITS.leaderboardTimeMs}
          format={(v) => `${Math.round(v / 1000)} s`}
          onChange={(v) => setCfg({ leaderboardTimeMs: v })}
        />
        <ConfigSlider
          label="Annonce de manche"
          value={cfg.roundIntroMs}
          limits={CONFIG_LIMITS.roundIntroMs}
          format={(v) => (v === 0 ? "désactivée" : `${(v / 1000).toFixed(1)} s`)}
          onChange={(v) => setCfg({ roundIntroMs: v })}
        />
        <label className="config-toggle">
          <span>Bonus de série (+10 %/bonne réponse)</span>
          <input
            type="checkbox"
            checked={cfg.streakBonus}
            onChange={(e) => setCfg({ streakBonus: e.target.checked })}
          />
        </label>
        <label className="config-toggle">
          <span>Difficulté adaptative (monte/descend selon les scores)</span>
          <input
            type="checkbox"
            checked={cfg.adaptiveDifficulty}
            onChange={(e) => setCfg({ adaptiveDifficulty: e.target.checked })}
          />
        </label>
      </div>
    </details>
  );
}

function ConfigSlider({
  label,
  value,
  limits,
  format,
  onChange,
}: {
  label: string;
  value: number;
  limits: { min: number; max: number; step: number };
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="config-row">
      <div className="config-row-head">
        <span>{label}</span>
        <span className="config-value">{format(value)}</span>
      </div>
      <input
        type="range"
        min={limits.min}
        max={limits.max}
        step={limits.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function BuzzerControls({ state, send }: { state: GameState; send: SendFn }) {
  if (state.phase !== "question" || state.question?.type !== "buzzer") return null;
  const buzz = state.buzz;
  const current = state.teams.find((t) => t.id === buzz?.current);
  if (!current) {
    return <p className="muted">🔔 En attente d'un buzz…</p>;
  }
  return (
    <div className="buzzer-verdict">
      <p><strong>{current.avatar} {current.name}</strong> a buzzé :</p>
      <div className="buzzer-verdict-btns">
        <button className="btn" onClick={() => send(C2S.HostBuzzVerdict, { correct: true })}>
          ✓ Correct
        </button>
        <button className="btn danger" onClick={() => send(C2S.HostBuzzVerdict, { correct: false })}>
          ✗ Faux
        </button>
      </div>
    </div>
  );
}

function GradePanel({ state, send }: { state: GameState; send: SendFn }) {
  if (state.phase !== "reveal" || state.reveal?.type !== "open") return null;
  const subs = state.reveal.submissions ?? [];
  if (subs.length === 0) return null;
  return (
    <div className="grade-panel">
      <p className="muted">Valide les réponses écrites (auto-corrigées) :</p>
      {subs.map((s) => {
        const team = state.teams.find((t) => t.id === s.teamId);
        return (
          <div key={s.teamId} className="grade-row">
            <span className="grade-team">{team?.avatar} {team?.name}</span>
            <span className="grade-text">« {s.text || "—"} »</span>
            <div className="grade-btns">
              <button
                className={`grade-yes ${s.correct ? "on" : ""}`}
                onClick={() => send(C2S.HostGradeAnswer, { teamId: s.teamId, correct: true })}
              >
                Oui
              </button>
              <button
                className={`grade-no ${!s.correct ? "on" : ""}`}
                onClick={() => send(C2S.HostGradeAnswer, { teamId: s.teamId, correct: false })}
              >
                Non
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function phaseLabel(phase: GameState["phase"]): string {
  const labels: Record<GameState["phase"], string> = {
    lobby: "Salon",
    theme_voting: "Vote thèmes",
    universe_voting: "Vote univers",
    round_intro: "Manche",
    question: "Question",
    reveal: "Réponse",
    leaderboard: "Classement",
    finished: "Terminé",
  };
  return labels[phase] ?? phase;
}
