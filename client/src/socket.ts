import { io, type Socket } from "socket.io-client";
import { S2C, type AckResult, type GameState } from "@armabar/shared";

// Connexion unique, meme origine. En dev, Vite proxifie /socket.io -> :3001.
export const socket: Socket = io({ autoConnect: true });

/** Emet un evenement et resout avec l'accuse de reception du serveur. */
export function emitAck<T = unknown>(
  event: string,
  payload: unknown
): Promise<AckResult<T>> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res: AckResult<T>) => resolve(res));
  });
}

export function onState(cb: (s: GameState) => void): () => void {
  socket.on(S2C.State, cb);
  return () => socket.off(S2C.State, cb);
}
