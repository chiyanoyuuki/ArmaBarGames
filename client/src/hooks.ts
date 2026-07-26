import { useEffect, useState } from "react";
import { type GameState } from "@armabar/shared";
import { onState, socket } from "./socket";
import { playSfx } from "./sound";
import { S2C, type SfxKind } from "@armabar/shared";

/** Etat de jeu diffuse par le serveur. */
export function useGameState(): GameState | null {
  const [state, setState] = useState<GameState | null>(null);
  useEffect(() => onState(setState), []);
  return state;
}

/** Joue les effets sonores envoyes par le serveur (TV surtout). */
export function useSfx(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (kind: SfxKind) => playSfx(kind);
    socket.on(S2C.Sfx, handler);
    return () => {
      socket.off(S2C.Sfx, handler);
    };
  }, [enabled]);
}

/** Compte a rebours base sur une echeance serveur (epoch ms). Gele si pause. */
export function useCountdown(endsAt: number | undefined, paused: boolean) {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (!endsAt || paused) {
      if (endsAt && paused) setRemaining(Math.max(0, endsAt - Date.now()));
      return;
    }
    const tick = () => setRemaining(Math.max(0, endsAt - Date.now()));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [endsAt, paused]);
  return remaining;
}
