// Machine a etats d'une partie de quiz (une room = une partie).
import {
  computeSpeedPoints,
  generateRoomCode,
  streakMultiplier,
  sanitizeConfig,
  DEFAULT_CONFIG,
  TEAM_AVATARS,
  type GameConfig,
  type GamePhase,
  type GameState,
  type PublicQuestion,
  type Question,
  type RevealState,
  type Team,
  type Theme,
  type SfxKind,
} from "@armabar/shared";
import { pickQuestions, playableThemes, themeById, universeById } from "./data.js";

export interface Broadcaster {
  emitState(state: GameState): void;
  sfx(kind: SfxKind): void;
}

interface AnswerRecord {
  optionId: string;
  at: number;
}

export class GameRoom {
  readonly code: string;
  readonly hostToken: string;

  private phase: GamePhase = "lobby";
  private paused = false;
  private teams = new Map<string, Team>();
  private themes: Theme[] = [];
  private votes = new Map<string, string[]>(); // teamId -> themeIds
  private selectedThemeIds: string[] = [];
  private voteEndsAt?: number;

  private config: GameConfig;
  private questions: Question[] = [];
  private round = 0; // 1-based une fois la partie lancee
  private totalRounds: number;
  private answers = new Map<string, AnswerRecord>();
  private questionStartAt = 0;
  private questionEndsAt?: number;
  private reveal?: RevealState;

  // Gestion des timers avec support pause/reprise.
  private timer?: ReturnType<typeof setTimeout>;
  private pendingFn?: () => void;
  private deadline = 0;
  private remainingOnPause = 0;

  private broadcaster?: Broadcaster;

  constructor(opts: { config?: Partial<GameConfig> } = {}) {
    this.code = generateRoomCode();
    this.hostToken = generateRoomCode() + generateRoomCode();
    this.config = sanitizeConfig(DEFAULT_CONFIG, opts.config ?? {});
    this.totalRounds = this.config.totalRounds;
    this.themes = playableThemes();
  }

  /** Branche le canal de diffusion une fois le code de room connu. */
  attach(broadcaster: Broadcaster) {
    this.broadcaster = broadcaster;
  }

  /** Reconfigure la partie (uniquement dans le salon, avant le lancement). */
  configure(patch: Partial<GameConfig>) {
    if (this.phase !== "lobby") return;
    this.config = sanitizeConfig(this.config, patch);
    this.totalRounds = this.config.totalRounds;
    this.emit();
  }

  // --- Timers ------------------------------------------------------------

  private schedule(delayMs: number, fn: () => void) {
    this.clearTimer();
    this.pendingFn = fn;
    this.deadline = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pendingFn = undefined;
      fn();
    }, delayMs);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // --- Equipes -----------------------------------------------------------

  addOrReconnectTeam(input: {
    teamId?: string;
    name: string;
    avatar?: string;
  }): Team {
    if (input.teamId && this.teams.has(input.teamId)) {
      const team = this.teams.get(input.teamId)!;
      team.connected = true;
      if (input.name) team.name = input.name;
      this.emit();
      return team;
    }
    const id = generateRoomCode() + Date.now().toString(36);
    const avatar =
      input.avatar ?? TEAM_AVATARS[this.teams.size % TEAM_AVATARS.length];
    const team: Team = {
      id,
      name: input.name || `Équipe ${this.teams.size + 1}`,
      score: 0,
      streak: 0,
      connected: true,
      avatar,
    };
    this.teams.set(id, team);
    this.playSfx("join");
    this.emit();
    return team;
  }

  setConnected(teamId: string, connected: boolean) {
    const team = this.teams.get(teamId);
    if (team) {
      team.connected = connected;
      this.emit();
    }
  }

  renameTeam(teamId: string, name: string) {
    const team = this.teams.get(teamId);
    if (team && name.trim()) {
      team.name = name.trim();
      this.emit();
    }
  }

  removeTeam(teamId: string) {
    this.teams.delete(teamId);
    this.votes.delete(teamId);
    this.answers.delete(teamId);
    this.emit();
  }

  adjustScore(teamId: string, delta: number) {
    const team = this.teams.get(teamId);
    if (team) {
      team.score = Math.max(0, team.score + delta);
      this.emit();
    }
  }

  // --- Vote des themes ---------------------------------------------------

  startVoting() {
    if (this.teams.size === 0) return;
    this.phase = "theme_voting";
    this.votes.clear();
    this.selectedThemeIds = [];
    this.voteEndsAt = Date.now() + this.config.voteTimeMs;
    this.schedule(this.config.voteTimeMs, () => this.finalizeVoting());
    this.emit();
  }

  vote(teamId: string, themeIds: string[]) {
    if (this.phase !== "theme_voting") return;
    if (!this.teams.has(teamId)) return;
    const valid = themeIds
      .filter((id) => this.themes.some((t) => t.id === id))
      .slice(0, this.config.votesPerTeam);
    this.votes.set(teamId, valid);
    // Vote termine automatiquement si toutes les equipes connectees ont vote.
    const connected = [...this.teams.values()].filter((t) => t.connected);
    if (connected.length > 0 && connected.every((t) => this.votes.has(t.id))) {
      this.finalizeVoting();
    } else {
      this.emit();
    }
  }

  private tally(): Record<string, number> {
    const tally: Record<string, number> = {};
    for (const t of this.themes) tally[t.id] = 0;
    for (const list of this.votes.values()) {
      for (const id of list) tally[id] = (tally[id] ?? 0) + 1;
    }
    return tally;
  }

  private finalizeVoting() {
    this.clearTimer();
    this.voteEndsAt = undefined;
    const tally = this.tally();
    this.selectedThemeIds = [...this.themes]
      .map((t) => t.id)
      .sort((a, b) => (tally[b] ?? 0) - (tally[a] ?? 0))
      .slice(0, this.config.selectedThemeCount);
    this.playSfx("reveal");
    this.emit();
  }

  // --- Deroulement de la partie ------------------------------------------

  startGame(overrideThemeIds?: string[]) {
    const selected =
      overrideThemeIds && overrideThemeIds.length
        ? overrideThemeIds
        : this.selectedThemeIds.length
          ? this.selectedThemeIds
          : this.themes.slice(0, this.config.selectedThemeCount).map((t) => t.id);
    this.selectedThemeIds = selected;
    this.questions = pickQuestions(selected, this.totalRounds);
    this.totalRounds = this.questions.length;
    this.round = 0;
    for (const team of this.teams.values()) {
      team.score = 0;
      team.streak = 0;
    }
    this.nextQuestion();
  }

  next() {
    // Action "passer" du host selon la phase courante.
    if (this.phase === "question") this.revealAnswer();
    else if (this.phase === "reveal" || this.phase === "leaderboard")
      this.nextQuestion();
  }

  private nextQuestion() {
    this.reveal = undefined;
    this.answers.clear();
    this.round++;
    if (this.round > this.totalRounds || this.round > this.questions.length) {
      this.finish();
      return;
    }
    this.phase = "question";
    this.questionStartAt = Date.now();
    this.questionEndsAt = this.questionStartAt + this.config.questionTimeMs;
    this.schedule(this.config.questionTimeMs, () => this.revealAnswer());
    this.emit();
  }

  answer(teamId: string, questionId: string, optionId: string) {
    if (this.phase !== "question") return;
    const current = this.questions[this.round - 1];
    if (!current || current.id !== questionId) return;
    if (!this.teams.has(teamId)) return;
    if (this.answers.has(teamId)) return; // reponse verrouillee
    this.answers.set(teamId, { optionId, at: Date.now() });

    // Reveal anticipe si toutes les equipes connectees ont repondu.
    const connected = [...this.teams.values()].filter((t) => t.connected);
    if (connected.length > 0 && connected.every((t) => this.answers.has(t.id))) {
      this.revealAnswer();
    } else {
      this.emit(); // met a jour la liste des equipes ayant repondu
    }
  }

  private revealAnswer() {
    const current = this.questions[this.round - 1];
    if (!current) return;
    this.clearTimer();
    this.phase = "reveal";

    const gains: Record<string, number> = {};
    const optionCounts: Record<string, number> = {};
    for (const opt of current.options) optionCounts[opt.id] = 0;

    for (const [teamId, rec] of this.answers) {
      optionCounts[rec.optionId] = (optionCounts[rec.optionId] ?? 0) + 1;
      const team = this.teams.get(teamId);
      if (!team) continue;
      if (rec.optionId === current.correctOptionId) {
        const elapsed = rec.at - this.questionStartAt;
        const base = computeSpeedPoints(
          current.difficulty,
          elapsed,
          this.config.questionTimeMs
        );
        const mult = this.config.streakBonus ? streakMultiplier(team.streak) : 1;
        const points = Math.round(base * mult);
        team.streak += 1;
        team.score += points;
        gains[teamId] = points;
      } else {
        team.streak = 0;
        gains[teamId] = 0;
      }
    }
    // Les equipes qui n'ont pas repondu perdent leur serie.
    for (const team of this.teams.values()) {
      if (!this.answers.has(team.id)) team.streak = 0;
    }

    this.reveal = {
      correctOptionId: current.correctOptionId,
      gains,
      optionCounts,
      funFact: current.funFact,
    };
    const anyoneRight = Object.values(gains).some((g) => g > 0);
    this.playSfx(anyoneRight ? "correct" : "wrong");
    this.emit();

    this.schedule(this.config.revealTimeMs, () => this.nextQuestion());
  }

  private finish() {
    this.clearTimer();
    this.phase = "finished";
    this.questionEndsAt = undefined;
    this.playSfx("podium");
    this.emit();
  }

  endGame() {
    this.finish();
  }

  // --- Pause / reprise ---------------------------------------------------

  pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.timer) {
      this.remainingOnPause = Math.max(0, this.deadline - Date.now());
      this.clearTimer();
    }
    this.emit();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.pendingFn && this.remainingOnPause > 0) {
      const fn = this.pendingFn;
      // Recale l'echeance visible cote clients.
      if (this.phase === "question") {
        this.questionEndsAt = Date.now() + this.remainingOnPause;
      }
      if (this.phase === "theme_voting") {
        this.voteEndsAt = Date.now() + this.remainingOnPause;
      }
      this.schedule(this.remainingOnPause, fn);
    }
    this.emit();
  }

  // --- Serialisation -----------------------------------------------------

  private publicQuestion(): PublicQuestion | undefined {
    if (this.phase !== "question" && this.phase !== "reveal") return undefined;
    const q = this.questions[this.round - 1];
    if (!q) return undefined;
    const universe = universeById(q.universeId);
    const theme = universe ? themeById(universe.themeId) : undefined;
    return {
      id: q.id,
      difficulty: q.difficulty,
      text: q.text,
      options: q.options,
      universeName: universe?.name ?? "",
      themeName: theme?.name ?? "",
      index: this.round,
      total: this.totalRounds,
    };
  }

  toState(): GameState {
    return {
      roomCode: this.code,
      phase: this.phase,
      paused: this.paused,
      config: this.config,
      teams: [...this.teams.values()],
      themes: this.themes,
      voteTally: this.tally(),
      totalVoters: this.votes.size,
      voteEndsAt: this.voteEndsAt,
      selectedThemeIds: this.selectedThemeIds,
      round: this.round,
      totalRounds: this.totalRounds,
      question: this.publicQuestion(),
      questionEndsAt: this.phase === "question" ? this.questionEndsAt : undefined,
      answeredTeamIds: [...this.answers.keys()],
      reveal: this.phase === "reveal" ? this.reveal : undefined,
    };
  }

  private emit() {
    this.broadcaster?.emitState(this.toState());
  }

  private playSfx(kind: SfxKind) {
    this.broadcaster?.sfx(kind);
  }

  isEmpty(): boolean {
    return this.teams.size === 0;
  }
}
