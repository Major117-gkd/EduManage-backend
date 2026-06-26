const {
  computeGeneralAverage,
  buildMatiereResult,
  assignRanks,
} = require('./gradeUtils');
const { getRegleCalcul, buildFormulaText } = require('./gradeRules');

function pickInscription(inscriptions, annee_scolaire) {
  if (!inscriptions?.length) return null;
  const validated = inscriptions.filter((i) => i.statut === 'Validé');
  if (annee_scolaire) {
    return validated.find((i) => i.annee_scolaire === annee_scolaire) || validated[0] || null;
  }
  return validated[0] || inscriptions[0] || null;
}

async function loadStudentProfile(prisma, eleveId, annee_scolaire) {
  const eleve = await prisma.eleve.findUnique({
    where: { id: eleveId },
    include: {
      inscriptions: {
        include: { classe: { include: { anneeScolaire: true, niveauEtude: true } } },
        orderBy: { date_demande: 'desc' },
      },
      paiements: {
        where: annee_scolaire ? { annee_scolaire } : undefined,
        orderBy: { date_paiement: 'desc' },
      },
      utilisateur: { select: { id: true, email: true, nom: true, photoUrl: true } },
    },
  });

  if (!eleve) return null;

  const inscription = pickInscription(eleve.inscriptions, annee_scolaire);
  const classe = inscription?.classe || null;
  const annualAmount = classe?.montant_annuel || 0;
  const totalPaid = (eleve.paiements || []).reduce((s, p) => s + p.montant, 0);

  return {
    eleve,
    inscription,
    classe,
    annualAmount,
    totalPaid,
    remainingYear: Math.max(0, annualAmount - totalPaid),
  };
}

async function buildStudentGrades(prisma, eleveId, { periode, annee_scolaire }) {
  const profile = await loadStudentProfile(prisma, eleveId, annee_scolaire);
  if (!profile?.inscription?.classe) {
    return { error: 'Aucune inscription validée trouvée.', status: 404 };
  }

  const { eleve, inscription, classe } = profile;
  const annee = annee_scolaire || inscription.annee_scolaire;

  const classeFull = await prisma.classe.findUnique({
    where: { id: classe.id },
    include: {
      matieres: { include: { professeur: true }, orderBy: { nom: 'asc' } },
      niveauEtude: true,
    },
  });

  if (!classeFull) return { error: 'Classe introuvable.', status: 404 };

  const regle = getRegleCalcul(classeFull.niveauEtude);
  const notes = await prisma.note.findMany({
    where: {
      eleveId,
      annee_scolaire: annee,
      ...(periode ? { periode } : {}),
      matiere: { classeId: classeFull.id },
    },
    include: { matiere: true },
  });

  const matieres = classeFull.matieres.map((mat) => {
    const notesMatiere = notes.filter((n) => n.matiereId === mat.id);
    const result = buildMatiereResult(mat, notesMatiere, regle);
    return {
      id: result.id,
      nom: result.nom,
      coefficient: result.coefficient,
      professeur: result.professeur,
      d1: result.d1,
      d2: result.d2,
      compo: result.compo,
      moyenne: result.moyenne,
      appreciation: result.appreciation,
      notes: result.notes,
    };
  });

  const moyenneGenerale = computeGeneralAverage(matieres);

  const classmates = await prisma.inscription.findMany({
    where: {
      classeId: classeFull.id,
      annee_scolaire: annee,
      statut: 'Validé',
      eleve: { statut: 'Actif' },
    },
    include: {
      eleve: {
        include: {
          notes: {
            where: {
              annee_scolaire: annee,
              ...(periode ? { periode } : {}),
              matiere: { classeId: classeFull.id },
            },
          },
        },
      },
    },
  });

  const ranking = classmates.map((ins) => {
    const mats = classeFull.matieres.map((mat) => {
      const notesEleve = ins.eleve.notes.filter((n) => n.matiereId === mat.id);
      return buildMatiereResult(mat, notesEleve, regle);
    });
    return {
      eleveId: ins.eleve.id,
      moyenneGenerale: computeGeneralAverage(mats),
    };
  });

  assignRanks(ranking, (r) => r.moyenneGenerale);
  const myRank = ranking.find((r) => r.eleveId === eleveId)?.rang ?? null;

  return {
    eleve: {
      id: eleve.id,
      matricule: eleve.matricule,
      nom: eleve.nom,
      prenom: eleve.prenom,
      photoUrl: eleve.photoUrl || eleve.utilisateur?.photoUrl || null,
      statut_financier: eleve.statut_financier,
      solde: eleve.solde,
    },
    classe: {
      id: classeFull.id,
      nom: classeFull.nom,
      niveau: classeFull.niveau,
      cycle: classeFull.cycle,
    },
    annee_scolaire: annee,
    periode: periode || null,
    regleCalcul: regle,
    formules: buildFormulaText(regle),
    matieres,
    moyenneGenerale,
    rang: myRank,
    effectifClasse: classmates.length,
  };
}

async function buildStudentBulletin(prisma, eleveId, { periode, annee_scolaire }) {
  const grades = await buildStudentGrades(prisma, eleveId, { periode, annee_scolaire });
  if (grades.error) return grades;

  return {
    ...grades,
    bulletin: {
      eleveId: grades.eleve.id,
      nom: grades.eleve.nom,
      prenom: grades.eleve.prenom,
      matricule: grades.eleve.matricule,
      moyenneGenerale: grades.moyenneGenerale,
      rang: grades.rang,
      matieres: grades.matieres.map((m) => ({
        matiereId: m.id,
        matiere: m.nom,
        coefficient: m.coefficient,
        professeur: m.professeur,
        notes: m.notes,
        moyenne: m.moyenne,
      })),
    },
  };
}

const DEFAULT_PERIODES = [
  'Trimestre 1',
  'Trimestre 2',
  'Trimestre 3',
  'Semestre 1',
  'Semestre 2',
];

async function buildStudentFilterOptions(prisma, eleveId) {
  const [inscriptions, siteAnnees, activeYear, notePeriodes] = await Promise.all([
    prisma.inscription.findMany({
      where: { eleveId },
      select: { annee_scolaire: true },
      orderBy: { date_demande: 'desc' },
    }),
    prisma.anneeScolaire.findMany({ orderBy: { nom: 'desc' } }),
    prisma.anneeScolaire.findFirst({ where: { active: true } }),
    prisma.note.findMany({
      where: { eleveId },
      select: { periode: true },
      distinct: ['periode'],
    }),
  ]);

  const inscriptionAnnees = [...new Set(inscriptions.map((i) => i.annee_scolaire).filter(Boolean))];
  const siteNoms = siteAnnees.map((a) => a.nom);
  const annees = [...new Set([...siteNoms, ...inscriptionAnnees])].sort((a, b) => b.localeCompare(a, 'fr'));

  const active = activeYear?.nom || null;
  const defaultAnnee = inscriptionAnnees[0] || active || annees[0] || null;

  const fromNotes = notePeriodes.map((n) => n.periode).filter(Boolean);
  const periodes = [...new Set([...DEFAULT_PERIODES, ...fromNotes])];

  return {
    annees,
    anneeOptions: siteAnnees.map((a) => ({ id: a.id, nom: a.nom, active: a.active })),
    active,
    defaultAnnee,
    periodes,
    defaultPeriode: fromNotes[0] || DEFAULT_PERIODES[0],
  };
}

function pickInscriptionForPayments(inscriptions, annee_scolaire) {
  if (!inscriptions?.length) return null;
  const pool = annee_scolaire
    ? inscriptions.filter((i) => i.annee_scolaire === annee_scolaire)
    : inscriptions;
  if (!pool.length) return null;
  return pool.find((i) => i.statut === 'Validé') || pool[0];
}

function deriveFinancierStatut({ annualAmount, totalPaid, paiementAJour, storedStatut }) {
  if (!annualAmount || annualAmount <= 0) {
    return storedStatut || 'En attente';
  }
  if (totalPaid >= annualAmount) return 'À jour';
  if (paiementAJour) {
    if (totalPaid <= 0) return 'En attente';
    return storedStatut === 'À jour' ? 'À jour' : 'À jour partiel';
  }
  if (totalPaid > 0) return 'À jour partiel';
  return 'En retard';
}

async function buildStudentPaymentSummary(prisma, eleveId, annee_scolaire, isUpToDateFn) {
  const eleve = await prisma.eleve.findUnique({
    where: { id: eleveId },
    include: {
      inscriptions: {
        include: { classe: { include: { tranches: { orderBy: { id: 'asc' } } } } },
        orderBy: { date_demande: 'desc' },
      },
      paiements: {
        where: annee_scolaire ? { annee_scolaire } : undefined,
        orderBy: { date_paiement: 'desc' },
      },
    },
  });

  if (!eleve) return null;

  const inscription = pickInscriptionForPayments(eleve.inscriptions, annee_scolaire);
  const classe = inscription?.classe || null;
  const annualAmount = classe?.montant_annuel || 0;
  const paiements = eleve.paiements || [];
  const totalPaid = paiements.reduce((sum, p) => sum + p.montant, 0);
  const remainingYear = Math.max(0, annualAmount - totalPaid);

  let paiementAJour = false;
  if (annualAmount > 0 && typeof isUpToDateFn === 'function') {
    paiementAJour = await isUpToDateFn(eleveId, annee_scolaire);
  }

  const statut_financier = deriveFinancierStatut({
    annualAmount,
    totalPaid,
    paiementAJour,
    storedStatut: eleve.statut_financier,
  });

  return {
    annee_scolaire,
    eleve: {
      id: eleve.id,
      nom: eleve.nom,
      prenom: eleve.prenom,
      matricule: eleve.matricule,
      parent_nom: eleve.parent_nom,
      parent_telephone: eleve.parent_telephone,
      solde: eleve.solde,
      statut_financier: eleve.statut_financier,
      exception_paiement_mensuel: eleve.exception_paiement_mensuel,
    },
    inscription: inscription
      ? {
          id: inscription.id,
          statut: inscription.statut,
          annee_scolaire: inscription.annee_scolaire,
        }
      : null,
    classe: classe
      ? {
          id: classe.id,
          nom: classe.nom,
          niveau: classe.niveau,
          montant_annuel: classe.montant_annuel,
          tranches: classe.tranches || [],
        }
      : null,
    annualAmount,
    totalPaid,
    remainingYear,
    paiementAJour,
    statut_financier,
    solde: eleve.solde,
    exception_paiement_mensuel: eleve.exception_paiement_mensuel,
    paiements,
    hasFeesConfigured: annualAmount > 0,
    hasInscription: Boolean(inscription),
  };
}

async function buildPaymentReceiptContext(prisma, paiementId, isUpToDateFn) {
  const paiement = await prisma.paiement.findUnique({
    where: { id: paiementId },
    include: {
      eleve: {
        include: {
          inscriptions: {
            include: { classe: { select: { id: true, nom: true, montant_annuel: true } } },
            orderBy: { date_demande: 'desc' },
          },
        },
      },
    },
  });

  if (!paiement) return null;

  const summary = await buildStudentPaymentSummary(
    prisma,
    paiement.eleveId,
    paiement.annee_scolaire,
    isUpToDateFn
  );

  const matchingInscriptions = paiement.eleve.inscriptions.filter(
    (i) => i.annee_scolaire === paiement.annee_scolaire
  );

  const eleveInscriptions = matchingInscriptions.length
    ? matchingInscriptions
    : paiement.eleve.inscriptions.slice(0, 1);

  return {
    id: paiement.id,
    montant: paiement.montant,
    mode_paiement: paiement.mode_paiement,
    periode: paiement.periode,
    annee_scolaire: paiement.annee_scolaire,
    reference: paiement.reference,
    date_paiement: paiement.date_paiement,
    notes: paiement.notes,
    eleveId: paiement.eleveId,
    eleve: {
      id: paiement.eleve.id,
      nom: paiement.eleve.nom,
      prenom: paiement.eleve.prenom,
      matricule: paiement.eleve.matricule,
      parent_nom: paiement.eleve.parent_nom,
      parent_telephone: paiement.eleve.parent_telephone,
      inscriptions: eleveInscriptions.map((i) => ({
        ...i,
        classe: i.classe,
      })),
    },
    finances: {
      montantPaye: paiement.montant,
      modePaiement: paiement.mode_paiement,
      soldeRestant: summary?.remainingYear ?? 0,
      statutFinancier: summary?.statut_financier ?? paiement.eleve.statut_financier ?? 'En attente',
      totalPaye: summary?.totalPaid ?? 0,
      fraisAnnuels: summary?.annualAmount ?? 0,
      paiementAJour: summary?.paiementAJour ?? false,
    },
  };
}

module.exports = {
  pickInscription,
  pickInscriptionForPayments,
  loadStudentProfile,
  buildStudentGrades,
  buildStudentBulletin,
  buildStudentFilterOptions,
  buildStudentPaymentSummary,
  buildPaymentReceiptContext,
  deriveFinancierStatut,
  DEFAULT_PERIODES,
};
