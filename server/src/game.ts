// Machine a etats d'une partie de quiz (une room = une partie).
import {
  computeSpeedPoints,
  generateRoomCode,
  streakMultiplier,
  sanitizeConfig,
  isAnswerClose,
  DEFAULT_CONFIG,
  DIFFICULTY_POINTS,
  TEAM_AVATARS,
  type BuzzState,
  type GameConfig,
  type GamePhase,
  type GameState,
  type PublicQuestion,
  type Question,
  type QuestionOption,
  type RevealState,
  type Team,
  type TeamSubmission,
  type Theme,
  type SfxKind,
} from "@armabar/shared";
import { pickQuestions, playableThemes, themeById, universeById } from "./data.js";

export interface Broadcaster {
  emitState(state: GameState): void;
  sfx(kind: SfxKind): void;
}

interface AnswerRecord {
  at: number;
  optionId?: string; // qcm
  text?: string; // open
  value?: number; // estimation
  orderIds?: string[]; // ordre
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

  // Etat specifique aux types de questions
  private buzz?: BuzzState;
  private buzzAt = 0; // horodatage du buzz gagnant (scoring vitesse)
  private buzzGains: Record<string, number> = {};
  private shuffledItems?: QuestionOption[]; // ordre : elements melanges (stables)
  private openPoints = new Map<string, number>(); // open : points si valide (override)

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

  private current(): Question | undefined {
    return this.questions[this.round - 1];
  }

  private nextQuestion() {
    this.reveal = undefined;
    this.answers.clear();
    this.buzz = undefined;
    this.buzzGains = {};
    this.shuffledItems = undefined;
    this.openPoints.clear();
    this.round++;
    if (this.round > this.totalRounds || this.round > this.questions.length) {
      this.finish();
      return;
    }
    const q = this.current()!;
    this.phase = "question";
    this.questionStartAt = Date.now();
    this.questionEndsAt = this.questionStartAt + this.config.questionTimeMs;

    if (q.type === "buzzer") {
      this.buzz = { order: [], current: undefined, lockedOut: [], open: true };
    }
    if (q.type === "ordre" && q.items) {
      this.shuffledItems = shuffle(q.items);
    }
    this.schedule(this.config.questionTimeMs, () => this.revealAnswer());
    this.emit();
  }

  private allConnectedAnswered(): boolean {
    const connected = [...this.teams.values()].filter((t) => t.connected);
    return connected.length > 0 && connected.every((t) => this.answers.has(t.id));
  }

  /** QCM : selection d'une proposition. */
  answer(teamId: string, questionId: string, optionId: string) {
    const q = this.current();
    if (this.phase !== "question" || !q || q.type !== "qcm") return;
    if (q.id !== questionId || !this.teams.has(teamId)) return;
    if (this.answers.has(teamId)) return; // reponse verrouillee
    this.answers.set(teamId, { optionId, at: Date.now() });
    if (this.allConnectedAnswered()) this.revealAnswer();
    else this.emit();
  }

  /** Modes ecrits : open / estimation / ordre. */
  submit(
    teamId: string,
    questionId: string,
    payload: { text?: string; value?: number; orderIds?: string[] }
  ) {
    const q = this.current();
    if (this.phase !== "question" || !q) return;
    if (q.type !== "open" && q.type !== "estimation" && q.type !== "ordre") return;
    if (q.id !== questionId || !this.teams.has(teamId)) return;
    if (this.answers.has(teamId)) return;
    this.answers.set(teamId, {
      at: Date.now(),
      text: payload.text,
      value: payload.value,
      orderIds: payload.orderIds,
    });
    if (this.allConnectedAnswered()) this.revealAnswer();
    else this.emit();
  }

  /** Buzzer : une equipe appuie. */
  pressBuzz(teamId: string) {
    const q = this.current();
    if (this.phase !== "question" || !q || q.type !== "buzzer" || !this.buzz) return;
    if (!this.buzz.open || this.buzz.current) return;
    if (this.buzz.lockedOut.includes(teamId) || !this.teams.has(teamId)) return;
    this.buzz.current = teamId;
    this.buzz.open = false;
    this.buzz.order.push(teamId);
    this.buzzAt = Date.now();
    this.clearTimer(); // gel du chrono le temps de la reponse orale
    this.playSfx("tick");
    this.emit();
  }

  /** Buzzer : l'animateur valide (ou non) l'equipe qui a buzze. */
  buzzVerdict(correct: boolean) {
    const q = this.current();
    if (this.phase !== "question" || !q || q.type !== "buzzer" || !this.buzz) return;
    const teamId = this.buzz.current;
    if (!teamId) return;
    const team = this.teams.get(teamId);
    if (!team) return;

    if (correct) {
      const elapsed = this.buzzAt - this.questionStartAt;
      const base = computeSpeedPoints(q.difficulty, elapsed, this.config.questionTimeMs);
      const mult = this.config.streakBonus ? streakMultiplier(team.streak) : 1;
      const points = Math.round(base * mult);
      team.streak += 1;
      team.score += points;
      this.buzzGains[teamId] = points;
      // Les autres perdent leur serie sur ce tour.
      for (const t of this.teams.values()) if (t.id !== teamId) t.streak = 0;
      this.revealAnswer();
    } else {
      team.streak = 0;
      this.buzz.lockedOut.push(teamId);
      this.buzz.current = undefined;
      this.buzz.open = true;
      this.playSfx("wrong");
      const connected = [...this.teams.values()].filter((t) => t.connected);
      const allLocked = connected.every((t) => this.buzz!.lockedOut.includes(t.id));
      if (connected.length > 0 && allLocked) {
        this.revealAnswer(); // personne n'a trouve
      } else {
        // Rouvre le buzzer avec une nouvelle fenetre.
        this.questionStartAt = Date.now();
        this.questionEndsAt = this.questionStartAt + this.config.questionTimeMs;
        this.schedule(this.config.questionTimeMs, () => this.revealAnswer());
        this.emit();
      }
    }
  }

  /** Reponse ecrite (open) : l'animateur force le verdict d'une equipe au reveal. */
  gradeAnswer(teamId: string, correct: boolean) {
    if (this.phase !== "reveal" || !this.reveal || this.reveal.type !== "open") return;
    const sub = this.reveal.submissions?.find((s) => s.teamId === teamId);
    const team = this.teams.get(teamId);
    if (!sub || !team || sub.correct === correct) return;
    const oldGain = this.reveal.gains[teamId] ?? 0;
    const newGain = correct ? this.openPoints.get(teamId) ?? 0 : 0;
    team.score = Math.max(0, team.score + (newGain - oldGain));
    this.reveal.gains[teamId] = newGain;
    sub.correct = correct;
    sub.auto = false;
    this.emit();
  }

  /** Applique les points de vitesse a une equipe pour une bonne reponse. */
  private awardSpeed(team: Team, difficulty: Question["difficulty"], at: number): number {
    const base = computeSpeedPoints(difficulty, at - this.questionStartAt, this.config.questionTimeMs);
    const mult = this.config.streakBonus ? streakMultiplier(team.streak) : 1;
    const points = Math.round(base * mult);
    team.streak += 1;
    team.score += points;
    return points;
  }

  private revealAnswer() {
    const q = this.current();
    if (!q) return;
    this.clearTimer();
    this.phase = "reveal";

    const gains: Record<string, number> = {};
    const reveal: RevealState = { type: q.type, gains, funFact: q.funFact };

    switch (q.type) {
      case "qcm": {
        const optionCounts: Record<string, number> = {};
        for (const opt of q.options ?? []) optionCounts[opt.id] = 0;
        for (const [teamId, rec] of this.answers) {
          if (rec.optionId) optionCounts[rec.optionId] = (optionCounts[rec.optionId] ?? 0) + 1;
          const team = this.teams.get(teamId);
          if (!team) continue;
          if (rec.optionId === q.correctOptionId) gains[teamId] = this.awardSpeed(team, q.difficulty, rec.at);
          else { team.streak = 0; gains[teamId] = 0; }
        }
        reveal.correctOptionId = q.correctOptionId;
        reveal.optionCounts = optionCounts;
        break;
      }
      case "buzzer": {
        Object.assign(gains, this.buzzGains);
        reveal.correctAnswer = q.answer;
        break;
      }
      case "open": {
        const accepted = q.acceptedAnswers?.length ? q.acceptedAnswers : q.answer ? [q.answer] : [];
        const subs: TeamSubmission[] = [];
        for (const [teamId, rec] of this.answers) {
          const team = this.teams.get(teamId);
          if (!team) continue;
          const text = rec.text ?? "";
          const ok = isAnswerClose(text, accepted);
          this.openPoints.set(teamId, computeSpeedPoints(q.difficulty, rec.at - this.questionStartAt, this.config.questionTimeMs));
          if (ok) gains[teamId] = this.awardSpeed(team, q.difficulty, rec.at);
          else { team.streak = 0; gains[teamId] = 0; }
          subs.push({ teamId, text, correct: ok, auto: true });
        }
        reveal.correctAnswer = q.answer;
        reveal.submissions = subs;
        break;
      }
      case "estimation": {
        const target = q.answerValue ?? 0;
        const entries = [...this.answers.entries()].filter(([, r]) => typeof r.value === "number");
        let best = Infinity;
        for (const [, r] of entries) best = Math.min(best, Math.abs((r.value as number) - target));
        const subs: TeamSubmission[] = [];
        for (const [teamId, rec] of this.answers) {
          const team = this.teams.get(teamId);
          if (!team) continue;
          const val = rec.value;
          const isClosest = typeof val === "number" && Math.abs(val - target) === best;
          if (isClosest) {
            const pts = Math.round(DIFFICULTY_POINTS[q.difficulty] * (this.config.streakBonus ? streakMultiplier(team.streak) : 1));
            team.streak += 1; team.score += pts; gains[teamId] = pts;
          } else { team.streak = 0; gains[teamId] = 0; }
          subs.push({ teamId, value: val, text: typeof val === "number" ? String(val) : "", correct: isClosest, auto: true });
        }
        reveal.answerValue = target;
        reveal.unit = q.unit;
        reveal.correctAnswer = `${target}${q.unit ? " " + q.unit : ""}`;
        reveal.submissions = subs;
        break;
      }
      case "ordre": {
        const correct = q.items ?? [];
        const total = correct.length || 1;
        const subs: TeamSubmission[] = [];
        for (const [teamId, rec] of this.answers) {
          const team = this.teams.get(teamId);
          if (!team) continue;
          const order = rec.orderIds ?? [];
          let matches = 0;
          for (let i = 0; i < correct.length; i++) if (order[i] === correct[i].id) matches++;
          const pts = Math.round(DIFFICULTY_POINTS[q.difficulty] * (matches / total));
          if (matches === total) team.streak += 1; else team.streak = 0;
          team.score += pts; gains[teamId] = pts;
          subs.push({ teamId, orderIds: order, correct: matches === total, auto: true });
        }
        reveal.correctOrder = correct;
        reveal.submissions = subs;
        break;
      }
    }

    // Les equipes qui n'ont pas participe perdent leur serie (hors buzzer).
    if (q.type !== "buzzer") {
      for (const team of this.teams.values()) if (!this.answers.has(team.id)) team.streak = 0;
    }

    this.reveal = reveal;
    const anyoneRight = Object.values(gains).some((g) => g > 0);
    this.playSfx(anyoneRight ? "correct" : "wrong");
    this.emit();

    // Auto-avance pour les types automatiques ; l'animateur pilote open/buzzer.
    if (q.type === "qcm" || q.type === "estimation" || q.type === "ordre") {
      this.schedule(this.config.revealTimeMs, () => this.nextQuestion());
    }
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
      type: q.type,
      difficulty: q.difficulty,
      text: q.text,
      universeName: universe?.name ?? "",
      themeName: theme?.name ?? "",
      index: this.round,
      total: this.totalRounds,
      options: q.type === "qcm" ? q.options : undefined,
      items: q.type === "ordre" ? this.shuffledItems : undefined,
      unit: q.type === "estimation" ? q.unit : undefined,
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
      buzz: this.phase === "question" && this.buzz ? this.buzz : undefined,
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

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
