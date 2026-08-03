import express from "express";
import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  C2S,
  S2C,
  type AckResult,
  type CreateRoomPayload,
  type CreateRoomAck,
  type GameRecord,
  type GameState,
  type HostAdjustScorePayload,
  type HostAuthPayload,
  type HostBuzzVerdictPayload,
  type HostConfigurePayload,
  type HostGradeAnswerPayload,
  type HostMusicPayload,
  type HostRemoveTeamPayload,
  type HostRenameTeamPayload,
  type HostStartGamePayload,
  type JoinRoomPayload,
  type SfxKind,
  type TeamAnswerPayload,
  type TeamChatPayload,
  type TeamJoinAck,
  type TeamJoinPayload,
  type TeamSubmitPayload,
  type TeamVotePayload,
} from "@armabar/shared";
import { GameRoom } from "./game.js";
import { themes, universes } from "./data.js";
import { MUSIC_DIR, listMusic } from "./music.js";
import {
  computeStats,
  forgetQuestionsSeen,
  getSeenQuestions,
  knownTeamNames,
  loadGames,
  markQuestionsSeen,
  saveGame,
  teamProfile,
} from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;

// --- Gestion des rooms ----------------------------------------------------

const rooms = new Map<string, GameRoom>();

function makeBroadcaster(io: Server, code: string) {
  return {
    emitState(state: GameState) {
      io.to(code).emit(S2C.State, state);
    },
    sfx(kind: SfxKind) {
      io.to(code).emit(S2C.Sfx, kind);
    },
    archive(record: GameRecord) {
      saveGame(record);
    },
    getSeenQuestions() {
      return getSeenQuestions();
    },
    markQuestionsSeen(ids: string[]) {
      markQuestionsSeen(ids);
    },
    forgetQuestionsSeen(ids: string[]) {
      forgetQuestionsSeen(ids);
    },
  };
}

// --- Serveur HTTP + Socket.io ---------------------------------------------

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true },
});

app.get("/healthz", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// --- API archive / stats ---
app.get("/api/stats", (_req, res) => {
  res.json(computeStats(loadGames()));
});
app.get("/api/catalog", (_req, res) => {
  res.json({ themes, universes });
});
app.get("/api/team", (req, res) => {
  const name = String(req.query.name ?? "");
  res.json(teamProfile(name));
});
app.get("/api/history", (_req, res) => {
  // Parties les plus recentes en premier, sans le detail par question.
  const games = loadGames()
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, 50)
    .map(({ rounds, ...g }) => g);
  res.json(games);
});
// Playlist d'ambiance : liste des morceaux deposes dans data/music/.
app.get("/api/music", (_req, res) => {
  res.json(listMusic());
});
// Sert les fichiers audio deposes par l'animateur (joues sur la TV).
app.use("/music", express.static(MUSIC_DIR));

// Sert le build du client en production (single URL : TV + play + host).
const clientDist = join(__dirname, "..", "..", "client", "dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(join(clientDist, "index.html")));
}

function ok<T>(data?: T): AckResult<T> {
  return { ok: true, data };
}
function fail<T = unknown>(error: string): AckResult<T> {
  return { ok: false, error };
}

function requireHost(payload: HostAuthPayload): GameRoom | undefined {
  const room = rooms.get(payload.roomCode);
  if (!room || room.hostToken !== payload.hostToken) return undefined;
  return room;
}

type Ack<T = unknown> = (res: AckResult<T>) => void;

io.on("connection", (socket: Socket) => {
  // --- Host : creation / connexion ---
  socket.on(
    C2S.CreateRoom,
    (payload: CreateRoomPayload, ack?: Ack<CreateRoomAck>) => {
      const room = new GameRoom({ config: payload?.config });
      room.attach(makeBroadcaster(io, room.code));
      rooms.set(room.code, room);
      socket.join(room.code);
      socket.data.role = "host";
      socket.data.roomCode = room.code;
      ack?.(ok({ roomCode: room.code, hostToken: room.hostToken }));
      socket.emit(S2C.State, room.toState());
    }
  );

  socket.on(C2S.HostJoin, (payload: HostAuthPayload, ack?: Ack) => {
    const room = requireHost(payload);
    if (!room) return ack?.(fail("Room ou jeton invalide"));
    socket.join(room.code);
    socket.data.role = "host";
    socket.data.roomCode = room.code;
    ack?.(ok());
    socket.emit(S2C.State, room.toState());
  });

  // --- TV ---
  socket.on(C2S.TvJoin, (payload: JoinRoomPayload, ack?: Ack) => {
    const room = rooms.get(payload.roomCode);
    if (!room) return ack?.(fail("Room introuvable"));
    socket.join(room.code);
    socket.data.role = "tv";
    socket.data.roomCode = room.code;
    ack?.(ok());
    socket.emit(S2C.State, room.toState());
  });

  // --- Equipe ---
  socket.on(C2S.TeamJoin, (payload: TeamJoinPayload, ack?: Ack<TeamJoinAck>) => {
    const room = rooms.get(payload.roomCode);
    if (!room) return ack?.(fail("Room introuvable"));
    const team = room.addOrReconnectTeam({
      teamId: payload.teamId,
      name: payload.teamName,
      avatar: payload.avatar,
      returning: knownTeamNames().has(payload.teamName.trim().toLowerCase()),
    });
    socket.join(room.code);
    socket.data.role = "play";
    socket.data.roomCode = room.code;
    socket.data.teamId = team.id;
    ack?.(ok({ teamId: team.id }));
    socket.emit(S2C.State, room.toState());
  });

  socket.on(C2S.TeamVote, (payload: TeamVotePayload) => {
    const room = rooms.get(socket.data.roomCode);
    if (room && socket.data.teamId) {
      room.vote(socket.data.teamId, payload.themeIds);
    }
  });

  socket.on(C2S.TeamAnswer, (payload: TeamAnswerPayload) => {
    const room = rooms.get(socket.data.roomCode);
    if (room && socket.data.teamId) {
      room.answer(socket.data.teamId, payload.questionId, payload.optionId);
    }
  });

  socket.on(C2S.TeamSubmit, (payload: TeamSubmitPayload) => {
    const room = rooms.get(socket.data.roomCode);
    if (room && socket.data.teamId) {
      room.submit(socket.data.teamId, payload.questionId, {
        text: payload.text,
        value: payload.value,
        orderIds: payload.orderIds,
      });
    }
  });

  socket.on(C2S.TeamBuzz, () => {
    const room = rooms.get(socket.data.roomCode);
    if (room && socket.data.teamId) room.pressBuzz(socket.data.teamId);
  });

  socket.on(C2S.TeamChat, (payload: TeamChatPayload) => {
    const room = rooms.get(socket.data.roomCode);
    if (room && socket.data.teamId) room.postChat(socket.data.teamId, payload?.text ?? "");
  });

  // --- Actions host ---
  socket.on(C2S.HostConfigure, (payload: HostConfigurePayload) => {
    requireHost(payload)?.configure(payload.config);
  });
  socket.on(C2S.HostMusic, (payload: HostMusicPayload) => {
    requireHost(payload)?.setMusic({
      on: payload.on,
      volume: payload.volume,
      next: payload.next,
      track: payload.track,
    });
  });
  socket.on(C2S.TvTrackEnded, () => {
    const room = rooms.get(socket.data.roomCode);
    if (room && socket.data.role === "tv") room.advanceTrack();
  });
  socket.on(C2S.HostStartVoting, (payload: HostAuthPayload) => {
    requireHost(payload)?.startVoting();
  });
  socket.on(C2S.HostStartUniverseVoting, (payload: HostAuthPayload) => {
    requireHost(payload)?.startUniverseVoting();
  });
  socket.on(C2S.HostStartGame, (payload: HostStartGamePayload) => {
    requireHost(payload)?.startGame(payload.selectedThemeIds);
  });
  socket.on(C2S.HostNext, (payload: HostAuthPayload) => {
    requireHost(payload)?.next();
  });
  socket.on(C2S.HostBuzzVerdict, (payload: HostBuzzVerdictPayload) => {
    requireHost(payload)?.buzzVerdict(payload.correct);
  });
  socket.on(C2S.HostGradeAnswer, (payload: HostGradeAnswerPayload) => {
    requireHost(payload)?.gradeAnswer(payload.teamId, payload.correct);
  });
  socket.on(C2S.HostPause, (payload: HostAuthPayload) => {
    requireHost(payload)?.pause();
  });
  socket.on(C2S.HostResume, (payload: HostAuthPayload) => {
    requireHost(payload)?.resume();
  });
  socket.on(C2S.HostEndGame, (payload: HostAuthPayload) => {
    requireHost(payload)?.endGame();
  });
  socket.on(C2S.HostAdjustScore, (payload: HostAdjustScorePayload) => {
    requireHost(payload)?.adjustScore(payload.teamId, payload.delta);
  });
  socket.on(C2S.HostRenameTeam, (payload: HostRenameTeamPayload) => {
    requireHost(payload)?.renameTeam(payload.teamId, payload.name);
  });
  socket.on(C2S.HostRemoveTeam, (payload: HostRemoveTeamPayload) => {
    requireHost(payload)?.removeTeam(payload.teamId);
  });

  // --- Deconnexion ---
  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (room && socket.data.role === "play" && socket.data.teamId) {
      room.setConnected(socket.data.teamId, false);
    }
  });
});

// Nettoyage periodique des rooms vides et inactives.
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.isEmpty()) rooms.delete(code);
  }
}, 5 * 60_000);

/** Adresses IPv4 locales (LAN) de la machine, pour partager l'accès. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

httpServer.listen(PORT, () => {
  const ips = lanAddresses();
  const port = PORT === 80 ? "" : `:${PORT}`;
  console.log("\n🎉 ArmaBarGames est lancé !\n");
  if (ips.length === 0) {
    console.log(`   Sur cette machine : http://localhost${port}`);
    console.log("   (aucune adresse réseau détectée — vérifie le Wi-Fi)");
  } else {
    console.log("   📶 Tout le monde se connecte, sur le MÊME Wi-Fi, à :");
    for (const ip of ips) console.log(`      →  http://${ip}${port}`);
    const main = ips[0];
    console.log("");
    console.log("   🎛️  Toi (animateur) : ouvre l'adresse → « Créer une partie »");
    console.log("   📺  La TV           : ouvre l'adresse → « Ouvrir la TV » + code");
    console.log("   📱  La famille      : scanne le QR de la TV (ou l'adresse + code)");
    console.log(`\n   Exemple joueur : http://${main}${port}/play\n`);
  }
});
