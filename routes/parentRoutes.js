const express = require('express');
const { resolveParentEleve } = require('../parentPortalService');

function createParentRouter(deps) {
  const {
    prisma,
    getUserFromToken,
    getActiveAnneeNom,
    loadStudentProfile,
    buildStudentFilterOptions,
    buildStudentGrades,
    buildStudentBulletin,
    buildStudentPaymentSummary,
    isStudentUpToDate,
  } = deps;

  const router = express.Router();

  async function requireParent(req, res, next) {
    const decoded = getUserFromToken(req);
    if (!decoded || decoded.role !== 'PARENT') {
      return res.status(401).json({ error: 'Authentification parent requise.' });
    }

    const user = await prisma.utilisateur.findUnique({
      where: { id: decoded.id },
      select: { id: true, nom: true, email: true, role: true, photoUrl: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'Compte introuvable.' });
    }

    const { links, eleve, error } = await resolveParentEleve(prisma, user.id, req.query.eleve_id);

    if (!eleve) {
      return res.status(403).json({ error: error || 'Accès refusé.' });
    }

    req.parentUser = user;
    req.eleve = eleve;
    req.parentLinks = links;
    next();
  }

  router.get('/me', requireParent, async (req, res) => {
    const activeAnnee = await getActiveAnneeNom(prisma);
    const profile = await loadStudentProfile(prisma, req.eleve.id, activeAnnee);

    res.json({
      utilisateur: req.parentUser,
      enfants: req.parentLinks.map((l) => l.eleve),
      eleve_actif: req.eleve,
      eleve_id: req.eleve.id,
      inscription: profile?.inscription
        ? {
            statut: profile.inscription.statut,
            annee_scolaire: profile.inscription.annee_scolaire,
            classe: profile.classe ? { id: profile.classe.id, nom: profile.classe.nom } : null,
          }
        : null,
    });
  });

  router.get('/annees', requireParent, async (req, res) => {
    try {
      const options = await buildStudentFilterOptions(prisma, req.eleve.id);
      res.json({ ...options, eleve_id: req.eleve.id, enfants: req.parentLinks.map((l) => l.eleve) });
    } catch (error) {
      console.error('Erreur GET parent/annees:', error);
      res.status(500).json({ error: 'Erreur interne.' });
    }
  });

  router.get('/dashboard', requireParent, async (req, res) => {
    const annee_scolaire = req.query.annee_scolaire || (await getActiveAnneeNom(prisma));
    const periode = req.query.periode || 'Trimestre 1';

    try {
      const profile = await loadStudentProfile(prisma, req.eleve.id, annee_scolaire);
      const grades = await buildStudentGrades(prisma, req.eleve.id, { periode, annee_scolaire });
      const paymentSummary = await buildStudentPaymentSummary(
        prisma,
        req.eleve.id,
        annee_scolaire,
        isStudentUpToDate
      );

      const unread = await prisma.notification.count({
        where: { utilisateurId: req.parentUser.id, lu: false },
      });

      res.json({
        eleve_id: req.eleve.id,
        enfants: req.parentLinks.map((l) => l.eleve),
        annee_scolaire,
        periode,
        eleve: {
          id: req.eleve.id,
          matricule: req.eleve.matricule,
          nom: req.eleve.nom,
          prenom: req.eleve.prenom,
          photoUrl: req.eleve.photoUrl,
          statut_financier: paymentSummary?.statut_financier ?? req.eleve.statut_financier,
        },
        classe: profile?.classe
          ? { id: profile.classe.id, nom: profile.classe.nom, niveau: profile.classe.niveau }
          : paymentSummary?.classe
            ? { id: paymentSummary.classe.id, nom: paymentSummary.classe.nom, niveau: paymentSummary.classe.niveau }
            : null,
        inscription: profile?.inscription
          ? { statut: profile.inscription.statut, annee_scolaire: profile.inscription.annee_scolaire }
          : paymentSummary?.inscription || null,
        moyenneGenerale: grades.error ? null : grades.moyenneGenerale,
        rang: grades.error ? null : grades.rang,
        effectifClasse: grades.error ? null : grades.effectifClasse,
        matieresNotees: grades.error ? 0 : (grades.matieres || []).filter((m) => m.moyenne != null).length,
        totalMatieres: grades.error ? 0 : (grades.matieres || []).length,
        finances: {
          statut_financier: paymentSummary?.statut_financier ?? req.eleve.statut_financier,
          solde: paymentSummary?.solde ?? req.eleve.solde,
          annualAmount: paymentSummary?.annualAmount ?? 0,
          totalPaid: paymentSummary?.totalPaid ?? 0,
          remainingYear: paymentSummary?.remainingYear ?? 0,
          paiementAJour: paymentSummary?.paiementAJour ?? false,
        },
        notificationsNonLues: unread,
      });
    } catch (error) {
      console.error('Erreur GET parent/dashboard:', error);
      res.status(500).json({ error: 'Erreur interne.' });
    }
  });

  router.get('/notes', requireParent, async (req, res) => {
    const annee_scolaire = req.query.annee_scolaire || (await getActiveAnneeNom(prisma));
    const periode = req.query.periode || 'Trimestre 1';

    try {
      const result = await buildStudentGrades(prisma, req.eleve.id, { periode, annee_scolaire });
      if (result.error) {
        return res.status(result.status || 404).json({ error: result.error });
      }
      res.json({ ...result, eleve_id: req.eleve.id });
    } catch (error) {
      console.error('Erreur GET parent/notes:', error);
      res.status(500).json({ error: 'Erreur interne.' });
    }
  });

  router.get('/bulletin', requireParent, async (req, res) => {
    const annee_scolaire = req.query.annee_scolaire || (await getActiveAnneeNom(prisma));
    const periode = req.query.periode || 'Trimestre 1';

    try {
      const result = await buildStudentBulletin(prisma, req.eleve.id, { periode, annee_scolaire });
      if (result.error) {
        return res.status(result.status || 404).json({ error: result.error });
      }
      res.json({ ...result, eleve_id: req.eleve.id });
    } catch (error) {
      console.error('Erreur GET parent/bulletin:', error);
      res.status(500).json({ error: 'Erreur interne.' });
    }
  });

  router.get('/paiements', requireParent, async (req, res) => {
    const annee_scolaire = req.query.annee_scolaire || (await getActiveAnneeNom(prisma));

    try {
      const summary = await buildStudentPaymentSummary(
        prisma,
        req.eleve.id,
        annee_scolaire,
        isStudentUpToDate
      );

      if (!summary) {
        return res.status(404).json({ error: 'Données introuvables.' });
      }

      res.json({ ...summary, eleve_id: req.eleve.id, enfants: req.parentLinks.map((l) => l.eleve) });
    } catch (error) {
      console.error('Erreur GET parent/paiements:', error);
      res.status(500).json({ error: 'Erreur interne.' });
    }
  });

  router.get('/paiements/:id/recu', requireParent, async (req, res) => {
    const paiementId = parseInt(req.params.id, 10);
    if (Number.isNaN(paiementId)) {
      return res.status(400).json({ error: 'Identifiant invalide.' });
    }
    try {
      const { buildPaymentReceiptContext } = require('../studentPortalService');
      const owned = await prisma.paiement.findFirst({
        where: { id: paiementId, eleveId: req.eleve.id },
        select: { id: true },
      });
      if (!owned) {
        return res.status(404).json({ error: 'Paiement introuvable.' });
      }
      const recu = await buildPaymentReceiptContext(prisma, paiementId, isStudentUpToDate);
      if (!recu) {
        return res.status(404).json({ error: 'Paiement introuvable.' });
      }
      res.json({ ...recu, eleve_id: req.eleve.id });
    } catch (error) {
      console.error('Erreur GET parent/paiements/:id/recu:', error);
      res.status(500).json({ error: 'Erreur interne.' });
    }
  });

  return router;
}

module.exports = { createParentRouter };
