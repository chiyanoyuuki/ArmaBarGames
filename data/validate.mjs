#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Valide la banque de questions.
//   node data/validate.mjs
// Sort un code != 0 si une erreur de structure est detectee (pour la CI).
// Les avertissements (completude, homogeneite) n'echouent pas le build.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DIFFICULTIES = ["facile", "moyen", "dur", "pro"];
const QUESTIONS_PER_DIFFICULTY = { facile: 10, moyen: 20, dur: 30, pro: 40 };
const OPTIONS_PER_QUESTION = 4;

const errors = [];
const warnings = [];

function normalize(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // accents
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  return normalize(s).split(" ").filter(Boolean);
}

// --- Catalogue ------------------------------------------------------------

const catalog = JSON.parse(
  readFileSync(join(__dirname, "catalog.json"), "utf8")
);
const universeIds = new Set(catalog.universes.map((u) => u.id));
const themeIds = new Set(catalog.themes.map((t) => t.id));

for (const u of catalog.universes) {
  if (!themeIds.has(u.themeId)) {
    errors.push(`Univers "${u.id}" reference un theme inconnu : "${u.themeId}"`);
  }
}

// --- Questions ------------------------------------------------------------

const questionsDir = join(__dirname, "questions");
const files = readdirSync(questionsDir).filter((f) => f.endsWith(".json"));
const seenQuestionIds = new Set();

for (const file of files) {
  const path = join(questionsDir, file);
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    errors.push(`${file}: JSON invalide (${e.message})`);
    continue;
  }

  const { universeId, questions } = data;
  if (!universeId || !universeIds.has(universeId)) {
    errors.push(`${file}: universeId "${universeId}" absent du catalogue`);
  }
  if (!Array.isArray(questions)) {
    errors.push(`${file}: champ "questions" manquant ou non tableau`);
    continue;
  }

  const counts = { facile: 0, moyen: 0, dur: 0, pro: 0 };

  for (const q of questions) {
    const tag = `${file} > ${q.id ?? "(sans id)"}`;

    if (!q.id) errors.push(`${tag}: id manquant`);
    else if (seenQuestionIds.has(q.id)) errors.push(`${tag}: id en double`);
    else seenQuestionIds.add(q.id);

    if (!DIFFICULTIES.includes(q.difficulty)) {
      errors.push(`${tag}: difficulte invalide "${q.difficulty}"`);
    } else {
      counts[q.difficulty]++;
    }

    if (!q.text || typeof q.text !== "string" || q.text.trim().length < 5) {
      errors.push(`${tag}: enonce manquant ou trop court`);
    }

    if (!Array.isArray(q.options) || q.options.length !== OPTIONS_PER_QUESTION) {
      errors.push(`${tag}: doit avoir exactement ${OPTIONS_PER_QUESTION} propositions`);
      continue;
    }

    const optIds = q.options.map((o) => o.id);
    if (new Set(optIds).size !== optIds.length) {
      errors.push(`${tag}: ids de propositions en double`);
    }
    const labels = q.options.map((o) => (o.label ?? "").trim());
    if (labels.some((l) => l.length === 0)) {
      errors.push(`${tag}: une proposition a un libelle vide`);
    }
    if (new Set(labels.map(normalize)).size !== labels.length) {
      errors.push(`${tag}: propositions en double`);
    }

    const correct = q.options.find((o) => o.id === q.correctOptionId);
    if (!correct) {
      errors.push(`${tag}: correctOptionId "${q.correctOptionId}" introuvable`);
      continue;
    }

    // La reponse ne doit pas apparaitre dans l'enonce.
    const textTokens = new Set(tokens(q.text));
    const answerTokens = tokens(correct.label).filter((w) => w.length >= 4);
    const leaked = answerTokens.filter((w) => textTokens.has(w));
    if (leaked.length > 0) {
      errors.push(
        `${tag}: la reponse apparait dans l'enonce (mot(s) : ${leaked.join(", ")})`
      );
    }

    // Homogeneite : les propositions doivent avoir un format similaire.
    const wordCounts = labels.map((l) => tokens(l).length);
    if (Math.max(...wordCounts) - Math.min(...wordCounts) > 1) {
      warnings.push(
        `${tag}: propositions non homogenes (nombre de mots : ${wordCounts.join("/")})`
      );
    }
  }

  // Completude vs objectif par univers.
  for (const d of DIFFICULTIES) {
    const target = QUESTIONS_PER_DIFFICULTY[d];
    if (counts[d] < target) {
      warnings.push(
        `${file}: ${d} incomplet (${counts[d]}/${target})`
      );
    } else if (counts[d] > target) {
      warnings.push(
        `${file}: ${d} en surplus (${counts[d]}/${target})`
      );
    }
  }
}

// --- Rapport --------------------------------------------------------------

console.log(`\nFichiers analyses : ${files.length}`);
console.log(`Questions valides : ${seenQuestionIds.size}`);

if (warnings.length) {
  console.log(`\n⚠️  ${warnings.length} avertissement(s) :`);
  for (const w of warnings) console.log(`   - ${w}`);
}

if (errors.length) {
  console.log(`\n❌ ${errors.length} erreur(s) :`);
  for (const e of errors) console.log(`   - ${e}`);
  console.log("");
  process.exit(1);
}

console.log("\n✅ Aucune erreur de structure.\n");
