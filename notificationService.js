const GRADE_TYPES = [
  { key: 'd1', type: 'Devoir 1' },
  { key: 'd2', type: 'Devoir 2' },
  { key: 'compo', type: 'Composition' },
];

async function getAdminIds(prisma) {
  const admins = await prisma.utilisateur.findMany({
    where: { role: 'ADMIN' },
    select: { id: true },
  });
  return admins.map((a) => a.id);
}

async function getSiteSettings(prisma) {
  return prisma.parametreSite.findUnique({ where: { id: 1 } });
}

async function createGradeSaveNotifications(prisma, {
  teacher,
  matiere,
  eleve,
  periode,
  annee_scolaire,
  savedTypes = [],
  isUpdate = false,
  eleveLabel: eleveLabelOverride,
}) {
  const settings = await getSiteSettings(prisma);
  const profLabel = `${teacher.prenom} ${teacher.nom}`.trim();
  const eleveLabel = eleveLabelOverride || `${eleve.prenom} ${eleve.nom}`.trim();
  const classeLabel = matiere.classe?.nom || '—';
  const typesLabel = savedTypes.length > 0 ? savedTypes.join(', ') : 'notes';
  const actionLabel = isUpdate ? 'modifié' : 'saisi';

  const teacherUserId = teacher.utilisateurId;
  const metadata = {
    eleveId: eleve.id,
    matiereId: matiere.id,
    periode,
    annee_scolaire,
    savedTypes,
  };

  const notifications = [];

  if (teacherUserId) {
    notifications.push({
      utilisateurId: teacherUserId,
      type: 'NOTE_SAISIE',
      titre: 'Notes enregistrées',
      message: `Vous avez ${actionLabel} ${typesLabel} pour ${eleveLabel} en ${matiere.nom} (${classeLabel}) — ${periode}.`,
      lien: `/teacher/grades/${matiere.id}`,
      metadata,
    });
  }

  if (settings?.notif_notes !== false) {
    const adminIds = await getAdminIds(prisma);
    adminIds.forEach((adminId) => {
      notifications.push({
        utilisateurId: adminId,
        type: 'NOTE_SAISIE',
        titre: 'Saisie de notes',
        message: `${profLabel} a ${actionLabel} des notes (${typesLabel}) pour ${eleveLabel} en ${matiere.nom} — ${classeLabel} (${periode}).`,
        lien: '/admin/grades/consultation',
        metadata: { ...metadata, professeurId: teacher.id },
      });
    });
  }

  if (notifications.length === 0) return [];
  await prisma.notification.createMany({ data: notifications });
  return notifications;
}

async function createInscriptionNotifications(prisma, {
  event,
  eleve,
  inscription,
  classe,
}) {
  const settings = await getSiteSettings(prisma);
  if (settings?.notif_inscriptions === false) return [];

  const eleveLabel = `${eleve.prenom} ${eleve.nom}`.trim();
  const classeLabel = classe?.nom || '—';
  const annee = inscription.annee_scolaire;
  const adminIds = await getAdminIds(prisma);
  const notifications = [];

  if (event === 'nouvelle') {
    adminIds.forEach((adminId) => {
      notifications.push({
        utilisateurId: adminId,
        type: 'INSCRIPTION',
        titre: 'Nouvelle inscription en attente',
        message: `${eleveLabel} (${eleve.matricule}) demande une inscription en ${classeLabel} pour ${annee}.`,
        lien: '/admin/students?inscription_statut=En attente',
        metadata: { eleveId: eleve.id, inscriptionId: inscription.id, event },
      });
    });
  } else if (event === 'validee') {
    adminIds.forEach((adminId) => {
      notifications.push({
        utilisateurId: adminId,
        type: 'INSCRIPTION',
        titre: 'Inscription validée',
        message: `L'inscription de ${eleveLabel} en ${classeLabel} (${annee}) a été validée.`,
        lien: '/admin/students',
        metadata: { eleveId: eleve.id, inscriptionId: inscription.id, event },
      });
    });
  } else if (event === 'rejetee') {
    const motif = inscription.motif_rejet ? ` Motif : ${inscription.motif_rejet}` : '';
    adminIds.forEach((adminId) => {
      notifications.push({
        utilisateurId: adminId,
        type: 'INSCRIPTION',
        titre: 'Inscription rejetée',
        message: `L'inscription de ${eleveLabel} en ${classeLabel} (${annee}) a été rejetée.${motif}`,
        lien: '/admin/students',
        metadata: { eleveId: eleve.id, inscriptionId: inscription.id, event },
      });
    });
  }

  if (notifications.length === 0) return [];
  await prisma.notification.createMany({ data: notifications });
  return notifications;
}

async function createPaymentNotifications(prisma, { paiement, eleve }) {
  const settings = await getSiteSettings(prisma);
  if (settings?.notif_paiements === false) return [];

  const eleveLabel = `${eleve.prenom} ${eleve.nom}`.trim();
  const montant = Number(paiement.montant).toLocaleString('fr-FR');
  const metadata = {
    paiementId: paiement.id,
    eleveId: eleve.id,
    montant: paiement.montant,
    mode_paiement: paiement.mode_paiement,
    periode: paiement.periode,
    annee_scolaire: paiement.annee_scolaire,
  };

  const notifications = [];

  const adminIds = await getAdminIds(prisma);
  adminIds.forEach((adminId) => {
    notifications.push({
      utilisateurId: adminId,
      type: 'PAIEMENT',
      titre: 'Paiement enregistré',
      message: `${montant} GNF reçus de ${eleveLabel} (${paiement.mode_paiement}, ${paiement.periode} — ${paiement.annee_scolaire}).`,
      lien: '/admin/payments',
      metadata,
    });
  });

  const studentUser = await prisma.utilisateur.findFirst({
    where: { eleveId: eleve.id, role: 'ELEVE' },
    select: { id: true },
  });
  if (studentUser) {
    notifications.push({
      utilisateurId: studentUser.id,
      type: 'PAIEMENT',
      titre: 'Paiement enregistré',
      message: `Votre versement de ${montant} GNF (${paiement.mode_paiement}, ${paiement.periode}) a été enregistré pour ${paiement.annee_scolaire}.`,
      lien: '/student/paiements',
      metadata,
    });
  }

  const parentLinks = await prisma.parentEleveLink.findMany({
    where: { eleveId: eleve.id },
    select: { utilisateurId: true },
  });
  parentLinks.forEach(({ utilisateurId }) => {
    notifications.push({
      utilisateurId,
      type: 'PAIEMENT',
      titre: 'Paiement enregistré',
      message: `Un versement de ${montant} GNF a été enregistré pour ${eleveLabel} (${paiement.periode} — ${paiement.annee_scolaire}).`,
      lien: `/parent/paiements?eleve=${eleve.id}`,
      metadata,
    });
  });

  if (notifications.length === 0) return [];
  await prisma.notification.createMany({ data: notifications });
  return notifications;
}

module.exports = {
  GRADE_TYPES,
  createGradeSaveNotifications,
  createInscriptionNotifications,
  createPaymentNotifications,
};
