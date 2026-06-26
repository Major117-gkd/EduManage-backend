const express = require('express');
const {
  parseAnnonceId,
  listAll,
  listPublished,
  getPublishedPinned,
  getById,
  createAnnonce,
  updateAnnonce,
  togglePin,
  deleteAnnonce,
} = require('../annoncesService');

function sendServiceError(res, error, label) {
  console.error(`Erreur ${label}:`, error);
  const status = error.status || 500;
  res.status(status).json({ error: error.message || 'Erreur interne.' });
}

function createAdminAnnoncesRouter(prisma) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const annonces = await listAll(prisma);
      res.json(annonces);
    } catch (error) {
      sendServiceError(res, error, 'GET admin/annonces');
    }
  });

  router.get('/:id', async (req, res) => {
    const id = parseAnnonceId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Identifiant invalide.' });
    try {
      const annonce = await getById(prisma, id);
      if (!annonce) return res.status(404).json({ error: 'Annonce introuvable.' });
      res.json(annonce);
    } catch (error) {
      sendServiceError(res, error, 'GET admin/annonces/:id');
    }
  });

  router.post('/', async (req, res) => {
    try {
      const annonce = await createAnnonce(prisma, req.body, req.authUser?.nom);
      res.status(201).json({ message: 'Annonce créée.', annonce });
    } catch (error) {
      sendServiceError(res, error, 'POST admin/annonces');
    }
  });

  router.put('/:id', async (req, res) => {
    const id = parseAnnonceId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Identifiant invalide.' });
    try {
      const annonce = await updateAnnonce(prisma, id, req.body);
      res.json({ message: 'Annonce mise à jour.', annonce });
    } catch (error) {
      sendServiceError(res, error, 'PUT admin/annonces/:id');
    }
  });

  router.patch('/:id/epingle', async (req, res) => {
    const id = parseAnnonceId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Identifiant invalide.' });
    try {
      const annonce = await togglePin(prisma, id, req.body?.epinglee);
      const epinglee = req.body?.epinglee !== false;
      res.json({
        message: epinglee ? 'Annonce épinglée en tête de page.' : 'Annonce désépinglée.',
        annonce,
      });
    } catch (error) {
      sendServiceError(res, error, 'PATCH admin/annonces/:id/epingle');
    }
  });

  router.delete('/:id', async (req, res) => {
    const id = parseAnnonceId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Identifiant invalide.' });
    try {
      await deleteAnnonce(prisma, id);
      res.json({ message: 'Annonce supprimée.' });
    } catch (error) {
      if (error.code === 'P2025') return res.status(404).json({ error: 'Annonce introuvable.' });
      sendServiceError(res, error, 'DELETE admin/annonces/:id');
    }
  });

  return router;
}

function createPublicAnnoncesRouter(prisma) {
  const router = express.Router();

  router.get('/epinglee', async (req, res) => {
    try {
      const annonce = await getPublishedPinned(prisma);
      res.json(annonce);
    } catch (error) {
      sendServiceError(res, error, 'GET public/annonces/epinglee');
    }
  });

  router.get('/', async (req, res) => {
    try {
      const annonces = await listPublished(prisma);
      res.json(annonces);
    } catch (error) {
      sendServiceError(res, error, 'GET public/annonces');
    }
  });

  return router;
}

function createAuthAnnoncesRouter(prisma) {
  const router = express.Router();

  router.get('/epinglee', async (req, res) => {
    try {
      const annonce = await getPublishedPinned(prisma);
      res.json(annonce);
    } catch (error) {
      sendServiceError(res, error, 'GET annonces/epinglee');
    }
  });

  router.get('/', async (req, res) => {
    try {
      const annonces = await listPublished(prisma);
      res.json(annonces);
    } catch (error) {
      sendServiceError(res, error, 'GET annonces');
    }
  });

  return router;
}

module.exports = {
  createAdminAnnoncesRouter,
  createPublicAnnoncesRouter,
  createAuthAnnoncesRouter,
};
