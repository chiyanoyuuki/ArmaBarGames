import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  C2S,
  type CreateRoomAck,
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
          </>
        )}

        {state.phase === "theme_voting" && (
          <>
            <p className="muted">{state.totalVoters} équipe(s) ont voté</p>
            <button className="btn big" onClick={() => send(C2S.HostStartGame)}>
              ▶️ Lancer la partie avec les thèmes en tête
            </button>
          </>
        )}

        {(state.phase === "question" || state.phase === "reveal") && (
          <>
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
        <h3>Équipes ({state.teams.length})</h3>
        {state.teams.length === 0 && (
          <p className="muted">Les équipes rejoignent via le QR de la TV.</p>
        )}
        {[...state.teams]
          .sort((a, b) => b.score - a.score)
          .map((t) => (
            <div key={t.id} className={`host-team-row ${t.connected ? "" : "off"}`}>
              <span className="host-team-avatar">{t.avatar}</span>
              <span className="host-team-name">{t.name}</span>
              <span className="host-team-score">{t.score}</span>
              <div className="host-team-actions">
                <button onClick={() => send(C2S.HostAdjustScore, { teamId: t.id, delta: -50 })}>−</button>
                <button onClick={() => send(C2S.HostAdjustScore, { teamId: t.id, delta: 50 })}>+</button>
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
    </div>
  );
}

function phaseLabel(phase: GameState["phase"]): string {
  const labels: Record<GameState["phase"], string> = {
    lobby: "Salon",
    theme_voting: "Vote",
    question: "Question",
    reveal: "Réponse",
    leaderboard: "Classement",
    finished: "Terminé",
  };
  return labels[phase] ?? phase;
}
