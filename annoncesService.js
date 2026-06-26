const ANNONCE_CATEGORIES = ['Info', 'Urgent', 'Événement', 'Rentrée'];

const PUBLIC_SELECT = {
  id: true,
  titre: true,
  contenu: true,
  categorie: true,
  epinglee: true,
  auteurNom: true,
  createdAt: true,
  updatedAt: true,
};

function parseAnnonceId(raw) {
  const id = parseInt(raw, 10);
  if (Number.isNaN(id)) return null;
  return id;
}

function normalizeCategory(categorie) {
  return ANNONCE_CATEGORIES.includes(categorie) ? categorie : 'Info';
}

async function unpinOthers(tx, exceptId = null) {
  const where = { epinglee: true };
  if (exceptId != null) where.id = { not: exceptId };
  await tx.annonce.updateMany({ where, data: { epinglee: false } });
}

async function listAll(prisma) {
  return prisma.annonce.findMany({
    orderBy: [{ epinglee: 'desc' }, { createdAt: 'desc' }],
  });
}

async function listPublished(prisma) {
  return prisma.annonce.findMany({
    where: { publiee: true },
    orderBy: [{ epinglee: 'desc' }, { createdAt: 'desc' }],
    select: PUBLIC_SELECT,
  });
}

async function getPublishedPinned(prisma) {
  return prisma.annonce.findFirst({
    where: { publiee: true, epinglee: true },
    orderBy: { updatedAt: 'desc' },
    select: PUBLIC_SELECT,
  });
}

async function getById(prisma, id) {
  return prisma.annonce.findUnique({ where: { id } });
}

async function createAnnonce(prisma, body, auteurFallback) {
  const { titre, contenu, categorie, publiee, epinglee, auteurNom } = body;
  if (!titre?.trim() || !contenu?.trim()) {
    const err = new Error('Titre et contenu requis.');
    err.status = 400;
    throw err;
  }

  const cat = normalizeCategory(categorie);
  const willPin = Boolean(epinglee);

  return prisma.$transaction(async (tx) => {
    if (willPin) await unpinOthers(tx);
    return tx.annonce.create({
      data: {
        titre: titre.trim(),
        contenu: contenu.trim(),
        categorie: cat,
        publiee: willPin ? true : Boolean(publiee),
        epinglee: willPin,
        auteurNom: auteurNom?.trim() || auteurFallback || null,
      },
    });
  });
}

async function updateAnnonce(prisma, id, body) {
  const { titre, contenu, categorie, publiee, epinglee, auteurNom } = body;
  if (!titre?.trim() || !contenu?.trim()) {
    const err = new Error('Titre et contenu requis.');
    err.status = 400;
    throw err;
  }

  const existing = await prisma.annonce.findUnique({ where: { id } });
  if (!existing) {
    const err = new Error('Annonce introuvable.');
    err.status = 404;
    throw err;
  }

  const cat = normalizeCategory(categorie);
  const willPin = Boolean(epinglee);

  return prisma.$transaction(async (tx) => {
    if (willPin) await unpinOthers(tx, id);
    return tx.annonce.update({
      where: { id },
      data: {
        titre: titre.trim(),
        contenu: contenu.trim(),
        categorie: cat,
        publiee: willPin ? true : Boolean(publiee),
        epinglee: willPin,
        auteurNom: auteurNom?.trim() || null,
      },
    });
  });
}

async function togglePin(prisma, id, epinglee) {
  const existing = await prisma.annonce.findUnique({ where: { id } });
  if (!existing) {
    const err = new Error('Annonce introuvable.');
    err.status = 404;
    throw err;
  }

  const pin = epinglee !== false;

  return prisma.$transaction(async (tx) => {
    if (pin) await unpinOthers(tx);
    return tx.annonce.update({
      where: { id },
      data: {
        epinglee: pin,
        ...(pin ? { publiee: true } : {}),
      },
    });
  });
}

async function deleteAnnonce(prisma, id) {
  return prisma.annonce.delete({ where: { id } });
}

module.exports = {
  ANNONCE_CATEGORIES,
  PUBLIC_SELECT,
  parseAnnonceId,
  listAll,
  listPublished,
  getPublishedPinned,
  getById,
  createAnnonce,
  updateAnnonce,
  togglePin,
  deleteAnnonce,
};
