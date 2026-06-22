const { normalizeRegle, DEFAULT_REGLE_CALCUL } = require('./gradeRules');

/**
 * Moyenne par matière selon les pondérations du niveau.
 */
function computeSubjectAverageFromNotes(notes, regle = DEFAULT_REGLE_CALCUL) {
  const rules = normalizeRegle(regle);
  let sum = 0;
  let weight = 0;

  rules.evaluations.forEach((ev) => {
    const note = notes.find((n) => n.type_evaluation === ev.type);
    if (note) {
      sum += note.valeur * ev.poids;
      weight += ev.poids;
    }
  });

  return weight > 0 ? Math.round((sum / weight) * 100) / 100 : null;
}

/**
 * Moyenne générale / classement : Σ(moyenne_matière × coefficient_matière) / Σ(coefficients)
 */
function computeGeneralAverage(matieres) {
  const withAverage = matieres.filter((m) => m.moyenne !== null && m.moyenne !== undefined);
  if (withAverage.length === 0) return null;

  const totalCoeff = withAverage.reduce((s, m) => s + m.coefficient, 0);
  const totalPoints = withAverage.reduce((s, m) => s + m.moyenne * m.coefficient, 0);
  return totalCoeff > 0 ? Math.round((totalPoints / totalCoeff) * 100) / 100 : null;
}

function buildMatiereResult(mat, notesEleve, regle = DEFAULT_REGLE_CALCUL) {
  const rules = normalizeRegle(regle);
  const fields = {};

  rules.evaluations.forEach((ev, index) => {
    const note = notesEleve.find((n) => n.type_evaluation === ev.type);
    const key = index === 0 ? 'd1' : index === 1 ? 'd2' : index === 2 ? 'compo' : `note${index}`;
    fields[key] = note?.valeur ?? null;
  });

  const appreciationSource = [...notesEleve].reverse().find((n) => n.appreciation)
    || notesEleve.find((n) => n.type_evaluation === 'Composition')
    || notesEleve.find((n) => n.type_evaluation === 'Devoir 2')
    || notesEleve.find((n) => n.type_evaluation === 'Devoir 1');

  const moyenne = computeSubjectAverageFromNotes(notesEleve, rules);

  return {
    matiereId: mat.id,
    matiere: mat.nom,
    nom: mat.nom,
    id: mat.id,
    coefficient: mat.coefficient,
    professeur: mat.professeur
      ? `${mat.professeur.prenom} ${mat.professeur.nom}`
      : '—',
    d1: fields.d1 ?? null,
    d2: fields.d2 ?? null,
    compo: fields.compo ?? null,
    notes: notesEleve.map((n) => ({
      id: n.id,
      valeur: n.valeur,
      type: n.type_evaluation,
      appreciation: n.appreciation,
    })),
    moyenne,
    appreciation: appreciationSource?.appreciation || '',
  };
}

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
