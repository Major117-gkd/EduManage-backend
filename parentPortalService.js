const parentEleveSelect = {
  id: true,
  matricule: true,
  nom: true,
  prenom: true,
  photoUrl: true,
  statut: true,
  statut_financier: true,
  solde: true,
  parent_nom: true,
  parent_telephone: true,
  parent_email: true,
  infos_importantes: true,
  exception_paiement_mensuel: true,
};

async function loadParentLinks(prisma, utilisateurId) {
  return prisma.parentEleveLink.findMany({
    where: { utilisateurId },
    include: { eleve: { select: parentEleveSelect } },
    orderBy: { id: 'asc' },
  });
}

async function resolveParentEleve(prisma, parentUserId, eleveIdParam) {
  const links = await loadParentLinks(prisma, parentUserId);
  if (!links.length) {
    return { links, eleve: null, error: 'Aucun enfant lié à ce compte parent.' };
  }

  const requestedId = eleveIdParam ? parseInt(eleveIdParam, 10) : null;
  const link = requestedId
    ? links.find((l) => l.eleveId === requestedId)
    : links[0];

  if (!link) {
    return { links, eleve: null, error: 'Enfant non autorisé pour ce compte.' };
  }

  return { links, eleve: link.eleve, error: null };
}

async function linkParentToEleve(prisma, { utilisateurId, eleveId }) {
  return prisma.parentEleveLink.upsert({
    where: {
      utilisateurId_eleveId: { utilisateurId, eleveId },
    },
    create: { utilisateurId, eleveId },
    update: {},
  });
}

module.exports = {
  parentEleveSelect,
  loadParentLinks,
  resolveParentEleve,
  linkParentToEleve,
};
