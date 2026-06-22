const DEFAULT_REGLE_CALCUL = {
  evaluations: [
    { type: 'Devoir 1', label: 'Devoir 1', poids: 1 },
    { type: 'Devoir 2', label: 'Devoir 2', poids: 1 },
    { type: 'Composition', label: 'Composition', poids: 2 },
  ],
  seuilReussite: 10,
};

const CYCLES = ['Primaire', 'Collège', 'Lycée'];

function normalizeRegle(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_REGLE_CALCUL, evaluations: [...DEFAULT_REGLE_CALCUL.evaluations] };

  const evaluations = Array.isArray(raw.evaluations)
    ? raw.evaluations
        .map((ev) => ({
          type: String(ev.type || ev.label || '').trim(),
          label: String(ev.label || ev.type || '').trim(),
          poids: Math.max(0, parseFloat(ev.poids) || 0),
        }))
        .filter((ev) => ev.type && ev.poids > 0)
    : [];

  return {
    evaluations: evaluations.length > 0 ? evaluations : [...DEFAULT_REGLE_CALCUL.evaluations],
    seuilReussite: raw.seuilReussite !== undefined ? parseFloat(raw.seuilReussite) || 10 : 10,
  };
}

function getRegleCalcul(niveauEtude) {
  if (!niveauEtude) return normalizeRegle(null);
  return normalizeRegle(niveauEtude.regleCalcul);
}

function buildFormulaText(regle) {
  const normalized = normalizeRegle(regle);
  const parts = normalized.evaluations.map((ev) => `${ev.label} × ${ev.poids}`);
  const weightSum = normalized.evaluations.reduce((s, ev) => s + ev.poids, 0);
  return {
    moyenneMatiere: `(${parts.join(' + ')}) ÷ ${weightSum}`,
    moyenneGenerale: 'Σ(moyenne matière × coefficient matière) ÷ Σ(coefficients)',
    seuilReussite: normalized.seuilReussite,
    evaluations: normalized.evaluations,
  };
}

function computeExampleMoyenneMatiere(regle, exampleValues = {}) {
  const normalized = normalizeRegle(regle);
  let sum = 0;
  let weight = 0;
  const steps = [];

  normalized.evaluations.forEach((ev) => {
    const value = exampleValues[ev.type];
    if (value !== null && value !== undefined && !Number.isNaN(value)) {
      const points = value * ev.poids;
      sum += points;
      weight += ev.poids;
      steps.push({ label: ev.label, value, poids: ev.poids, points });
    }
  });

  const moyenne = weight > 0 ? Math.round((sum / weight) * 100) / 100 : null;
  return { steps, sum, weight, moyenne };
}

const DEFAULT_NIVEAUX = [
  { nom: 'CP', cycle: 'Primaire', ordre: 1 },
  { nom: 'CE1', cycle: 'Primaire', ordre: 2 },
  { nom: 'CE2', cycle: 'Primaire', ordre: 3 },
  { nom: 'CM1', cycle: 'Primaire', ordre: 4 },
  { nom: 'CM2', cycle: 'Primaire', ordre: 5 },
  { nom: '6ème', cycle: 'Collège', ordre: 10 },
  { nom: '5ème', cycle: 'Collège', ordre: 11 },
  { nom: '4ème', cycle: 'Collège', ordre: 12 },
  { nom: '3ème', cycle: 'Collège', ordre: 13 },
  { nom: 'Seconde', cycle: 'Lycée', ordre: 20 },
  { nom: 'Première', cycle: 'Lycée', ordre: 21 },
  { nom: 'Terminale', cycle: 'Lycée', ordre: 22 },
];

module.exports = {
  DEFAULT_REGLE_CALCUL,
  CYCLES,
  normalizeRegle,
  getRegleCalcul,
  buildFormulaText,
  computeExampleMoyenneMatiere,
  DEFAULT_NIVEAUX,
};
