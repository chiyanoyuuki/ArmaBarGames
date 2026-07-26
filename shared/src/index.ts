// ---------------------------------------------------------------------------
// Types & protocole partages entre le serveur et les clients (TV / play / host)
// Source unique de verite : ne pas dupliquer ailleurs.
// ---------------------------------------------------------------------------

// --- Difficulte & scoring -------------------------------------------------

export type Difficulty = "facile" | "moyen" | "dur" | "pro";

export const DIFFICULTIES: Difficulty[] = ["facile", "moyen", "dur", "pro"];

/** Nombre de questions attendu par univers pour chaque difficulte. */
export const QUESTIONS_PER_DIFFICULTY: Record<Difficulty, number> = {
  facile: 10,
  moyen: 20,
  dur: 30,
  pro: 40,
};

/** Points de base par difficulte (avant facteur de vitesse). */
export const DIFFICULTY_POINTS: Record<Difficulty, number> = {
  facile: 100,
  moyen: 200,
  dur: 300,
  pro: 400,
};

/** Duree d'une question (ms) avant reveal automatique. */
export const QUESTION_TIME_MS = 20_000;

/** Duree d'affichage du reveal (ms) avant passage a la suite. */
export const REVEAL_TIME_MS = 6_000;

/** Duree de la phase de vote des themes (ms). */
export const VOTE_TIME_MS = 30_000;

/** Nombre de themes que chaque equipe peut voter. */
export const VOTES_PER_TEAM = 3;

/** Nombre de themes retenus a l'issue du vote. */
export const SELECTED_THEME_COUNT = 3;

/** Nombre de questions par partie par defaut. */
export const DEFAULT_TOTAL_ROUNDS = 12;

/**
 * Parametres d'une partie, modifiables par l'animateur dans le salon avant le
 * lancement. Toutes les durees sont en millisecondes.
 */
export interface GameConfig {
  questionTimeMs: number;
  revealTimeMs: number;
  voteTimeMs: number;
  totalRounds: number;
  selectedThemeCount: number;
  votesPerTeam: number;
  streakBonus: boolean;
}

export const DEFAULT_CONFIG: GameConfig = {
  questionTimeMs: QUESTION_TIME_MS,
  revealTimeMs: REVEAL_TIME_MS,
  voteTimeMs: VOTE_TIME_MS,
  totalRounds: DEFAULT_TOTAL_ROUNDS,
  selectedThemeCount: SELECTED_THEME_COUNT,
  votesPerTeam: VOTES_PER_TEAM,
  streakBonus: true,
};

/** Bornes autorisees pour l'UI de configuration (validees aussi cote serveur). */
export const CONFIG_LIMITS = {
  questionTimeMs: { min: 5_000, max: 60_000, step: 1_000 },
  revealTimeMs: { min: 2_000, max: 20_000, step: 1_000 },
  voteTimeMs: { min: 10_000, max: 120_000, step: 5_000 },
  totalRounds: { min: 3, max: 40, step: 1 },
  selectedThemeCount: { min: 1, max: 6, step: 1 },
  votesPerTeam: { min: 1, max: 5, step: 1 },
} as const;

/** Applique les bornes a une config partielle et renvoie une config complete. */
export function sanitizeConfig(
  base: GameConfig,
  patch: Partial<GameConfig>
): GameConfig {
  const clamp = (key: keyof typeof CONFIG_LIMITS, v: number) => {
    const { min, max } = CONFIG_LIMITS[key];
    return Math.min(max, Math.max(min, Math.round(v)));
  };
  const next: GameConfig = { ...base, ...patch };
  next.questionTimeMs = clamp("questionTimeMs", next.questionTimeMs);
  next.revealTimeMs = clamp("revealTimeMs", next.revealTimeMs);
  next.voteTimeMs = clamp("voteTimeMs", next.voteTimeMs);
  next.totalRounds = clamp("totalRounds", next.totalRounds);
  next.selectedThemeCount = clamp("selectedThemeCount", next.selectedThemeCount);
  next.votesPerTeam = clamp("votesPerTeam", next.votesPerTeam);
  next.streakBonus = !!next.streakBonus;
  return next;
}

/**
 * Points gagnes pour une bonne reponse : points de base ponderes par la
 * vitesse. Reponse instantanee -> 100% ; a la limite du temps -> 50%.
 * Le facteur ne descend jamais sous 0.5 pour ne pas trop punir l'hesitation.
 */
export function computeSpeedPoints(
  difficulty: Difficulty,
  elapsedMs: number,
  limitMs: number = QUESTION_TIME_MS
): number {
  const base = DIFFICULTY_POINTS[difficulty];
  const ratio = Math.min(1, Math.max(0, elapsedMs / limitMs));
  const factor = 1 - 0.5 * ratio; // 1.0 -> 0.5
  return Math.round(base * factor);
}

/** Bonus de serie : +10% par bonne reponse consecutive, plafonne a +50%. */
export function streakMultiplier(streak: number): number {
  return 1 + Math.min(0.5, Math.max(0, streak) * 0.1);
}

// --- Contenu (themes / univers / questions) -------------------------------

export interface Theme {
  id: string;
  name: string;
  emoji?: string;
}

export interface Universe {
  id: string;
  name: string;
  themeId: string;
  emoji?: string;
}

export interface QuestionOption {
  id: string;
  label: string;
}

export interface Question {
  id: string;
  universeId: string;
  difficulty: Difficulty;
  text: string;
  /** Exactement 4 propositions homogenes. */
  options: QuestionOption[];
  correctOptionId: string;
  /** Anecdote optionnelle affichee au reveal. */
  funFact?: string;
}

// --- Etat de jeu ----------------------------------------------------------

export type GamePhase =
  | "lobby" // equipes rejoignent, QR sur la TV
  | "theme_voting" // vote des themes en direct
  | "question" // question chronometree
  | "reveal" // bonne reponse + points gagnes
  | "leaderboard" // classement intermediaire
  | "finished"; // podium final

export interface Team {
  id: string;
  name: string;
  score: number;
  streak: number;
  connected: boolean;
  /** Emoji/avatar simple choisi par l'equipe. */
  avatar: string;
}

/** Version publique d'une question (sans la bonne reponse). */
export interface PublicQuestion {
  id: string;
  difficulty: Difficulty;
  text: string;
  options: QuestionOption[];
  universeName: string;
  themeName: string;
  index: number; // 1-based
  total: number;
}

export interface RevealState {
  correctOptionId: string;
  /** Points gagnes ce tour, par equipe. */
  gains: Record<string, number>;
  /** Nombre de reponses par option (pour l'histogramme sur la TV). */
  optionCounts: Record<string, number>;
  funFact?: string;
}

/**
 * Etat complet diffuse a tous les clients d'une room a chaque changement.
 * Le full-state sync garde TV / host / telephones coherents et gere les
 * reconnexions sans logique de patch cote client.
 */
export interface GameState {
  roomCode: string;
  phase: GamePhase;
  paused: boolean;
  config: GameConfig;
  teams: Team[];

  // Vote des themes
  themes: Theme[]; // themes proposes au vote
  voteTally: Record<string, number>; // themeId -> nombre de votes
  totalVoters: number; // equipes ayant vote
  voteEndsAt?: number; // epoch ms
  selectedThemeIds: string[]; // themes retenus apres le vote

  // Partie en cours
  round: number; // 1-based
  totalRounds: number;
  question?: PublicQuestion;
  questionEndsAt?: number; // epoch ms
  answeredTeamIds: string[]; // equipes ayant deja repondu (sans divulguer quoi)
  reveal?: RevealState;
}

// --- Protocole Socket.io --------------------------------------------------

export type ClientRole = "tv" | "play" | "host";

/** Evenements emis par les clients vers le serveur. */
export const C2S = {
  CreateRoom: "host:createRoom",
  HostJoin: "host:join",
  TvJoin: "tv:join",
  TeamJoin: "team:join",
  TeamVote: "team:vote",
  TeamAnswer: "team:answer",

  HostConfigure: "host:configure",
  HostStartVoting: "host:startVoting",
  HostStartGame: "host:startGame",
  HostNext: "host:next",
  HostPause: "host:pause",
  HostResume: "host:resume",
  HostAdjustScore: "host:adjustScore",
  HostRenameTeam: "host:renameTeam",
  HostRemoveTeam: "host:removeTeam",
  HostEndGame: "host:endGame",
} as const;

/** Evenements emis par le serveur vers les clients. */
export const S2C = {
  State: "state", // GameState complet
  Sfx: "sfx", // effet sonore/animation ponctuel
  Error: "error",
} as const;

export type SfxKind = "correct" | "wrong" | "tick" | "reveal" | "podium" | "join";

// --- Payloads ------------------------------------------------------------

export interface CreateRoomPayload {
  config?: Partial<GameConfig>;
}

export interface HostConfigurePayload extends HostAuthPayload {
  config: Partial<GameConfig>;
}
export interface CreateRoomAck {
  roomCode: string;
  hostToken: string;
}

export interface JoinRoomPayload {
  roomCode: string;
}

export interface TeamJoinPayload {
  roomCode: string;
  teamName: string;
  avatar?: string;
  /** Pour la reconnexion : reprend l'equipe existante si l'id est fourni. */
  teamId?: string;
}
export interface TeamJoinAck {
  teamId: string;
}

export interface TeamVotePayload {
  themeIds: string[]; // jusqu'a VOTES_PER_TEAM
}

export interface TeamAnswerPayload {
  questionId: string;
  optionId: string;
}

export interface HostAuthPayload {
  roomCode: string;
  hostToken: string;
}
export interface HostStartGamePayload extends HostAuthPayload {
  selectedThemeIds?: string[]; // override optionnel du resultat du vote
}
export interface HostAdjustScorePayload extends HostAuthPayload {
  teamId: string;
  delta: number;
}
export interface HostRenameTeamPayload extends HostAuthPayload {
  teamId: string;
  name: string;
}
export interface HostRemoveTeamPayload extends HostAuthPayload {
  teamId: string;
}

export interface AckResult<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** Genere un code de room court et lisible (sans caracteres ambigus). */
export function generateRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export const TEAM_AVATARS = [
  "🦊", "🐼", "🐧", "🦁", "🐸", "🐙", "🦄", "🐢",
  "🦉", "🐝", "🦖", "🐺", "🦩", "🐳", "🦔", "🐲",
];
