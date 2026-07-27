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
  type Award,
  type BuzzState,
  type GameConfig,
  type GamePhase,
  type GameRecord,
  type GameState,
  type MancheInfo,
  type RoundLog,
  type TeamGameStats,
  type PublicQuestion,
  type Question,
  type QuestionOption,
  type RevealState,
  type Standing,
  type Team,
  type TeamSubmission,
  type Theme,
  type Universe,
  type SfxKind,
} from "@armabar/shared";
import {
  pickQuestions,
  pickQuestionsForUniverses,
  playableThemes,
  themeById,
  universeById,
  universesForThemes,
} from "./data.js";
import { listMusic } from "./music.js";

export interface Broadcaster {
  emitState(state: GameState): void;
  sfx(kind: SfxKind): void;
  archive?(record: GameRecord): void;
}

interface TeamStat {
  correct: number;
  answered: number;
  buzzerWins: number;
  maxStreak: number;
  timeSum: number;
  timeCount: number;
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
  private musicOn = false;
  private musicVolume = 0.4;
  private musicIndex = 0; // piste courante dans la playlist (fichiers deposes)
  private teams = new Map<string, Team>();
  private themes: Theme[] = [];
  private votes = new Map<string, string[]>(); // teamId -> themeIds
  private selectedThemeIds: string[] = [];
  private voteEndsAt?: number;

  // Vote des univers (2e temps)
  private universeVotes = new Map<string, string[]>(); // teamId -> universeIds
  private universeOptions: Universe[] = [];
  private selectedUniverseIds: string[] = [];

  private config: GameConfig;
  private questions: Question[] = [];
  private round = 0; // 1-based une fois la partie lancee
  private totalRounds: number;
  private manches: MancheInfo[] = []; // une manche par univers
  private roundToManche: number[] = []; // index de manche (1-based) par round
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
  private standings?: Standing[]; // classement intermediaire courant
  private lastRanks = new Map<string, number>(); // rang de chaque equipe au dernier classement

  // Archivage / statistiques
  private gameStartAt = 0;
  private teamStats = new Map<string, TeamStat>();
  private roundLogs: RoundLog[] = [];
  private awards?: Award[];

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

  /** Piste courante de la playlist (undefined -> repli generatif sur la TV). */
  private currentTrack(): string | undefined {
    const list = listMusic();
    if (list.length === 0) return undefined;
    const idx = ((this.musicIndex % list.length) + list.length) % list.length;
    return list[idx].file;
  }

  /** Pilote la musique d'ambiance (jouee sur la TV). */
  setMusic(patch: { on?: boolean; volume?: number; next?: boolean; track?: string }) {
    if (typeof patch.on === "boolean") this.musicOn = patch.on;
    if (typeof patch.volume === "number") {
      this.musicVolume = Math.min(1, Math.max(0, patch.volume));
    }
    if (typeof patch.track === "string") {
      const list = listMusic();
      const i = list.findIndex((m) => m.file === patch.track);
      if (i >= 0) this.musicIndex = i;
    }
    if (patch.next) this.musicIndex += 1;
    this.emit();
  }

  /** La TV signale la fin d'un morceau : on passe au suivant. */
  advanceTrack() {
    const list = listMusic();
    if (list.length > 0) this.musicIndex += 1;
    this.emit();
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
    returning?: boolean;
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
      returning: input.returning,
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
    this.universeVotes.delete(teamId);
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
    // Reinitialise le 2e temps (utile pour une nouvelle manche).
    this.universeVotes.clear();
    this.universeOptions = [];
    this.selectedUniverseIds = [];
    this.voteEndsAt = Date.now() + this.config.voteTimeMs;
    this.schedule(this.config.voteTimeMs, () => this.finalizeVoting());
    this.emit();
  }

  /** Vote generique : themes en phase 1, univers en phase 2. */
  vote(teamId: string, ids: string[]) {
    if (!this.teams.has(teamId)) return;
    const connected = [...this.teams.values()].filter((t) => t.connected);

    if (this.phase === "theme_voting") {
      const valid = ids
        .filter((id) => this.themes.some((t) => t.id === id))
        .slice(0, this.config.votesPerTeam);
      this.votes.set(teamId, valid);
      if (connected.length > 0 && connected.every((t) => this.votes.has(t.id))) {
        this.finalizeVoting();
      } else {
        this.emit();
      }
    } else if (this.phase === "universe_voting") {
      const valid = ids
        .filter((id) => this.universeOptions.some((u) => u.id === id))
        .slice(0, this.config.votesPerTeam);
      this.universeVotes.set(teamId, valid);
      if (connected.length > 0 && connected.every((t) => this.universeVotes.has(t.id))) {
        this.finalizeUniverseVoting();
      } else {
        this.emit();
      }
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

  // --- Vote des univers (2e temps) ---------------------------------------

  startUniverseVoting() {
    if (this.teams.size === 0 || this.selectedThemeIds.length === 0) return;
    this.universeOptions = universesForThemes(this.selectedThemeIds);
    if (this.universeOptions.length === 0) return;
    this.phase = "universe_voting";
    this.universeVotes.clear();
    this.selectedUniverseIds = [];
    this.voteEndsAt = Date.now() + this.config.voteTimeMs;
    this.schedule(this.config.voteTimeMs, () => this.finalizeUniverseVoting());
    this.emit();
  }

  private universeTally(): Record<string, number> {
    const tally: Record<string, number> = {};
    for (const u of this.universeOptions) tally[u.id] = 0;
    for (const list of this.universeVotes.values()) {
      for (const id of list) tally[id] = (tally[id] ?? 0) + 1;
    }
    return tally;
  }

  private finalizeUniverseVoting() {
    this.clearTimer();
    this.voteEndsAt = undefined;
    const tally = this.universeTally();
    this.selectedUniverseIds = [...this.universeOptions]
      .map((u) => u.id)
      .sort((a, b) => (tally[b] ?? 0) - (tally[a] ?? 0))
      .slice(0, this.config.selectedUniverseCount);
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
    // Si des univers precis ont ete votes, on les privilegie ; sinon tous
    // les univers des themes retenus.
    const picked =
      this.selectedUniverseIds.length > 0
        ? pickQuestionsForUniverses(this.selectedUniverseIds, this.totalRounds)
        : pickQuestions(selected, this.totalRounds);
    // Regroupe les questions par univers -> chaque univers devient une manche.
    this.questions = this.groupIntoManches(picked);
    this.totalRounds = this.questions.length;
    this.round = 0;
    this.lastRanks.clear();
    this.gameStartAt = Date.now();
    this.teamStats.clear();
    this.roundLogs = [];
    this.awards = undefined;
    for (const team of this.teams.values()) {
      team.score = 0;
      team.streak = 0;
    }
    this.nextQuestion();
  }

  private stat(teamId: string): TeamStat {
    let s = this.teamStats.get(teamId);
    if (!s) {
      s = { correct: 0, answered: 0, buzzerWins: 0, maxStreak: 0, timeSum: 0, timeCount: 0 };
      this.teamStats.set(teamId, s);
    }
    return s;
  }

  next() {
    // Action "passer" du host selon la phase courante.
    if (this.phase === "round_intro") this.presentCurrentQuestion();
    else if (this.phase === "question") this.revealAnswer();
    else if (this.phase === "reveal") this.advance();
    else if (this.phase === "leaderboard") this.nextQuestion();
  }

  /** Apres un reveal : classement intermediaire ou question suivante. */
  private advance() {
    const every = this.config.leaderboardEvery;
    if (every > 0 && this.round < this.totalRounds && this.round % every === 0) {
      this.enterLeaderboard();
    } else {
      this.nextQuestion();
    }
  }

  private computeStandings(): Standing[] {
    const sorted = [...this.teams.values()].sort((a, b) => b.score - a.score);
    return sorted.map((t, i) => {
      const rank = i + 1;
      const prev = this.lastRanks.get(t.id);
      return { teamId: t.id, rank, score: t.score, delta: prev === undefined ? null : prev - rank };
    });
  }

  private enterLeaderboard() {
    this.clearTimer();
    this.reveal = undefined;
    this.standings = this.computeStandings();
    for (const s of this.standings) this.lastRanks.set(s.teamId, s.rank);
    this.phase = "leaderboard";
    this.playSfx("reveal");
    this.emit();
    this.schedule(this.config.leaderboardTimeMs, () => this.nextQuestion());
  }

  private current(): Question | undefined {
    return this.questions[this.round - 1];
  }

  /** Regroupe les questions par univers ; chaque univers devient une manche. */
  private groupIntoManches(picked: Question[]): Question[] {
    const order: Question["difficulty"][] = ["facile", "moyen", "dur", "pro"];
    const universeOrder: string[] = [];
    const byUniverse = new Map<string, Question[]>();
    for (const q of picked) {
      if (!byUniverse.has(q.universeId)) {
        byUniverse.set(q.universeId, []);
        universeOrder.push(q.universeId);
      }
      byUniverse.get(q.universeId)!.push(q);
    }
    const result: Question[] = [];
    this.manches = [];
    this.roundToManche = [];
    universeOrder.forEach((uid, i) => {
      const qs = byUniverse
        .get(uid)!
        .sort((a, b) => order.indexOf(a.difficulty) - order.indexOf(b.difficulty));
      const universe = universeById(uid);
      const theme = universe ? themeById(universe.themeId) : undefined;
      this.manches.push({
        index: i + 1,
        total: universeOrder.length,
        universeName: universe?.name ?? "",
        themeName: theme?.name ?? "",
        emoji: universe?.emoji,
      });
      for (const q of qs) {
        result.push(q);
        this.roundToManche.push(i + 1);
      }
    });
    return result;
  }

  private mancheForRound(round: number): MancheInfo | undefined {
    const idx = this.roundToManche[round - 1];
    return idx ? this.manches[idx - 1] : undefined;
  }

  private isMancheStart(round: number): boolean {
    return round === 1 || this.roundToManche[round - 1] !== this.roundToManche[round - 2];
  }

  private nextQuestion() {
    this.reveal = undefined;
    this.standings = undefined;
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
    // Annonce de manche a chaque changement d'univers (si activee).
    if (this.config.roundIntroMs > 0 && this.isMancheStart(this.round)) {
      this.phase = "round_intro";
      this.playSfx("manche");
      this.schedule(this.config.roundIntroMs, () => this.presentCurrentQuestion());
      this.emit();
    } else {
      this.presentCurrentQuestion();
    }
  }

  private presentCurrentQuestion() {
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

    // --- Enregistrement des stats de la partie ---
    let answerCount = 0;
    let correctCount = 0;
    if (q.type === "buzzer") {
      for (const tid of this.buzz?.order ?? []) this.stat(tid).answered++;
      answerCount = this.buzz?.order.length ?? 0;
      const winner = Object.entries(gains).find(([, g]) => g > 0)?.[0];
      if (winner) {
        const s = this.stat(winner);
        s.correct++;
        s.buzzerWins++;
        s.timeSum += this.buzzAt - this.questionStartAt;
        s.timeCount++;
        correctCount = 1;
      }
    } else {
      for (const [tid, rec] of this.answers) {
        const s = this.stat(tid);
        s.answered++;
        if ((gains[tid] ?? 0) > 0) {
          s.correct++;
          correctCount++;
          if (q.type === "qcm" || q.type === "open") {
            s.timeSum += rec.at - this.questionStartAt;
            s.timeCount++;
          }
        }
      }
      answerCount = this.answers.size;
    }
    for (const t of this.teams.values()) {
      const s = this.stat(t.id);
      if (t.streak > s.maxStreak) s.maxStreak = t.streak;
    }
    this.roundLogs.push({
      questionId: q.id,
      text: q.text,
      type: q.type,
      difficulty: q.difficulty,
      universeId: q.universeId,
      answerCount,
      correctCount,
    });

    this.reveal = reveal;
    const anyoneRight = Object.values(gains).some((g) => g > 0);
    this.playSfx(anyoneRight ? "correct" : "wrong");
    this.emit();

    // Auto-avance pour les types automatiques ; l'animateur pilote open/buzzer.
    if (q.type === "qcm" || q.type === "estimation" || q.type === "ordre") {
      this.schedule(this.config.revealTimeMs, () => this.advance());
    }
  }

  private finish() {
    this.clearTimer();
    this.phase = "finished";
    this.questionEndsAt = undefined;
    this.buildAndArchive();
    this.playSfx("podium");
    this.emit();
  }

  private buildAndArchive() {
    const sorted = [...this.teams.values()].sort((a, b) => b.score - a.score);
    const teamStats: TeamGameStats[] = sorted.map((t, i) => {
      const s = this.stat(t.id);
      return {
        name: t.name,
        avatar: t.avatar,
        finalScore: t.score,
        finalRank: i + 1,
        correct: s.correct,
        answered: s.answered,
        buzzerWins: s.buzzerWins,
        maxStreak: s.maxStreak,
        avgAnswerMs: s.timeCount > 0 ? Math.round(s.timeSum / s.timeCount) : null,
      };
    });

    this.awards = this.computeAwards(teamStats);

    // On n'archive que les vraies parties (au moins une equipe, au moins une question).
    if (teamStats.length > 0 && this.roundLogs.length > 0 && this.broadcaster?.archive) {
      const record: GameRecord = {
        id: `${this.code}-${this.gameStartAt}`,
        startedAt: this.gameStartAt,
        endedAt: Date.now(),
        themeIds: this.selectedThemeIds,
        universeIds: [...new Set(this.roundLogs.map((r) => r.universeId))],
        totalQuestions: this.roundLogs.length,
        teams: teamStats,
        awards: this.awards,
        rounds: this.roundLogs,
      };
      this.broadcaster.archive(record);
    }
  }

  private computeAwards(teams: TeamGameStats[]): Award[] {
    const awards: Award[] = [];
    const byBest = <T>(arr: T[], score: (t: T) => number) =>
      arr.reduce((best, cur) => (score(cur) > score(best) ? cur : best), arr[0]);

    const brains = teams.filter((t) => t.correct > 0);
    if (brains.length) {
      const t = byBest(brains, (x) => x.correct);
      awards.push({ id: "brain", emoji: "🧠", title: "Le Cerveau", teamName: t.name, detail: `${t.correct} bonnes réponses` });
    }
    const fast = teams.filter((t) => t.avgAnswerMs != null);
    if (fast.length) {
      const t = fast.reduce((b, c) => ((c.avgAnswerMs as number) < (b.avgAnswerMs as number) ? c : b));
      awards.push({ id: "flash", emoji: "⚡", title: "L'Éclair", teamName: t.name, detail: `${((t.avgAnswerMs as number) / 1000).toFixed(1)} s de moyenne` });
    }
    const buzz = teams.filter((t) => t.buzzerWins > 0);
    if (buzz.length) {
      const t = byBest(buzz, (x) => x.buzzerWins);
      awards.push({ id: "buzzer", emoji: "🔔", title: "Roi du Buzzer", teamName: t.name, detail: `${t.buzzerWins} buzz gagnés` });
    }
    const streaky = teams.filter((t) => t.maxStreak >= 3);
    if (streaky.length) {
      const t = byBest(streaky, (x) => x.maxStreak);
      awards.push({ id: "streak", emoji: "🔥", title: "Série record", teamName: t.name, detail: `${t.maxStreak} d'affilée` });
    }
    return awards;
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
      if (this.phase === "theme_voting" || this.phase === "universe_voting") {
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
      totalVoters:
        this.phase === "universe_voting" ? this.universeVotes.size : this.votes.size,
      voteEndsAt: this.voteEndsAt,
      selectedThemeIds: this.selectedThemeIds,
      universeOptions: this.universeOptions,
      universeVoteTally: this.universeTally(),
      selectedUniverseIds: this.selectedUniverseIds,
      round: this.round,
      totalRounds: this.totalRounds,
      manche:
        this.phase === "round_intro" || this.phase === "question" || this.phase === "reveal"
          ? this.mancheForRound(this.round)
          : undefined,
      question: this.publicQuestion(),
      questionEndsAt: this.phase === "question" ? this.questionEndsAt : undefined,
      answeredTeamIds: [...this.answers.keys()],
      buzz: this.phase === "question" && this.buzz ? this.buzz : undefined,
      reveal: this.phase === "reveal" ? this.reveal : undefined,
      standings: this.phase === "leaderboard" ? this.standings : undefined,
      awards: this.phase === "finished" ? this.awards : undefined,
      music: { on: this.musicOn, volume: this.musicVolume, track: this.currentTrack() },
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
