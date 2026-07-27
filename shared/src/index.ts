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
  /** Nombre d'univers retenus a l'issue du 2e vote. */
  selectedUniverseCount: number;
  votesPerTeam: number;
  streakBonus: boolean;
  /** Affiche un classement intermediaire toutes les N questions (0 = jamais). */
  leaderboardEvery: number;
  /** Duree d'affichage du classement intermediaire (ms). */
  leaderboardTimeMs: number;
  /** Duree de l'annonce de manche entre univers (ms ; 0 = desactive). */
  roundIntroMs: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  questionTimeMs: QUESTION_TIME_MS,
  revealTimeMs: REVEAL_TIME_MS,
  voteTimeMs: VOTE_TIME_MS,
  totalRounds: DEFAULT_TOTAL_ROUNDS,
  selectedThemeCount: SELECTED_THEME_COUNT,
  selectedUniverseCount: 3,
  votesPerTeam: VOTES_PER_TEAM,
  streakBonus: true,
  leaderboardEvery: 5,
  leaderboardTimeMs: 8_000,
  roundIntroMs: 3_500,
};

/** Bornes autorisees pour l'UI de configuration (validees aussi cote serveur). */
export const CONFIG_LIMITS = {
  questionTimeMs: { min: 5_000, max: 60_000, step: 1_000 },
  revealTimeMs: { min: 2_000, max: 20_000, step: 1_000 },
  voteTimeMs: { min: 10_000, max: 120_000, step: 5_000 },
  totalRounds: { min: 3, max: 40, step: 1 },
  selectedThemeCount: { min: 1, max: 6, step: 1 },
  selectedUniverseCount: { min: 1, max: 8, step: 1 },
  votesPerTeam: { min: 1, max: 5, step: 1 },
  leaderboardEvery: { min: 0, max: 10, step: 1 },
  leaderboardTimeMs: { min: 4_000, max: 20_000, step: 1_000 },
  roundIntroMs: { min: 0, max: 8_000, step: 500 },
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
  next.selectedUniverseCount = clamp("selectedUniverseCount", next.selectedUniverseCount);
  next.votesPerTeam = clamp("votesPerTeam", next.votesPerTeam);
  next.leaderboardEvery = clamp("leaderboardEvery", next.leaderboardEvery);
  next.leaderboardTimeMs = clamp("leaderboardTimeMs", next.leaderboardTimeMs);
  next.roundIntroMs = clamp("roundIntroMs", next.roundIntroMs);
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

// --- Matching flou (mode reponse ecrite) ----------------------------------

/** Normalise une reponse : minuscules, sans accents, sans ponctuation ni articles. */
export function normalizeAnswer(s: string): string {
  let out = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Retire les articles/mots vides frequents en debut et dans la chaine.
  out = out
    .split(" ")
    .filter((w) => !["le", "la", "les", "l", "un", "une", "des", "de", "du", "d"].includes(w))
    .join(" ");
  return out.trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/** Similarite [0,1] entre deux chaines (1 = identiques). */
export function similarity(a: string, b: string): number {
  const na = normalizeAnswer(a);
  const nb = normalizeAnswer(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

/** Seuil de ressemblance a partir duquel une reponse ecrite est acceptee. */
export const ANSWER_MATCH_THRESHOLD = 0.82;

/** true si `input` est assez proche d'une des reponses acceptees. */
export function isAnswerClose(
  input: string,
  accepted: string[],
  threshold: number = ANSWER_MATCH_THRESHOLD
): boolean {
  const ni = normalizeAnswer(input);
  if (!ni) return false;
  return accepted.some((a) => {
    const na = normalizeAnswer(a);
    if (!na) return false;
    if (ni === na) return true;
    // Inclusion mot a mot (ex. "sean connery" contient "connery").
    if (na.split(" ").length === 1 && ni.split(" ").includes(na)) return true;
    return similarity(ni, na) >= threshold;
  });
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

/**
 * Types de questions :
 * - qcm        : 4 propositions, une bonne reponse (points a la vitesse)
 * - buzzer     : les equipes buzzent, la 1re repond a l'oral, l'animateur valide
 * - open       : chaque equipe tape sa reponse, auto-validee (ressemblance) + override
 * - estimation : reponse chiffree, le plus proche gagne (100% automatique)
 * - ordre      : remettre 4 elements dans le bon ordre (credit partiel)
 */
export type QuestionType = "qcm" | "buzzer" | "open" | "estimation" | "ordre";

export const QUESTION_TYPES: QuestionType[] = [
  "qcm",
  "buzzer",
  "open",
  "estimation",
  "ordre",
];

export interface Question {
  id: string;
  universeId: string;
  difficulty: Difficulty;
  /** Type de question ; "qcm" par defaut si absent du JSON. */
  type: QuestionType;
  text: string;
  // --- qcm ---
  /** Exactement 4 propositions homogenes. */
  options?: QuestionOption[];
  correctOptionId?: string;
  // --- buzzer / open ---
  /** Reponse canonique (affichee au reveal). */
  answer?: string;
  /** open : variantes acceptees par le matching flou (inclut answer). */
  acceptedAnswers?: string[];
  // --- estimation ---
  answerValue?: number;
  /** Unite affichee (ex. "ans", "millions", "km"). */
  unit?: string;
  // --- ordre ---
  /** ordre : les 4 elements DANS le bon ordre. */
  items?: QuestionOption[];
  /** Anecdote optionnelle affichee au reveal. */
  funFact?: string;
}

// --- Etat de jeu ----------------------------------------------------------

export type GamePhase =
  | "lobby" // equipes rejoignent, QR sur la TV
  | "theme_voting" // vote des gros themes
  | "universe_voting" // vote des univers precis (dans les themes retenus)
  | "round_intro" // annonce de manche (nouvel univers)
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

/** Une manche = un univers joue d'affilee ; annoncee sur la TV. */
export interface MancheInfo {
  index: number; // 1-based
  total: number;
  universeName: string;
  themeName: string;
  emoji?: string;
}

/** Version publique d'une question (sans la bonne reponse). */
export interface PublicQuestion {
  id: string;
  type: QuestionType;
  difficulty: Difficulty;
  text: string;
  universeName: string;
  themeName: string;
  index: number; // 1-based
  total: number;
  // qcm : propositions (sans la bonne reponse)
  options?: QuestionOption[];
  // ordre : les elements MELANGES a remettre dans l'ordre
  items?: QuestionOption[];
  // estimation : unite affichee
  unit?: string;
}

/** Ce qu'une equipe a soumis (open / estimation / ordre), visible au reveal. */
export interface TeamSubmission {
  teamId: string;
  /** open : texte brut ; estimation : nombre formate. */
  text?: string;
  /** estimation : valeur numerique. */
  value?: number;
  /** ordre : ordre soumis (liste d'ids d'elements). */
  orderIds?: string[];
  /** Verdict final (auto, ou force par l'animateur). */
  correct: boolean;
  /** true si le verdict vient de l'auto-validation (pour l'UI animateur). */
  auto: boolean;
}

/** Etat du buzzer pendant une question de ce type. */
export interface BuzzState {
  order: string[]; // equipes dans l'ordre des buzz
  current?: string; // equipe en train de repondre (en attente du verdict)
  lockedOut: string[]; // equipes ayant deja repondu faux ce tour
  open: boolean; // le buzzer accepte-t-il de nouveaux buzz ?
}

export interface RevealState {
  /** Type de la question revelee. */
  type: QuestionType;
  /** Points gagnes ce tour, par equipe. */
  gains: Record<string, number>;
  funFact?: string;
  // qcm
  correctOptionId?: string;
  optionCounts?: Record<string, number>;
  // buzzer / open / estimation
  correctAnswer?: string;
  // estimation
  answerValue?: number;
  unit?: string;
  // ordre
  correctOrder?: QuestionOption[];
  // open / estimation / ordre
  submissions?: TeamSubmission[];
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
  totalVoters: number; // equipes ayant vote (phase de vote courante)
  voteEndsAt?: number; // epoch ms
  selectedThemeIds: string[]; // themes retenus apres le vote

  // Vote des univers (2e temps, dans les themes retenus)
  universeOptions: Universe[]; // univers proposes au vote
  universeVoteTally: Record<string, number>; // universeId -> nombre de votes
  selectedUniverseIds: string[]; // univers retenus apres le vote

  // Partie en cours
  round: number; // 1-based
  totalRounds: number;
  manche?: MancheInfo; // manche courante (round_intro / question / reveal)
  question?: PublicQuestion;
  questionEndsAt?: number; // epoch ms
  answeredTeamIds: string[]; // equipes ayant deja repondu (sans divulguer quoi)
  buzz?: BuzzState; // present uniquement pendant une question de type buzzer
  reveal?: RevealState;
  standings?: Standing[]; // present uniquement pendant la phase leaderboard
  awards?: Award[]; // present uniquement a la fin (trophees rigolos de la partie)
}

// --- Archive & statistiques ----------------------------------------------

/** Trophee rigolo attribue a une equipe en fin de partie. */
export interface Award {
  id: string;
  emoji: string;
  title: string;
  teamName: string;
  detail: string;
}

/** Bilan d'une equipe sur une partie. */
export interface TeamGameStats {
  name: string;
  avatar: string;
  finalScore: number;
  finalRank: number;
  correct: number;
  answered: number;
  buzzerWins: number;
  maxStreak: number;
  avgAnswerMs: number | null; // sur les bonnes reponses chronometrees
}

/** Trace legere d'une question jouee (pour les stats globales). */
export interface RoundLog {
  questionId: string;
  text: string;
  type: QuestionType;
  difficulty: Difficulty;
  universeId: string;
  answerCount: number;
  correctCount: number;
}

/** Enregistrement complet d'une partie terminee. */
export interface GameRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  themeIds: string[];
  universeIds: string[];
  totalQuestions: number;
  teams: TeamGameStats[];
  awards: Award[];
  rounds: RoundLog[];
}

/** Statistiques agregees sur toutes les soirees archivees. */
export interface GlobalStats {
  games: number;
  questionsPlayed: number;
  distinctTeams: number;
  totalCorrect: number;
  highestScore: { value: number; teamName: string } | null;
  favoriteUniverse: { universeId: string; count: number } | null;
  longestStreak: { value: number; teamName: string } | null;
  buzzerKing: { teamName: string; wins: number } | null;
  hardestQuestion: { text: string; rate: number } | null;
  easiestQuestion: { text: string; rate: number } | null;
  typeBreakdown: Record<string, number>;
  topTeams: { name: string; games: number; wins: number; totalScore: number }[];
}

/** Ligne de classement intermediaire, avec mouvement depuis le dernier point. */
export interface Standing {
  teamId: string;
  rank: number; // 1-based
  score: number;
  /** Positions gagnees (+) ou perdues (-) depuis le dernier classement ; null si nouveau. */
  delta: number | null;
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
  TeamAnswer: "team:answer", // qcm
  TeamSubmit: "team:submit", // open / estimation / ordre
  TeamBuzz: "team:buzz", // buzzer

  HostConfigure: "host:configure",
  HostBuzzVerdict: "host:buzzVerdict", // valide l'equipe qui buzze
  HostGradeAnswer: "host:gradeAnswer", // force oui/non sur une reponse ecrite
  HostStartVoting: "host:startVoting",
  HostStartUniverseVoting: "host:startUniverseVoting",
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

export type SfxKind = "correct" | "wrong" | "tick" | "reveal" | "podium" | "join" | "manche";

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

export interface TeamSubmitPayload {
  questionId: string;
  text?: string; // open
  value?: number; // estimation
  orderIds?: string[]; // ordre
}

export interface HostBuzzVerdictPayload extends HostAuthPayload {
  correct: boolean;
}

export interface HostGradeAnswerPayload extends HostAuthPayload {
  teamId: string;
  correct: boolean;
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
