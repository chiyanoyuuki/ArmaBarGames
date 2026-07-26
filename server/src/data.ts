// Chargement de la banque de contenu (catalogue + questions) depuis /data.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Question, Theme, Universe } from "@armabar/shared";

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
    questions.push({ ...q, universeId: raw.universeId });
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

/**
 * Selectionne une liste de questions pour une partie a partir des themes
 * retenus, avec une courbe de difficulte croissante (facile -> pro).
 */
export function pickQuestions(
  selectedThemeIds: string[],
  count: number
): Question[] {
  const universeIds = new Set(
    universes.filter((u) => selectedThemeIds.includes(u.themeId)).map((u) => u.id)
  );
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
