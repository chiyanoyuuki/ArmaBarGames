// Chargement de la banque de contenu (catalogue + questions) depuis /data.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Difficulty, Question, Theme, Universe } from "@armabar/shared";
import { DIFFICULTIES } from "@armabar/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

interface Catalog {
  themes: Theme[];
  universes: Universe[];
}

const catalog: Catalog = JSON.parse(
  readFileSync(join(DATA_DIR, "catalog.json"), "utf8")
);

const questions: Question[] = [];
const questionsDir = join(DATA_DIR, "questions");
for (const file of readdirSync(questionsDir).filter((f) => f.endsWith(".json"))) {
  const raw = JSON.parse(readFileSync(join(questionsDir, file), "utf8"));
  for (const q of raw.questions as Question[]) {
    questions.push({ ...q, universeId: raw.universeId, type: q.type ?? "qcm" });
  }
}

export const themes = catalog.themes;
export const universes = catalog.universes;
export const allQuestions = questions;

/** Themes qui possedent au moins une question (les seuls votables utilement). */
export function playableThemes(): Theme[] {
  const universesWithQuestions = new Set(questions.map((q) => q.universeId));
  const themeHasContent = new Set(
    universes
      .filter((u) => universesWithQuestions.has(u.id))
      .map((u) => u.themeId)
  );
  return themes.filter((t) => themeHasContent.has(t.id));
}

export function universeById(id: string): Universe | undefined {
  return universes.find((u) => u.id === id);
}

export function themeById(id: string): Theme | undefined {
  return themes.find((t) => t.id === id);
}

/** Univers ayant au moins une question dans les themes donnes. */
export function universesForThemes(themeIds: string[]): Universe[] {
  const withQuestions = new Set(questions.map((q) => q.universeId));
  return universes.filter(
    (u) => themeIds.includes(u.themeId) && withQuestions.has(u.id)
  );
}

/**
 * Selectionne une liste de questions a partir des themes retenus.
 * (Raccourci : delegue a pickQuestionsForUniverses sur tous leurs univers.)
 */
export function pickQuestions(
  selectedThemeIds: string[],
  count: number
): Question[] {
  const universeIds = universes
    .filter((u) => selectedThemeIds.includes(u.themeId))
    .map((u) => u.id);
  return pickQuestionsForUniverses(universeIds, count);
}

/**
 * Selectionne une liste de questions pour une partie a partir d'univers
 * precis, avec une courbe de difficulte croissante (facile -> pro).
 */
export function pickQuestionsForUniverses(
  selectedUniverseIds: string[],
  count: number
): Question[] {
  const universeIds = new Set(selectedUniverseIds);
  const pool = questions.filter((q) => universeIds.has(q.universeId));

  const order: Question["difficulty"][] = ["facile", "moyen", "dur", "pro"];
  const byDiff = new Map(order.map((d) => [d, shuffle(pool.filter((q) => q.difficulty === d))]));

  const result: Question[] = [];
  // Repartition indicative de la courbe de difficulte sur la partie.
  const weights: Record<string, number> = { facile: 0.25, moyen: 0.35, dur: 0.25, pro: 0.15 };
  for (const d of order) {
    const want = Math.round(count * weights[d]);
    result.push(...(byDiff.get(d) ?? []).slice(0, want));
  }
  // Complete si on n'a pas atteint le compte (univers pauvres en questions).
  if (result.length < count) {
    const used = new Set(result.map((q) => q.id));
    result.push(...shuffle(pool.filter((q) => !used.has(q.id))).slice(0, count - result.length));
  }
  // Tri final par difficulte croissante pour la montee en puissance.
  result.sort((a, b) => order.indexOf(a.difficulty) - order.indexOf(b.difficulty));
  return result.slice(0, count);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Toutes les questions d'un univers (memoire chargee). */
export function questionsForUniverse(universeId: string): Question[] {
  return questions.filter((q) => q.universeId === universeId);
}

/**
 * Construit le vivier d'un univers par difficulte, questions non vues d'abord.
 * Utilise par la difficulte adaptative : chaque manche pioche dans ce vivier
 * selon le niveau courant. `seen` = ids des questions deja jouees a eviter.
 */
export function buildUniversePool(
  universeId: string,
  seen: Set<string> = new Set()
): Record<Difficulty, Question[]> {
  const pool = {} as Record<Difficulty, Question[]>;
  for (const d of DIFFICULTIES) {
    const tier = questions.filter((q) => q.universeId === universeId && q.difficulty === d);
    const unseen = shuffle(tier.filter((q) => !seen.has(q.id)));
    const already = shuffle(tier.filter((q) => seen.has(q.id)));
    // Non vues en priorite ; on ne repioche du deja-vu qu'en dernier recours.
    pool[d] = [...unseen, ...already];
  }
  return pool;
}

/** Nombre de questions d'un univers (tous niveaux confondus). */
export function universeQuestionCount(universeId: string): number {
  return questions.reduce((n, q) => (q.universeId === universeId ? n + 1 : n), 0);
}
