const GRADE_TYPES = [
  { key: 'd1', type: 'Devoir 1' },
  { key: 'd2', type: 'Devoir 2' },
  { key: 'compo', type: 'Composition' },
];

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
  const settings = await prisma.parametreSite.findUnique({ where: { id: 1 } });
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
    const admins = await prisma.utilisateur.findMany({
      where: { role: 'ADMIN' },
      select: { id: true },
    });

    admins.forEach((admin) => {
      notifications.push({
        utilisateurId: admin.id,
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

module.exports = {
  GRADE_TYPES,
  createGradeSaveNotifications,
};
