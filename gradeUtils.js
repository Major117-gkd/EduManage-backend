/**
 * Moyenne par matière (sans coefficient de la matière).
 * Pondération interne des évaluations : D1×1, D2×1, Compo×2.
 */
function computeSubjectAverageFromNotes(notes) {
  const d1 = notes.find((n) => n.type_evaluation === 'Devoir 1');
  const d2 = notes.find((n) => n.type_evaluation === 'Devoir 2');
  const compo = notes.find((n) => n.type_evaluation === 'Composition');
  let sum = 0;
  let weight = 0;
  if (d1) { sum += d1.valeur; weight += 1; }
  if (d2) { sum += d2.valeur; weight += 1; }
  if (compo) { sum += compo.valeur * 2; weight += 2; }
  return weight > 0 ? Math.round((sum / weight) * 100) / 100 : null;
}

/**
 * Moyenne générale / classement : Σ(moyenne_matière × coefficient_matière) / Σ(coefficients)
 * Le coefficient de la matière n'intervient qu'à cette étape.
 */
function computeGeneralAverage(matieres) {
  const withAverage = matieres.filter((m) => m.moyenne !== null && m.moyenne !== undefined);
  if (withAverage.length === 0) return null;

  const totalCoeff = withAverage.reduce((s, m) => s + m.coefficient, 0);
  const totalPoints = withAverage.reduce((s, m) => s + m.moyenne * m.coefficient, 0);
  return totalCoeff > 0 ? Math.round((totalPoints / totalCoeff) * 100) / 100 : null;
}

function buildMatiereResult(mat, notesEleve) {
  const d1 = notesEleve.find((n) => n.type_evaluation === 'Devoir 1');
  const d2 = notesEleve.find((n) => n.type_evaluation === 'Devoir 2');
  const compo = notesEleve.find((n) => n.type_evaluation === 'Composition');
  const appreciation = compo?.appreciation || d2?.appreciation || d1?.appreciation || '';
  const moyenne = computeSubjectAverageFromNotes(notesEleve);

  return {
    matiereId: mat.id,
    matiere: mat.nom,
    nom: mat.nom,
    id: mat.id,
    coefficient: mat.coefficient,
    professeur: mat.professeur
      ? `${mat.professeur.prenom} ${mat.professeur.nom}`
      : '—',
    d1: d1?.valeur ?? null,
    d2: d2?.valeur ?? null,
    compo: compo?.valeur ?? null,
    notes: notesEleve.map((n) => ({
      id: n.id,
      valeur: n.valeur,
      type: n.type_evaluation,
      appreciation: n.appreciation,
    })),
    moyenne,
    appreciation,
  };
}

/** Classement par groupe (ex. par classe), avec ex-aequo. */
function assignRanks(items, getAverage) {
  const sorted = [...items]
    .filter((item) => getAverage(item) !== null && getAverage(item) !== undefined)
    .sort((a, b) => getAverage(b) - getAverage(a));

  let rank = 0;
  let previousAverage = null;

  sorted.forEach((item, index) => {
    const avg = getAverage(item);
    if (avg !== previousAverage) {
      rank = index + 1;
      previousAverage = avg;
    }
    item.rang = rank;
  });

  items.forEach((item) => {
    if (getAverage(item) === null || getAverage(item) === undefined) {
      item.rang = null;
    }
  });

  return items;
}

function assignRanksByGroup(items, groupKey, getAverage) {
  const groups = {};
  items.forEach((item) => {
    const key = item[groupKey];
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  });

  Object.values(groups).forEach((group) => assignRanks(group, getAverage));
  return items;
}

module.exports = {
  computeSubjectAverageFromNotes,
  computeGeneralAverage,
  buildMatiereResult,
  assignRanks,
  assignRanksByGroup,
};
