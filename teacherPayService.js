/**
 * Helpers rémunération professeurs (présences + tarifs horaires)
 * Montant mensuel = total heures du mois × tarif horaire (par classe)
 */

function parsePresenceDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const d = new Date(`${dateStr}T12:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonthKey() {
  return todayDateString().slice(0, 7);
}

function monthKeyFromDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 7);
}

function monthDateRange(moisKey) {
  const [y, m] = moisKey.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const start = new Date(`${moisKey}-01T12:00:00.000Z`);
  const nextM = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const end = new Date(`${nextM}-01T12:00:00.000Z`);
  return { start, end };
}

async function getActiveAnneeNom(prisma) {
  const active = await prisma.anneeScolaire.findFirst({ where: { active: true } });
  return active?.nom || null;
}

/**
 * Calcule la rémunération mensuelle : heures cumulées × tarif horaire par classe.
 */
function computeMonthlyFromPresences(presences, moisCourant = currentMonthKey()) {
  const byMonth = {};

  for (const p of presences) {
    const mois = monthKeyFromDate(p.date_presence);
    if (!byMonth[mois]) {
      byMonth[mois] = {
        mois,
        seances: 0,
        heures: 0,
        montant: 0,
        par_classe: {},
        est_mois_courant: mois === moisCourant,
      };
    }
    const month = byMonth[mois];
    month.seances += 1;
    month.heures += p.nombre_heures;

    const ck = p.classeId;
    if (!month.par_classe[ck]) {
      month.par_classe[ck] = {
        classeId: ck,
        classe_nom: p.classe?.nom || null,
        classe_niveau: p.classe?.niveau || null,
        heures: 0,
        tarif_horaire: p.tarif_horaire,
        montant: 0,
      };
    }
    const bucket = month.par_classe[ck];
    bucket.heures += p.nombre_heures;
    bucket.tarif_horaire = p.tarif_horaire;
    bucket.montant = bucket.heures * bucket.tarif_horaire;
  }

  for (const month of Object.values(byMonth)) {
    month.par_classe = Object.values(month.par_classe);
    month.montant = month.par_classe.reduce((s, c) => s + c.montant, 0);
  }

  return Object.values(byMonth).sort((a, b) => b.mois.localeCompare(a.mois));
}

/**
 * Synthèse mensuelle par professeur (admin).
 */
function computeProfMonthlySummary(presences, moisCourant = currentMonthKey()) {
  const byProf = {};

  for (const p of presences) {
    const mois = monthKeyFromDate(p.date_presence);
    const profId = p.professeurId;
    const key = `${profId}-${mois}`;

    if (!byProf[key]) {
      byProf[key] = {
        professeurId: profId,
        professeur: p.professeur
          ? { id: p.professeur.id, nom: p.professeur.nom, prenom: p.professeur.prenom }
          : null,
        mois,
        est_mois_courant: mois === moisCourant,
        seances: 0,
        heures: 0,
        montant: 0,
        par_classe: {},
      };
    }

    const row = byProf[key];
    row.seances += 1;
    row.heures += p.nombre_heures;

    const ck = p.classeId;
    if (!row.par_classe[ck]) {
      row.par_classe[ck] = {
        classeId: ck,
        classe_nom: p.classe?.nom || null,
        heures: 0,
        tarif_horaire: p.tarif_horaire,
        montant: 0,
      };
    }
    const bucket = row.par_classe[ck];
    bucket.heures += p.nombre_heures;
    bucket.tarif_horaire = p.tarif_horaire;
    bucket.montant = bucket.heures * bucket.tarif_horaire;
  }

  return Object.values(byProf)
    .map((row) => ({
      ...row,
      par_classe: Object.values(row.par_classe),
      montant: Object.values(row.par_classe).reduce((s, c) => s + c.montant, 0),
    }))
    .sort((a, b) => {
      const nameA = `${a.professeur?.nom || ''} ${a.professeur?.prenom || ''}`;
      const nameB = `${b.professeur?.nom || ''} ${b.professeur?.prenom || ''}`;
      return nameA.localeCompare(nameB, 'fr');
    });
}

/**
 * Regroupe les matières par professeur puis par classe (affectations).
 */
function buildProfesseursAffectations(matieres, presences = []) {
  const seancesByProfClasse = new Map();
  for (const p of presences) {
    const k = `${p.professeurId}-${p.classeId}`;
    if (!seancesByProfClasse.has(k)) seancesByProfClasse.set(k, []);
    seancesByProfClasse.get(k).push({
      id: p.id,
      nombre_heures: p.nombre_heures,
      createdAt: p.createdAt,
    });
  }
  for (const arr of seancesByProfClasse.values()) {
    arr.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  const byProf = new Map();

  for (const m of matieres) {
    if (!m.professeurId || !m.classeId) continue;

    if (!byProf.has(m.professeurId)) {
      byProf.set(m.professeurId, {
        professeurId: m.professeurId,
        professeur: m.professeur
          ? { id: m.professeur.id, nom: m.professeur.nom, prenom: m.professeur.prenom }
          : null,
        affectations: new Map(),
      });
    }

    const prof = byProf.get(m.professeurId);
    const tarif = m.classe?.tarifHoraire;

    if (!prof.affectations.has(m.classeId)) {
      const seances = seancesByProfClasse.get(`${m.professeurId}-${m.classeId}`) || [];
      const heures_jour = seances.reduce((s, x) => s + x.nombre_heures, 0);
      prof.affectations.set(m.classeId, {
        classeId: m.classeId,
        classe: m.classe
          ? {
              id: m.classe.id,
              nom: m.classe.nom,
              niveau: m.classe.niveau,
              cycle: m.classe.cycle || null,
              niveauEtude: m.classe.niveauEtude?.nom || null,
            }
          : null,
        matieres: [],
        tarif_horaire: tarif?.tarif_horaire ?? null,
        heures_defaut: tarif?.heures_seance ?? 1,
        seances,
        heures_jour,
      });
    }

    prof.affectations.get(m.classeId).matieres.push({
      id: m.id,
      nom: m.nom,
    });
  }

  return Array.from(byProf.values())
    .map((prof) => ({
      ...prof,
      affectations: Array.from(prof.affectations.values()).sort((a, b) => {
        const na = `${a.classe?.niveauEtude || ''} ${a.classe?.nom || ''}`;
        const nb = `${b.classe?.niveauEtude || ''} ${b.classe?.nom || ''}`;
        return na.localeCompare(nb, 'fr');
      }),
      nb_classes: prof.affectations.size,
    }))
    .sort((a, b) => {
      const na = `${a.professeur?.nom || ''} ${a.professeur?.prenom || ''}`;
      const nb = `${b.professeur?.nom || ''} ${b.professeur?.prenom || ''}`;
      return na.localeCompare(nb, 'fr');
    });
}

module.exports = {
  parsePresenceDate,
  todayDateString,
  currentMonthKey,
  monthKeyFromDate,
  monthDateRange,
  getActiveAnneeNom,
  computeMonthlyFromPresences,
  computeProfMonthlySummary,
  buildProfesseursAffectations,
};
