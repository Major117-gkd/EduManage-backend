require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const {
  computeSubjectAverageFromNotes,
  computeGeneralAverage,
  buildMatiereResult,
  assignRanks,
  assignRanksByGroup,
} = require('./gradeUtils');
const {
  DEFAULT_REGLE_CALCUL,
  CYCLES,
  normalizeRegle,
  getRegleCalcul,
  buildFormulaText,
  DEFAULT_NIVEAUX,
} = require('./gradeRules');
const { GRADE_TYPES, createGradeSaveNotifications } = require('./notificationService');
const {
  sanitizeSettingsForClient,
  sendContactEmail,
  sendTestEmail,
  sendProfessorWelcomeEmail,
} = require('./emailService');
const {
  parsePresenceDate,
  todayDateString,
  getActiveAnneeNom,
  currentMonthKey,
  monthDateRange,
  computeMonthlyFromPresences,
  computeProfMonthlySummary,
  buildProfesseursAffectations,
} = require('./teacherPayService');

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- MIDDLEWARES ---

const FULL_PAYMENT_PERIODS = ['Annuel', 'Paiement total', 'Paiement intégral'];

function isFullPaymentPeriod(periode) {
  return FULL_PAYMENT_PERIODS.some((p) => p.toLowerCase() === String(periode || '').toLowerCase());
}

async function getStudentPaymentContext(eleveId, annee_scolaire) {
  const eleve = await prisma.eleve.findUnique({
    where: { id: eleveId },
    include: {
      inscriptions: { where: { annee_scolaire }, include: { classe: true } },
      paiements: { where: { annee_scolaire }, orderBy: { date_paiement: 'desc' } },
    },
  });
  if (!eleve) return null;

  const inscription = eleve.inscriptions[0];
  const annualAmount = inscription?.classe?.montant_annuel || 0;
  const totalPaid = eleve.paiements.reduce((sum, p) => sum + p.montant, 0);
  const remainingYear = Math.max(0, annualAmount - totalPaid);

  return {
    eleve,
    annualAmount,
    totalPaid,
    remainingYear,
    monthlyAmount: annualAmount > 0 ? annualAmount / 9 : 0,
  };
}

function computeExpectedPaymentAmount({ periode, montant, eleve, annualAmount, totalPaid }) {
  if (montant !== undefined && montant !== null && montant !== '') {
    return parseFloat(montant);
  }

  if (annualAmount <= 0) return 0;

  const monthlyAmount = annualAmount / 9;
  const remainingYear = Math.max(0, annualAmount - totalPaid);

  if (periode === 'Annuel') {
    return annualAmount;
  }
  if (periode === 'Paiement total' || periode === 'Paiement intégral') {
    return remainingYear > 0 ? remainingYear : annualAmount;
  }

  if (eleve.exception_paiement_mensuel) {
    return monthlyAmount;
  }
  return monthlyAmount * 3;
}

// Helper function to check if a student is "up to date" with payments
const isStudentUpToDate = async (eleveId, annee_scolaire, extraPayment = 0) => {
  try {
    const eleve = await prisma.eleve.findUnique({
      where: { id: eleveId },
      include: {
        inscriptions: {
          where: { annee_scolaire },
          include: { classe: true }
        },
        paiements: {
          where: { annee_scolaire },
          orderBy: { date_paiement: 'desc' }
        }
      }
    });

    if (!eleve) return false;

    // Get the current month (1-12)
    const currentMonth = new Date().getMonth() + 1;

    // Determine which tranche we're in (based on 9-month school year)
    // School year typically: September (9) to May (5)
    // Tranche 1: Sept-Oct-Nov (9,10,11)
    // Tranche 2: Dec-Jan-Feb (12,1,2)
    // Tranche 3: Mar-Apr-May (3,4,5)
    let currentTranche, trancheMonths;
    if (currentMonth >= 9) {
      currentTranche = 1;
      trancheMonths = [9, 10, 11];
    } else if (currentMonth >= 6) {
      // Summer months - no school
      return true;
    } else if (currentMonth >= 3) {
      currentTranche = 3;
      trancheMonths = [3, 4, 5];
    } else if (currentMonth >= 1) {
      currentTranche = 2;
      trancheMonths = [12, 1, 2];
    } else {
      return true;
    }

    // Get the student's class to determine annual amount
    const inscription = eleve.inscriptions[0];
    if (!inscription) return false;

    const annualAmount = inscription.classe.montant_annuel || 0;
    if (annualAmount === 0) return true; // No fees configured

    const totalPaidYear = eleve.paiements.reduce((sum, p) => sum + p.montant, 0) + extraPayment;
    if (totalPaidYear >= annualAmount) return true;

    // Calculate monthly amount (9-month school year)
    const monthlyAmount = annualAmount / 9;

    // Calculate expected payment for current period
    let expectedAmount = 0;

    if (eleve.exception_paiement_mensuel) {
      // Monthly payment exception: only need current month
      expectedAmount = monthlyAmount;
    } else {
      // Default: need to pay the entire tranche (3 months)
      expectedAmount = monthlyAmount * trancheMonths.length;
    }

    // Calculate total paid for the current period
    const paidAmount = eleve.paiements.reduce((sum, p) => {
      const paymentMonth = new Date(p.date_paiement).getMonth() + 1;
      if (eleve.exception_paiement_mensuel) {
        return paymentMonth === currentMonth ? sum + p.montant : sum;
      }
      return trancheMonths.includes(paymentMonth) ? sum + p.montant : sum;
    }, 0) + extraPayment;

    // Student is up to date if they've paid the expected amount
    return paidAmount >= expectedAmount;
  } catch (error) {
    console.error('Error checking payment status:', error);
    return false;
  }
};

// Middleware to verify payment status before accessing grades
const checkPaymentStatus = async (req, res, next) => {
  try {
    // Skip payment check for admins and teachers
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
      if (decoded.role === 'ADMIN' || decoded.role === 'PROFESSEUR') {
        return next();
      }
    }

    // For students/parents, check payment status
    const { eleveId } = req.params;
    const { eleveId: queryEleveId } = req.query;
    const { eleveId: bodyEleveId } = req.body || {};
    const { annee_scolaire } = req.query;

    const targetEleveId = eleveId || queryEleveId || bodyEleveId;

    if (!targetEleveId) {
      return next(); // No student ID provided, skip check
    }

    // Use the new helper function to check if student is up to date
    const currentYear = annee_scolaire || '2024-2025';
    const isUpToDate = await isStudentUpToDate(parseInt(targetEleveId), currentYear);

    if (!isUpToDate) {
      const eleve = await prisma.eleve.findUnique({
        where: { id: parseInt(targetEleveId) },
        select: { exception_paiement_mensuel: true }
      });

      const periodType = eleve?.exception_paiement_mensuel ? 'mensualité' : 'tranche de 3 mois';
      
      return res.status(403).json({
        error: 'Accès refusé',
        message: `Veuillez régler votre ${periodType} en cours pour accéder à vos notes`,
        exception_paiement_mensuel: eleve?.exception_paiement_mensuel || false
      });
    }

    next();
  } catch (error) {
    console.error('Erreur vérification statut paiement:', error);
    // If there's an error (e.g., invalid token), allow access to avoid blocking legitimate requests
    next();
  }
};

// --- AUTH HELPERS ---

function getUserFromToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.slice(7);
    return jwt.verify(token, process.env.JWT_SECRET || 'secret');
  } catch {
    return null;
  }
}

async function requireAuth(req, res, next) {
  const decoded = getUserFromToken(req);
  if (!decoded) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }
  req.authUser = decoded;
  next();
}

async function requireAdmin(req, res, next) {
  const decoded = getUserFromToken(req);
  if (!decoded || decoded.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Accès administrateur requis.' });
  }
  req.authUser = decoded;
  next();
}

function resolveUserPhotoUrl(user, professeur) {
  return user?.photoUrl || professeur?.photoUrl || null;
}

function withUserPhoto(user, professeur) {
  if (!user) return user;
  return { ...user, photoUrl: resolveUserPhotoUrl(user, professeur) };
}

function formatProfesseurForClient(prof) {
  if (!prof) return prof;
  const photoUrl = resolveUserPhotoUrl(prof.utilisateur, prof);
  return {
    ...prof,
    photoUrl,
    utilisateur: prof.utilisateur
      ? { ...prof.utilisateur, photoUrl }
      : prof.utilisateur,
  };
}

const SCHOOL_FOUNDING_YEAR = 1998;

async function computeSchoolSuccessRate() {
  const activeYear = await prisma.anneeScolaire.findFirst({ where: { active: true } });
  const anneeScolaire = activeYear?.nom || null;

  let reussite = 0;
  let evaluables = 0;

  for (const niveau of CYCLES) {
    const inscriptions = await prisma.inscription.findMany({
      where: {
        statut: 'Validé',
        eleve: { statut: 'Actif' },
        classe: { cycle: niveau },
        ...(anneeScolaire ? { annee_scolaire: anneeScolaire } : {}),
      },
      include: {
        eleve: {
          include: {
            notes: {
              where: {
                ...(anneeScolaire ? { annee_scolaire: anneeScolaire } : {}),
              },
            },
          },
        },
        classe: {
          include: {
            matieres: { orderBy: { nom: 'asc' } },
            niveauEtude: true,
          },
        },
      },
    });

    for (const ins of inscriptions) {
      const regle = getRegleCalcul(ins.classe.niveauEtude);
      const matieres = ins.classe.matieres.map((mat) => {
        const notesMatiere = ins.eleve.notes.filter((n) => n.matiereId === mat.id);
        return buildMatiereResult(mat, notesMatiere, regle);
      });
      const moyenneGenerale = computeGeneralAverage(matieres);
      if (moyenneGenerale === null) continue;

      evaluables++;
      if (moyenneGenerale >= regle.seuilReussite) reussite++;
    }
  }

  return {
    tauxReussite: evaluables > 0 ? Math.round((reussite / evaluables) * 100) : null,
    evaluables,
    anneeScolaire,
  };
}

// Statistiques publiques (page d'accueil — sans authentification)
app.get('/api/public/stats', async (req, res) => {
  try {
    const [eleves, professeurs, classes, totalEleves, cyclesRows, successData] = await Promise.all([
      prisma.eleve.count({ where: { statut: 'Actif' } }),
      prisma.professeur.count(),
      prisma.classe.count(),
      prisma.eleve.count(),
      prisma.classe.findMany({ select: { cycle: true }, distinct: ['cycle'] }),
      computeSchoolSuccessRate(),
    ]);

    const anneesExperience = Math.max(1, new Date().getFullYear() - SCHOOL_FOUNDING_YEAR);

    res.json({
      eleves,
      professeurs,
      classes,
      totalEleves,
      cyclesScolaires: cyclesRows.filter((c) => c.cycle).length || 3,
      tauxReussite: successData.tauxReussite,
      anneesExperience,
      anneeScolaire: successData.anneeScolaire,
    });
  } catch (error) {
    console.error('Erreur GET /api/public/stats:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Professeurs : accès limité à /api/teacher/* et /api/me uniquement
app.use('/api/admin', requireAdmin);
app.use('/api/paiements', requireAdmin);

// --- ROUTES ---

// ══════════════════════════════════════════════
//  USER MANAGEMENT ROUTES
// ══════════════════════════════════════════════

// List all users
app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await prisma.utilisateur.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, nom: true, email: true, role: true, createdAt: true, photoUrl: true,
        professeur: { select: { id: true, specialite: true, contact: true, photoUrl: true } }
      }
    });
    const usersWithPhoto = users.map((u) => {
      const { professeur, ...rest } = u;
      return { ...rest, photoUrl: resolveUserPhotoUrl(rest, professeur), professeur };
    });
    res.json(usersWithPhoto);
  } catch (error) {
    console.error('Erreur liste utilisateurs:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Update user info (nom, email, photoUrl)
app.put('/api/admin/users/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { nom, email, photoUrl } = req.body;
  try {
    const updated = await prisma.utilisateur.update({
      where: { id },
      data: {
        ...(nom?.trim() ? { nom: nom.trim() } : {}),
        ...(email?.trim() ? { email: email.trim().toLowerCase() } : {}),
        ...(photoUrl !== undefined ? { photoUrl: photoUrl || null } : {}),
      },
      select: { id: true, nom: true, email: true, role: true, createdAt: true, photoUrl: true }
    });
    // Synchroniser la photo sur le profil professeur si applicable
    if (photoUrl !== undefined) {
      await prisma.professeur.updateMany({
        where: { utilisateurId: id },
        data: { photoUrl: photoUrl || null }
      }).catch(() => {});
    }
    res.json({ message: 'Utilisateur mis à jour.', user: updated });
  } catch (error) {
    console.error('Erreur mise à jour utilisateur:', error);
    if (error.code === 'P2002') return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Change password for a user
app.put('/api/admin/users/:id/password', async (req, res) => {
  const id = parseInt(req.params.id);
  const { nouveau_mot_de_passe } = req.body;
  if (!nouveau_mot_de_passe || nouveau_mot_de_passe.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit avoir au moins 6 caractères.' });
  }
  try {
    const hashed = await bcrypt.hash(nouveau_mot_de_passe, 10);
    await prisma.utilisateur.update({ where: { id }, data: { mot_de_passe: hashed } });
    res.json({ message: 'Mot de passe mis à jour avec succès.' });
  } catch (error) {
    console.error('Erreur changement mot de passe:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Delete a user
app.delete('/api/admin/users/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await prisma.utilisateur.delete({ where: { id } });
    res.json({ message: 'Utilisateur supprimé.' });
  } catch (error) {
    console.error('Erreur suppression utilisateur:', error);
    res.status(500).json({ error: 'Erreur interne (peut-être un compte lié à un professeur).' });
  }
});


// Route de connexion
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  try {
    // 1. Chercher l'utilisateur par e-mail
    const user = await prisma.utilisateur.findUnique({
      where: { email },
    });

    if (!user) {
      return res.status(401).json({ error: 'Identifiants incorrects.' });
    }

    // 2. Vérifier le mot de passe
    const isPasswordValid = await bcrypt.compare(password, user.mot_de_passe);
    
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Identifiants incorrects.' });
    }

    // 3. Générer le JWT
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '24h' }
    );

    // 4. Renvoyer le token et les infos
    let professeur = null;
    if (user.role === 'PROFESSEUR') {
      professeur = await prisma.professeur.findFirst({
        where: { utilisateurId: user.id },
        select: { photoUrl: true },
      });
    }
    const userRow = await prisma.utilisateur.findUnique({
      where: { id: user.id },
      select: { id: true, nom: true, email: true, role: true, photoUrl: true },
    });

    res.json({
      message: 'Connexion réussie',
      token,
      user: withUserPhoto(userRow, professeur),
    });

  } catch (error) {
    console.error("Erreur login:", error);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// --- COMPTE CONNECTÉ (tous rôles authentifiés) ---

async function getOrCreateSiteSettings() {
  let settings = await prisma.parametreSite.findUnique({ where: { id: 1 } });
  if (!settings) {
    settings = await prisma.parametreSite.create({ data: { id: 1 } });
  }
  return settings;
}

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.utilisateur.findUnique({
      where: { id: req.authUser.id },
      select: { id: true, nom: true, email: true, role: true, createdAt: true, photoUrl: true },
    });
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    let professeur = null;
    if (user.role === 'PROFESSEUR') {
      professeur = await prisma.professeur.findFirst({
        where: { utilisateurId: user.id },
        select: { id: true, nom: true, prenom: true, specialite: true, contact: true, photoUrl: true },
      });
    }

    res.json({ user: withUserPhoto(user, professeur), professeur });
  } catch (error) {
    console.error('Erreur GET /api/me:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.put('/api/me', requireAuth, async (req, res) => {
  const { nom, email, prenom, specialite, contact, photoUrl } = req.body;

  try {
    const existing = await prisma.utilisateur.findUnique({ where: { id: req.authUser.id } });
    if (!existing) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    await prisma.$transaction(async (tx) => {
      if (existing.role === 'PROFESSEUR') {
        const prof = await tx.professeur.findFirst({ where: { utilisateurId: existing.id } });
        if (prof) {
          await tx.professeur.update({
            where: { id: prof.id },
            data: {
              ...(prenom?.trim() ? { prenom: prenom.trim() } : {}),
              ...(nom?.trim() ? { nom: nom.trim() } : {}),
              ...(specialite !== undefined ? { specialite: specialite?.trim() || null } : {}),
              ...(contact !== undefined ? { contact: contact?.trim() || null } : {}),
              ...(photoUrl !== undefined ? { photoUrl: photoUrl || null } : {}),
            },
          });

          const displayNom = prenom?.trim() && nom?.trim()
            ? `${prenom.trim()} ${nom.trim()}`
            : (nom?.trim() || existing.nom);

          await tx.utilisateur.update({
            where: { id: existing.id },
            data: {
              nom: displayNom,
              ...(email?.trim() ? { email: email.trim().toLowerCase() } : {}),
              ...(photoUrl !== undefined ? { photoUrl: photoUrl || null } : {}),
            },
          });
        }
      } else {
        await tx.utilisateur.update({
          where: { id: existing.id },
          data: {
            ...(nom?.trim() ? { nom: nom.trim() } : {}),
            ...(email?.trim() ? { email: email.trim().toLowerCase() } : {}),
            ...(photoUrl !== undefined ? { photoUrl: photoUrl || null } : {}),
          },
        });
      }
    });

    const user = await prisma.utilisateur.findUnique({
      where: { id: existing.id },
      select: { id: true, nom: true, email: true, role: true, createdAt: true, photoUrl: true },
    });

    let professeur = null;
    if (user.role === 'PROFESSEUR') {
      professeur = await prisma.professeur.findFirst({
        where: { utilisateurId: user.id },
        select: { id: true, nom: true, prenom: true, specialite: true, contact: true, photoUrl: true },
      });
    }

    res.json({ message: 'Profil mis à jour.', user: withUserPhoto(user, professeur), professeur });
  } catch (error) {
    console.error('Erreur PUT /api/me:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
    }
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.put('/api/me/password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe requis.' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit avoir au moins 6 caractères.' });
  }

  try {
    const user = await prisma.utilisateur.findUnique({ where: { id: req.authUser.id } });
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    const valid = await bcrypt.compare(current_password, user.mot_de_passe);
    if (!valid) {
      return res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await prisma.utilisateur.update({
      where: { id: user.id },
      data: { mot_de_passe: hashed },
    });

    res.json({ message: 'Mot de passe mis à jour avec succès.' });
  } catch (error) {
    console.error('Erreur changement mot de passe:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// --- NOTIFICATIONS ---
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const statut = req.query.statut;
    const type = req.query.type;

    const where = { utilisateurId: req.authUser.id };
    if (statut === 'unread') where.lu = false;
    else if (statut === 'read') where.lu = true;
    if (type) where.type = type;

    const [items, unreadCount, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.notification.count({
        where: { utilisateurId: req.authUser.id, lu: false },
      }),
      prisma.notification.count({ where }),
    ]);

    res.json({
      notifications: items,
      unreadCount,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error('Erreur GET notifications:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.patch('/api/notifications/:id/read', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const notif = await prisma.notification.findFirst({
      where: { id, utilisateurId: req.authUser.id },
    });
    if (!notif) return res.status(404).json({ error: 'Notification introuvable.' });
    const updated = await prisma.notification.update({
      where: { id },
      data: { lu: true },
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.patch('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { utilisateurId: req.authUser.id, lu: false },
      data: { lu: true },
    });
    res.json({ message: 'Toutes les notifications ont été marquées comme lues.' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.get('/api/admin/site-settings', async (req, res) => {
  try {
    const settings = await getOrCreateSiteSettings();
    const activeYear = await prisma.anneeScolaire.findFirst({ where: { active: true } });
    res.json({
      settings: sanitizeSettingsForClient(settings),
      activeYear: activeYear?.nom || null,
    });
  } catch (error) {
    console.error('Erreur GET site-settings:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.put('/api/admin/site-settings', async (req, res) => {
  const {
    nom_ecole, adresse, telephone, email_contact, devise,
    notif_inscriptions, notif_paiements, notif_notes, message_accueil,
    mail_enabled, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_app_password,
  } = req.body;

  try {
    const passwordProvided = smtp_app_password
      && String(smtp_app_password).trim()
      && String(smtp_app_password).trim() !== '********';

    const settings = await prisma.parametreSite.update({
      where: { id: 1 },
      data: {
        ...(nom_ecole !== undefined ? { nom_ecole: nom_ecole?.trim() || '' } : {}),
        ...(adresse !== undefined ? { adresse: adresse?.trim() || null } : {}),
        ...(telephone !== undefined ? { telephone: telephone?.trim() || null } : {}),
        ...(email_contact !== undefined ? { email_contact: email_contact?.trim() || null } : {}),
        ...(devise !== undefined ? { devise: devise?.trim() || 'GNF' } : {}),
        ...(notif_inscriptions !== undefined ? { notif_inscriptions: Boolean(notif_inscriptions) } : {}),
        ...(notif_paiements !== undefined ? { notif_paiements: Boolean(notif_paiements) } : {}),
        ...(notif_notes !== undefined ? { notif_notes: Boolean(notif_notes) } : {}),
        ...(message_accueil !== undefined ? { message_accueil: message_accueil?.trim() || null } : {}),
        ...(mail_enabled !== undefined ? { mail_enabled: Boolean(mail_enabled) } : {}),
        ...(smtp_host !== undefined ? { smtp_host: smtp_host?.trim() || 'smtp.gmail.com' } : {}),
        ...(smtp_port !== undefined ? { smtp_port: Number(smtp_port) || 587 } : {}),
        ...(smtp_secure !== undefined ? { smtp_secure: Boolean(smtp_secure) } : {}),
        ...(smtp_user !== undefined ? { smtp_user: smtp_user?.trim() || null } : {}),
        ...(passwordProvided ? { smtp_app_password: String(smtp_app_password).trim() } : {}),
      },
    });
    res.json({
      message: 'Configuration du site enregistrée.',
      settings: sanitizeSettingsForClient(settings),
    });
  } catch (error) {
    console.error('Erreur PUT site-settings:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.post('/api/admin/email/test', async (req, res) => {
  const { to } = req.body || {};
  try {
    const result = await sendTestEmail(prisma, to?.trim() || null);
    if (!result.ok) {
      return res.status(400).json({ error: result.error, details: result.details });
    }
    res.json({ message: 'E-mail de test envoyé avec succès.', messageId: result.messageId });
  } catch (error) {
    console.error('Erreur test e-mail:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Infos publiques de l'établissement (page d'accueil)
app.get('/api/public/site-info', async (req, res) => {
  try {
    const settings = await getOrCreateSiteSettings();
    res.json({
      nom_ecole: settings.nom_ecole,
      adresse: settings.adresse,
      telephone: settings.telephone,
      email_contact: settings.email_contact,
      message_accueil: settings.message_accueil,
    });
  } catch (error) {
    console.error('Erreur GET /api/public/site-info:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Formulaire de contact public (page d'accueil)
app.post('/api/public/contact', async (req, res) => {
  const { nom, email, message } = req.body || {};
  if (!nom?.trim() || !email?.trim() || !message?.trim()) {
    return res.status(400).json({ error: 'Nom, e-mail et message sont requis.' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  }

  try {
    const result = await sendContactEmail(prisma, {
      nom: nom.trim(),
      email: email.trim().toLowerCase(),
      message: message.trim(),
    });
    if (!result.ok) {
      return res.status(503).json({ error: result.error, details: result.details });
    }
    res.json({ message: 'Votre message a bien été envoyé. Nous vous répondrons rapidement.' });
  } catch (error) {
    console.error('Erreur contact public:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// --- ADMIN ROUTES ---

// LIST all classes (for dropdown in modal)

// LIST all Professeurs
// Synchronise les affectations : un professeur peut avoir plusieurs cours indépendants
// (ex. Maths en classe A + Physique en classe B, ou Anglais dans plusieurs classes).
async function syncProfesseurMatieres(tx, professeurId, matieresIds) {
  if (!Array.isArray(matieresIds)) return;

  await tx.matiere.updateMany({
    where: { professeurId },
    data: { professeurId: null },
  });

  if (matieresIds.length > 0) {
    const ids = matieresIds.map((id) => parseInt(id, 10)).filter((id) => !Number.isNaN(id));
    await tx.matiere.updateMany({
      where: { id: { in: ids } },
      data: { professeurId },
    });
  }
}

const professeurMatieresInclude = {
  matieres: {
    include: { classe: true },
    orderBy: [{ nom: 'asc' }, { classeId: 'asc' }],
  },
};

app.get('/api/admin/professeurs', async (req, res) => {
  try {
    const profs = await prisma.professeur.findMany({
      orderBy: { nom: 'asc' },
      include: {
        utilisateur: { select: { id: true, email: true, nom: true, role: true, createdAt: true, photoUrl: true } },
        ...professeurMatieresInclude,
      },
    });
    res.json(profs.map(formatProfesseurForClient));
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});



const ELEVE_STATUTS = ['Actif', 'Abandon', 'Transféré', 'Exclu', 'Inactif'];

function isEleveScolairementActif(statut) {
  return statut === 'Actif';
}

function normalizeEleveStatutData(statut, { motif_abandon, date_abandon } = {}) {
  if (!ELEVE_STATUTS.includes(statut)) {
    return { error: `Statut invalide. Valeurs acceptées : ${ELEVE_STATUTS.filter((s) => s !== 'Inactif').join(', ')}` };
  }

  const normalized = statut === 'Inactif' ? 'Abandon' : statut;
  const data = { statut: normalized };

  if (normalized === 'Actif') {
    data.date_abandon = null;
    data.motif_abandon = null;
  } else {
    data.motif_abandon = motif_abandon?.trim() || null;
    data.date_abandon = date_abandon ? new Date(date_abandon) : new Date();
  }

  return { data };
}

// LIST all Eleves (filtres optionnels)
app.get('/api/admin/eleves', async (req, res) => {
  const {
    show_inactive,
    statut,
    statut_financier,
    classe_id,
    niveau,
    annee_scolaire,
    inscription_statut,
    search,
  } = req.query;

  try {
    const where = {};
    if (statut) {
      where.statut = statut;
    } else if (show_inactive !== 'true') {
      where.statut = 'Actif';
    }
    if (statut_financier) {
      where.statut_financier = statut_financier;
    }

    let eleves = await prisma.eleve.findMany({
      where,
      orderBy: [{ nom: 'asc' }, { prenom: 'asc' }],
      include: {
        inscriptions: {
          include: { classe: true },
          orderBy: { date_demande: 'desc' },
        },
      },
    });

    const classeId = classe_id ? parseInt(classe_id, 10) : null;

    eleves = eleves.filter((eleve) => {
      const inscriptions = eleve.inscriptions || [];

      if (classeId || niveau || annee_scolaire || inscription_statut) {
        const hasMatch = inscriptions.some((ins) => {
          if (classeId && ins.classeId !== classeId) return false;
          if (annee_scolaire && ins.annee_scolaire !== annee_scolaire) return false;
          if (inscription_statut && ins.statut !== inscription_statut) return false;
          if (niveau && ins.classe?.niveau !== niveau) return false;
          return true;
        });
        if (!hasMatch) return false;
      }

      if (search?.trim()) {
        const q = search.trim().toLowerCase();
        const haystack = [
          eleve.prenom,
          eleve.nom,
          eleve.matricule,
          eleve.parent_nom,
          eleve.parent_telephone,
          eleve.parent_email,
          eleve.adresse,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }

      return true;
    });

    res.json(eleves);
  } catch (error) {
    console.error('Erreur GET eleves:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// CREATE a new Eleve and his Inscription
app.post('/api/admin/eleves', async (req, res) => {
  const { nom, prenom, date_naissance, adresse, parent_nom, parent_telephone, parent_email, filiation, infos_importantes, classeId, annee_scolaire, matricule, photoUrl, exception_paiement_mensuel } = req.body;
  try {
    // Generate a unique matricule if not provided
    const count = await prisma.eleve.count();
    const finalMatricule = matricule ? matricule : `GSP-${String(count + 1).padStart(4, '0')}`;

    const eleve = await prisma.$transaction(async (tx) => {
      const newEleve = await tx.eleve.create({
        data: { 
          matricule: finalMatricule, 
          nom, 
          prenom, 
          date_naissance: date_naissance ? new Date(date_naissance) : null, 
          adresse, 
          parent_nom, 
          parent_telephone, 
          parent_email, 
          filiation, 
          infos_importantes, 
          photoUrl,
          exception_paiement_mensuel: exception_paiement_mensuel || false
        }
      });
      await tx.inscription.create({
        data: {
          eleveId: newEleve.id,
          classeId: parseInt(classeId),
          annee_scolaire: annee_scolaire || '2024-2025',
          statut: 'En attente'
        }
      });
      return newEleve;
    });

    res.json({ message: 'Élève inscrit avec succès', eleve });
  } catch (error) {
    console.error('Erreur création élève:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// UPDATE an Eleve
app.put('/api/admin/eleves/:id', async (req, res) => {
  const {
    prenom, nom, date_naissance, adresse, parent_nom, filiation, parent_telephone, parent_email,
    infos_importantes, photoUrl, exception_paiement_mensuel, statut, motif_abandon, date_abandon,
  } = req.body;
  const eleveId = parseInt(req.params.id);
  try {
    const data = {
      prenom,
      nom,
      date_naissance: date_naissance ? new Date(date_naissance) : null,
      adresse,
      parent_nom,
      filiation,
      parent_telephone,
      parent_email,
      infos_importantes,
      photoUrl,
      exception_paiement_mensuel: exception_paiement_mensuel !== undefined ? exception_paiement_mensuel : undefined,
    };

    if (statut !== undefined) {
      const statutUpdate = normalizeEleveStatutData(statut, { motif_abandon, date_abandon });
      if (statutUpdate.error) {
        return res.status(400).json({ error: statutUpdate.error });
      }
      Object.assign(data, statutUpdate.data);
    }

    const eleve = await prisma.eleve.update({
      where: { id: eleveId },
      data,
      include: {
        inscriptions: { include: { classe: true }, orderBy: { date_demande: 'desc' } },
      },
    });
    res.json({ message: 'Élève mis à jour avec succès', eleve });
  } catch (error) {
    console.error('Erreur mise à jour élève:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Modifier uniquement le statut scolaire d'un élève
app.put('/api/admin/eleves/:id/statut', async (req, res) => {
  const eleveId = parseInt(req.params.id);
  const { statut, motif_abandon, date_abandon } = req.body;

  if (!statut) {
    return res.status(400).json({ error: 'Le statut est requis.' });
  }

  try {
    const existing = await prisma.eleve.findUnique({ where: { id: eleveId } });
    if (!existing) {
      return res.status(404).json({ error: 'Élève introuvable.' });
    }

    const statutUpdate = normalizeEleveStatutData(statut, { motif_abandon, date_abandon });
    if (statutUpdate.error) {
      return res.status(400).json({ error: statutUpdate.error });
    }

    const eleve = await prisma.eleve.update({
      where: { id: eleveId },
      data: statutUpdate.data,
      include: {
        inscriptions: { include: { classe: true }, orderBy: { date_demande: 'desc' } },
      },
    });

    res.json({
      message: statutUpdate.data.statut === 'Actif'
        ? 'Élève réactivé avec succès.'
        : `Statut mis à jour : ${statutUpdate.data.statut}`,
      eleve,
    });
  } catch (error) {
    console.error('Erreur mise à jour statut élève:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// DELETE (soft delete) an Eleve — marque comme abandon
app.delete('/api/admin/eleves/:id', async (req, res) => {
  const eleveId = parseInt(req.params.id);
  const { motif_abandon, date_abandon } = req.body || {};
  try {
    const statutUpdate = normalizeEleveStatutData('Abandon', { motif_abandon, date_abandon });
    await prisma.eleve.update({
      where: { id: eleveId },
      data: statutUpdate.data,
    });
    res.json({ message: 'Élève marqué comme abandon avec succès' });
  } catch (error) {
    console.error('Erreur désactivation élève:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// CREATE a Re-registration (nouvelle inscription pour un élève existant)
app.post('/api/admin/eleves/:id/reinscription', async (req, res) => {
  const { classeId, annee_scolaire } = req.body;
  const eleveId = parseInt(req.params.id);
  try {
    // Check student's balance before allowing re-registration
    const eleve = await prisma.eleve.findUnique({
      where: { id: eleveId },
      select: { solde: true, nom: true, prenom: true }
    });

    if (!eleve) {
      return res.status(404).json({ error: 'Élève non trouvé' });
    }

    // Block re-registration if student has outstanding debt
    if (eleve.solde > 0) {
      return res.status(403).json({
        error: 'Dette non soldée',
        message: `Impossible de réinscrire cet élève : dette de l'année précédente non soldée (${eleve.solde.toLocaleString()} FCFA)`,
        solde: eleve.solde
      });
    }

    const inscription = await prisma.inscription.create({
      data: {
        eleveId,
        classeId: parseInt(classeId),
        annee_scolaire: annee_scolaire,
        statut: 'En attente'
      }
    });

    await prisma.eleve.update({
      where: { id: eleveId },
      data: { statut: 'Actif', date_abandon: null, motif_abandon: null },
    });

    res.json({ message: 'Réinscription réussie', inscription });
  } catch (error) {
    console.error('Erreur réinscription:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// VALIDATE an Inscription
app.put('/api/admin/inscriptions/:id/valider', async (req, res) => {
  const inscriptionId = parseInt(req.params.id);
  try {
    const inscription = await prisma.inscription.update({
      where: { id: inscriptionId },
      data: { statut: 'Validé' }
    });
    res.json({ message: 'Inscription validée avec succès', inscription });
  } catch (error) {
    console.error('Erreur validation inscription:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// --- ANNEES SCOLAIRES ROUTES ---

app.get('/api/admin/annees', async (req, res) => {
  try {
    const annees = await prisma.anneeScolaire.findMany({ orderBy: { nom: 'desc' } });
    res.json(annees);
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.post('/api/admin/annees', async (req, res) => {
  const { nom } = req.body;
  try {
    const annee = await prisma.anneeScolaire.create({ data: { nom } });
    res.json({ message: 'Année scolaire créée', annee });
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne (peut-être un doublon).' });
  }
});

app.put('/api/admin/annees/:id/active', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await prisma.$transaction([
      prisma.anneeScolaire.updateMany({ data: { active: false } }),
      prisma.anneeScolaire.update({ where: { id }, data: { active: true } })
    ]);
    res.json({ message: 'Année active mise à jour' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// --- CLASSES ROUTES ---

async function ensureDefaultNiveaux() {
  const count = await prisma.niveauEtude.count();
  if (count > 0) return;
  for (const item of DEFAULT_NIVEAUX) {
    await prisma.niveauEtude.create({
      data: {
        nom: item.nom,
        cycle: item.cycle,
        ordre: item.ordre,
        regleCalcul: DEFAULT_REGLE_CALCUL,
      },
    });
  }
}

async function linkClassesToNiveaux() {
  const niveaux = await prisma.niveauEtude.findMany();
  for (const n of niveaux) {
    await prisma.classe.updateMany({
      where: { niveau: n.nom, niveauEtudeId: null },
      data: { niveauEtudeId: n.id, cycle: n.cycle },
    });
  }
}

async function resolveClasseNiveauFields(body) {
  const { niveau, cycle, niveauEtudeId } = body;
  if (niveauEtudeId) {
    const ne = await prisma.niveauEtude.findUnique({
      where: { id: parseInt(niveauEtudeId, 10) },
    });
    if (!ne) throw new Error('Niveau d\'étude introuvable.');
    return { niveau: ne.nom, cycle: ne.cycle, niveauEtudeId: ne.id };
  }
  if (!niveau?.trim()) throw new Error('Le niveau d\'étude est obligatoire.');
  return {
    niveau: niveau.trim(),
    cycle: cycle || 'Collège',
    niveauEtudeId: null,
  };
}

function validateClasseMatieres(matieres) {
  if (!matieres || !Array.isArray(matieres)) {
    return { error: 'Au moins une matière est obligatoire pour une classe.' };
  }

  const partial = matieres.filter((m) => {
    const hasNom = Boolean(m.nom?.trim());
    const hasProf = Boolean(m.professeurId);
    return (hasNom && !hasProf) || (!hasNom && hasProf);
  });
  if (partial.length > 0) {
    return { error: 'Chaque matière doit avoir un nom et un professeur assigné.' };
  }

  const valid = matieres
    .map((m) => ({
      id: m.id,
      nom: m.nom?.trim(),
      coefficient: parseFloat(m.coefficient) || 1,
      professeurId: m.professeurId ? parseInt(m.professeurId, 10) : null,
    }))
    .filter((m) => m.nom);

  if (valid.length === 0) {
    return { error: 'Ajoutez au moins une matière avec un nom.' };
  }

  const sansProf = valid.filter((m) => !m.professeurId);
  if (sansProf.length > 0) {
    const noms = sansProf.map((m) => `« ${m.nom} »`).join(', ');
    return { error: `Chaque matière doit avoir un professeur assigné : ${noms}.` };
  }

  return { matieres: valid };
}

function validateMatierePayload(body) {
  const { nom, coefficient, professeurId, classeId } = body;

  if (!classeId) {
    return { error: 'La classe est obligatoire pour affecter une matière.' };
  }
  if (!nom?.trim()) {
    return { error: 'Le nom de la matière est requis.' };
  }
  if (!professeurId) {
    return { error: 'Un professeur doit être assigné à la matière.' };
  }

  return {
    data: {
      nom: nom.trim(),
      coefficient: parseFloat(coefficient) || 1,
      professeurId: parseInt(professeurId, 10),
      classeId: parseInt(classeId, 10),
    },
  };
}

function serializeNiveau(niveau) {
  const regle = getRegleCalcul(niveau);
  return {
    ...niveau,
    regleCalcul: regle,
    formules: buildFormulaText(regle),
  };
}

// --- NIVEAUX D'ÉTUDE ---
app.get('/api/niveaux', async (req, res) => {
  try {
    await ensureDefaultNiveaux();
    await linkClassesToNiveaux();
    const niveaux = await prisma.niveauEtude.findMany({
      where: { actif: true },
      orderBy: [{ cycle: 'asc' }, { ordre: 'asc' }, { nom: 'asc' }],
      include: { _count: { select: { classes: true } } },
    });
    res.json(niveaux.map(serializeNiveau));
  } catch (error) {
    console.error('Erreur GET /api/niveaux:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.get('/api/admin/niveaux', async (req, res) => {
  try {
    await ensureDefaultNiveaux();
    await linkClassesToNiveaux();
    const niveaux = await prisma.niveauEtude.findMany({
      orderBy: [{ cycle: 'asc' }, { ordre: 'asc' }, { nom: 'asc' }],
      include: { _count: { select: { classes: true } } },
    });
    res.json(niveaux.map(serializeNiveau));
  } catch (error) {
    console.error('Erreur GET admin/niveaux:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.post('/api/admin/niveaux', async (req, res) => {
  const { nom, cycle, ordre, actif, regleCalcul, description } = req.body;
  if (!nom?.trim()) return res.status(400).json({ error: 'Le nom du niveau est requis.' });
  if (!cycle || !CYCLES.includes(cycle)) {
    return res.status(400).json({ error: 'Cycle invalide (Primaire, Collège ou Lycée).' });
  }
  try {
    const niveau = await prisma.niveauEtude.create({
      data: {
        nom: nom.trim(),
        cycle,
        ordre: parseInt(ordre, 10) || 0,
        actif: actif !== false,
        regleCalcul: normalizeRegle(regleCalcul),
        description: description?.trim() || null,
      },
      include: { _count: { select: { classes: true } } },
    });
    res.json(serializeNiveau(niveau));
  } catch (error) {
    console.error('Erreur POST admin/niveaux:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Ce niveau existe déjà.' });
    }
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.put('/api/admin/niveaux/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { nom, cycle, ordre, actif, regleCalcul, description } = req.body;
  try {
    const existing = await prisma.niveauEtude.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Niveau introuvable.' });

    const niveau = await prisma.niveauEtude.update({
      where: { id },
      data: {
        ...(nom?.trim() ? { nom: nom.trim() } : {}),
        ...(cycle && CYCLES.includes(cycle) ? { cycle } : {}),
        ...(ordre !== undefined ? { ordre: parseInt(ordre, 10) || 0 } : {}),
        ...(actif !== undefined ? { actif: Boolean(actif) } : {}),
        ...(regleCalcul !== undefined ? { regleCalcul: normalizeRegle(regleCalcul) } : {}),
        ...(description !== undefined ? { description: description?.trim() || null } : {}),
      },
      include: { _count: { select: { classes: true } } },
    });

    if (nom?.trim() && nom.trim() !== existing.nom) {
      await prisma.classe.updateMany({
        where: { niveauEtudeId: id },
        data: { niveau: nom.trim() },
      });
    }

    res.json(serializeNiveau(niveau));
  } catch (error) {
    console.error('Erreur PUT admin/niveaux:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Ce nom de niveau est déjà utilisé.' });
    }
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.delete('/api/admin/niveaux/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const linked = await prisma.classe.count({ where: { niveauEtudeId: id } });
    if (linked > 0) {
      return res.status(400).json({
        error: `Impossible de supprimer : ${linked} classe(s) utilisent ce niveau.`,
      });
    }
    await prisma.niveauEtude.delete({ where: { id } });
    res.json({ message: 'Niveau supprimé.' });
  } catch (error) {
    console.error('Erreur DELETE admin/niveaux:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.get('/api/admin/classes', async (req, res) => {
  try {
    const classes = await prisma.classe.findMany({
      include: {
        anneeScolaire: true,
        niveauEtude: true,
        tranches: true,
        matieres: {
          include: { professeur: true },
          orderBy: { nom: 'asc' },
        },
      },
    });
    res.json(classes);
  } catch (error) {
    console.error("Erreur récupération classes:", error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.post('/api/admin/classes', async (req, res) => {
  const { nom, capacite, montant_annuel, anneeScolaireId, tranches, matieres } = req.body;
  try {
    const matieresCheck = validateClasseMatieres(matieres);
    if (matieresCheck.error) {
      return res.status(400).json({ error: matieresCheck.error });
    }

    const niveauFields = await resolveClasseNiveauFields(req.body);
    const newClass = await prisma.classe.create({
      data: {
        nom,
        ...niveauFields,
        capacite: parseInt(capacite) || 30,
        montant_annuel: parseFloat(montant_annuel) || 0,
        anneeScolaireId: anneeScolaireId ? parseInt(anneeScolaireId) : null,
        tranches: {
          create: tranches && Array.isArray(tranches) ? tranches.map(t => ({
            nom: t.nom,
            montant: parseFloat(t.montant) || 0,
            date_limite: t.date_limite ? new Date(t.date_limite) : null
          })) : []
        },
        matieres: {
          create: matieresCheck.matieres.map((m) => ({
            nom: m.nom,
            coefficient: m.coefficient,
            professeurId: m.professeurId,
          })),
        },
      },
      include: { tranches: true, matieres: { include: { professeur: true } }, niveauEtude: true }
    });
    res.json(newClass);
  } catch (error) {
    console.error("Erreur création classe:", error);
    const msg = error.message?.includes('Niveau') || error.message?.includes('niveau')
      ? error.message
      : 'Erreur interne.';
    res.status(error.message?.includes('obligatoire') ? 400 : 500).json({ error: msg });
  }
});
app.put('/api/admin/classes/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { nom, capacite, montant_annuel, anneeScolaireId, tranches, matieres } = req.body;
  try {
    const niveauFields = await resolveClasseNiveauFields(req.body);

    let matieresValides = null;
    if (matieres !== undefined) {
      const matieresCheck = validateClasseMatieres(matieres);
      if (matieresCheck.error) {
        return res.status(400).json({ error: matieresCheck.error });
      }
      matieresValides = matieresCheck.matieres;
    }

    const updatedClass = await prisma.$transaction(async (tx) => {
      if (tranches !== undefined && Array.isArray(tranches)) {
        await tx.trancheClasse.deleteMany({ where: { classeId: id } });
      }

      if (matieresValides !== null) {
        const existing = await tx.matiere.findMany({ where: { classeId: id } });
        const incomingIds = matieresValides
          .filter((m) => m.id)
          .map((m) => parseInt(m.id, 10));

        for (const ex of existing) {
          if (!incomingIds.includes(ex.id)) {
            const noteCount = await tx.note.count({ where: { matiereId: ex.id } });
            if (noteCount > 0) {
              throw new Error(`Impossible de supprimer « ${ex.nom} » : des notes existent déjà.`);
            }
            await tx.matiere.delete({ where: { id: ex.id } });
          }
        }

        for (const m of matieresValides) {
          const data = {
            nom: m.nom,
            coefficient: m.coefficient,
            professeurId: m.professeurId,
            classeId: id,
          };
          if (m.id) {
            await tx.matiere.update({
              where: { id: parseInt(m.id, 10) },
              data,
            });
          } else {
            await tx.matiere.create({ data });
          }
        }
      }

      return tx.classe.update({
        where: { id },
        data: {
          nom,
          ...niveauFields,
          capacite: capacite ? parseInt(capacite) : undefined,
          montant_annuel: montant_annuel !== undefined ? parseFloat(montant_annuel) : undefined,
          anneeScolaireId: anneeScolaireId ? parseInt(anneeScolaireId) : null,
          ...(tranches !== undefined && Array.isArray(tranches) && {
            tranches: {
              create: tranches.map(t => ({
                nom: t.nom,
                montant: parseFloat(t.montant) || 0,
                date_limite: t.date_limite ? new Date(t.date_limite) : null
              }))
            }
          })
        },
        include: {
          tranches: true,
          matieres: { include: { professeur: true }, orderBy: { nom: 'asc' } },
          niveauEtude: true,
        },
      });
    });
    res.json(updatedClass);
  } catch (error) {
    console.error("Erreur mise à jour classe:", error);
    const msg = error.message?.includes('Impossible de supprimer')
      ? error.message
      : error.message?.includes('Niveau') || error.message?.includes('niveau')
        ? error.message
        : 'Erreur interne.';
    res.status(error.message?.includes('obligatoire') || error.message?.includes('introuvable') ? 400 : 500).json({ error: msg });
  }
});

app.delete('/api/admin/classes/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await prisma.classe.delete({ where: { id } });
    res.json({ message: 'Classe supprimée' });
  } catch (error) {
    console.error("Erreur suppression classe:", error);
    res.status(500).json({ error: 'Erreur interne (peut-être des élèves inscrits ?).' });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const totalEleves = await prisma.eleve.count({
      where: { statut: 'Actif' }
    });
    const totalProfesseurs = await prisma.professeur.count();
    const totalClasses = await prisma.classe.count();
    const inscriptionsAttente = await prisma.inscription.count({
      where: { statut: 'En attente' }
    });

    res.json({
      eleves: totalEleves,
      professeurs: totalProfesseurs,
      classes: totalClasses,
      inscriptionsEnAttente: inscriptionsAttente
    });
  } catch (error) {
    console.error("Erreur admin stats:", error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.get('/api/admin/chart-data', async (req, res) => {
  try {
    const classes = await prisma.classe.findMany({
      include: {
        _count: {
          select: { inscriptions: true }
        }
      }
    });

    const levelCounts = { 'Primaire': 0, 'Collège': 0, 'Lycée': 0 };
    classes.forEach(c => {
      if (levelCounts[c.cycle] !== undefined) {
        levelCounts[c.cycle] += c._count.inscriptions;
      }
    });
    
    const studentsPerLevel = Object.keys(levelCounts).map(name => ({
      name,
      eleves: levelCounts[name]
    }));

    const inscriptionsList = await prisma.inscription.findMany({
      select: { date_demande: true }
    });

    const monthNames = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];
    const trendMap = {};
    const today = new Date();
    
    // Initialize the last 6 months
    for (let i = 5; i >= 0; i--) {
      const monthIndex = (today.getMonth() - i + 12) % 12;
      trendMap[monthNames[monthIndex]] = 0;
    }

    inscriptionsList.forEach(ins => {
      const date = new Date(ins.date_demande);
      const diffTime = today - date;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
      
      // If within the last ~180 days
      if (diffDays >= 0 && diffDays <= 185) {
        const mName = monthNames[date.getMonth()];
        if (trendMap[mName] !== undefined) {
          trendMap[mName]++;
        }
      }
    });

    const enrollmentsTrend = Object.keys(trendMap).map(key => ({
      name: key,
      inscriptions: trendMap[key]
    }));

    res.json({ studentsPerLevel, enrollmentsTrend });
  } catch (error) {
    console.error("Erreur chart data:", error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Recent Registrations
app.get('/api/admin/recent-registrations', async (req, res) => {
  try {
    const recent = await prisma.inscription.findMany({
      take: 5,
      orderBy: { date_demande: 'desc' },
      include: { eleve: true, classe: true }
    });
    
    // Map data for frontend
    const mapped = recent.map(r => ({
      id: `INS-00${r.id}`,
      name: `${r.eleve.prenom} ${r.eleve.nom}`,
      grade: r.classe.nom,
      date: r.date_demande.toLocaleDateString('fr-FR'),
      status: r.statut
    }));

    res.json(mapped);
  } catch (error) {
    console.error("Erreur admin recent:", error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// ═══════════════════════════════════════════════
//  MATIÈRES (Subjects) ROUTES
// ═══════════════════════════════════════════════

// Get all subjects
app.get('/api/admin/matieres', async (req, res) => {
  try {
    const matieres = await prisma.matiere.findMany({
      include: { professeur: true, classe: true },
      orderBy: { nom: 'asc' }
    });
    res.json(matieres);
  } catch (e) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Get all subjects for a class
app.get('/api/admin/classes/:id/matieres', async (req, res) => {
  const classeId = parseInt(req.params.id);
  try {
    const matieres = await prisma.matiere.findMany({
      where: { classeId },
      include: { professeur: true, classe: true },
      orderBy: { nom: 'asc' },
    });
    res.json(matieres);
  } catch (e) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Create a subject for a specific class
app.post('/api/admin/classes/:id/matieres', async (req, res) => {
  const classeId = parseInt(req.params.id);
  const check = validateMatierePayload({ ...req.body, classeId });
  if (check.error) {
    return res.status(400).json({ error: check.error });
  }

  try {
    const classe = await prisma.classe.findUnique({ where: { id: classeId } });
    if (!classe) return res.status(404).json({ error: 'Classe introuvable.' });

    const m = await prisma.matiere.create({
      data: {
        ...check.data,
        classeId,
      },
      include: { professeur: true, classe: true },
    });
    res.json(m);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Create a subject (classe obligatoire)
app.post('/api/admin/matieres', async (req, res) => {
  const check = validateMatierePayload(req.body);
  if (check.error) {
    return res.status(400).json({ error: check.error });
  }

  try {
    const m = await prisma.matiere.create({
      data: check.data,
      include: { professeur: true, classe: true },
    });
    res.json(m);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Update a subject
app.put('/api/admin/matieres/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const check = validateMatierePayload(req.body);
  if (check.error) {
    return res.status(400).json({ error: check.error });
  }

  try {
    const m = await prisma.matiere.update({
      where: { id },
      data: check.data,
      include: { professeur: true, classe: true },
    });
    res.json(m);
  } catch (e) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Delete a subject
app.delete('/api/admin/matieres/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await prisma.matiere.delete({ where: { id } });
    res.json({ message: 'Matière supprimée' });
  } catch (e) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// ═══════════════════════════════════════════════
//  NOTES (Grades) ROUTES
// ═══════════════════════════════════════════════

// Get students of a class with their notes for a subject
app.get('/api/admin/classes/:classeId/matieres/:matiereId/notes', checkPaymentStatus, async (req, res) => {
  const classeId = parseInt(req.params.classeId);
  const matiereId = parseInt(req.params.matiereId);
  const { periode, annee_scolaire } = req.query;

  try {
    // Get all validated students in this class
    const inscriptions = await prisma.inscription.findMany({
      where: {
        classeId,
        statut: 'Validé',
        eleve: { statut: 'Actif' },
        ...(annee_scolaire ? { annee_scolaire } : {})
      },
      include: {
        eleve: {
          include: {
            notes: {
              where: {
                matiereId,
                ...(periode ? { periode } : {}),
                ...(annee_scolaire ? { annee_scolaire } : {})
              }
            }
          }
        }
      },
      orderBy: { eleve: { nom: 'asc' } }
    });

    const result = [];
    const seen = new Set();
    for (const ins of inscriptions) {
      if (!seen.has(ins.eleve.id)) {
        seen.add(ins.eleve.id);
        result.push({
          eleveId: ins.eleve.id,
          nom: ins.eleve.nom,
          prenom: ins.eleve.prenom,
          matricule: ins.eleve.matricule,
          notes: ins.eleve.notes
        });
      }
    }

    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Save or update a note — réservé aux professeurs (admin : consultation seule)
app.post('/api/admin/notes', async (req, res) => {
  res.status(403).json({
    error: 'La saisie des notes est réservée au professeur de la matière. Utilisez l\'espace professeur ou la consultation en lecture seule.',
  });
});

// Delete a note — réservé aux professeurs
app.delete('/api/admin/notes/:id', async (req, res) => {
  res.status(403).json({
    error: 'La suppression des notes est réservée au professeur de la matière.',
  });
});

// ═══════════════════════════════════════════════
//  CONSULTATION (Read-only grades overview)
// ═══════════════════════════════════════════════

app.get('/api/admin/notes/consultation', checkPaymentStatus, async (req, res) => {
  const { annee_scolaire, periode, classeId, niveau } = req.query;

  try {
    const inscriptions = await prisma.inscription.findMany({
      where: {
        statut: 'Validé',
        eleve: { statut: 'Actif' },
        ...(annee_scolaire ? { annee_scolaire } : {}),
        ...(classeId ? { classeId: parseInt(classeId) } : {}),
        ...(niveau ? { classe: { niveau } } : {}),
      },
      include: {
        eleve: {
          include: {
            notes: {
              where: {
                ...(periode ? { periode } : {}),
                ...(annee_scolaire ? { annee_scolaire } : {}),
              },
            },
          },
        },
        classe: {
          include: {
            matieres: { orderBy: { nom: 'asc' } },
            niveauEtude: true,
          },
        },
      },
      orderBy: [{ classe: { nom: 'asc' } }, { eleve: { nom: 'asc' } }],
    });

    const eleves = inscriptions.map((ins) => {
      const regle = getRegleCalcul(ins.classe.niveauEtude);
      const matieres = ins.classe.matieres.map((mat) => {
        const notesMatiere = ins.eleve.notes.filter((n) => n.matiereId === mat.id);
        const result = buildMatiereResult(mat, notesMatiere, regle);
        return {
          id: result.id,
          nom: result.nom,
          coefficient: result.coefficient,
          d1: result.d1,
          d2: result.d2,
          compo: result.compo,
          moyenne: result.moyenne,
          appreciation: result.appreciation,
        };
      });

      const moyenneGenerale = computeGeneralAverage(matieres);

      return {
        eleveId: ins.eleve.id,
        matricule: ins.eleve.matricule,
        nom: ins.eleve.nom,
        prenom: ins.eleve.prenom,
        classeId: ins.classe.id,
        classe: ins.classe.nom,
        niveau: ins.classe.niveau,
        annee_scolaire: ins.annee_scolaire,
        matieres,
        moyenneGenerale,
        rang: null,
      };
    });

    assignRanksByGroup(eleves, 'classeId', (e) => e.moyenneGenerale);

    res.json({
      total: eleves.length,
      eleves,
    });
  } catch (error) {
    console.error('Erreur consultation notes:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// ═══════════════════════════════════════════════
//  RESULTATS (Results / Bulletins) ROUTES
// ═══════════════════════════════════════════════

// Get full results for a class (bulletin data)
app.get('/api/admin/classes/:id/bulletins', checkPaymentStatus, async (req, res) => {
  const classeId = parseInt(req.params.id);
  const { periode } = req.query;

  try {
    const classe = await prisma.classe.findUnique({
      where: { id: classeId },
      include: {
        matieres: { include: { professeur: true } },
        niveauEtude: true,
      },
    });

    if (!classe) return res.status(404).json({ error: 'Classe introuvable' });

    const regle = getRegleCalcul(classe.niveauEtude);
    const formules = buildFormulaText(regle);

    const inscriptions = await prisma.inscription.findMany({
      where: { classeId, statut: 'Validé', eleve: { statut: 'Actif' } },
      include: {
        eleve: {
          select: {
            id: true,
            nom: true,
            prenom: true,
            matricule: true,
            solde: true,
            statut_financier: true,
            notes: {
              where: {
                ...(periode ? { periode } : {}),
                matiere: { classeId }
              },
              include: { matiere: true }
            }
          }
        }
      },
      orderBy: { eleve: { nom: 'asc' } }
    });

    const bulletins = inscriptions.map(ins => {
      const eleve = ins.eleve;
      const notesParMatiere = classe.matieres.map(mat => {
        const notesEleve = eleve.notes.filter(n => n.matiereId === mat.id);
        return buildMatiereResult(mat, notesEleve, regle);
      });

      const moyenneGenerale = computeGeneralAverage(notesParMatiere);

      return {
        eleveId: eleve.id,
        nom: eleve.nom,
        prenom: eleve.prenom,
        matricule: eleve.matricule,
        solde: eleve.solde,
        statut_financier: eleve.statut_financier,
        matieres: notesParMatiere,
        moyenneGenerale,
        rang: null,
      };
    });

    assignRanks(bulletins, (b) => b.moyenneGenerale);

    res.json({
      classe: classe.nom,
      niveau: classe.niveau,
      regleCalcul: regle,
      formules,
      matiereCount: classe.matieres.length,
      matieres: classe.matieres.map((m) => ({ id: m.id, nom: m.nom, coefficient: m.coefficient })),
      bulletins,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// View Class Results (ADMIN ONLY)
app.get('/api/admin/classes/:id/results', async (req, res) => {
  // Check admin role here in real app
  const classeId = parseInt(req.params.id);
  
  try {
    const classe = await prisma.classe.findUnique({
      where: { id: classeId },
      include: { niveauEtude: true },
    });
    const regle = getRegleCalcul(classe?.niveauEtude);

    const inscriptions = await prisma.inscription.findMany({
      where: { classeId, statut: 'Validé', eleve: { statut: 'Actif' } },
      include: {
        eleve: {
          include: {
            notes: {
              include: { matiere: true }
            }
          }
        }
      }
    });

    const resultats = inscriptions.map(ins => {
      const notesParMatiere = {};
      ins.eleve.notes.forEach((n) => {
        if (!notesParMatiere[n.matiereId]) notesParMatiere[n.matiereId] = [];
        notesParMatiere[n.matiereId].push(n);
      });

      const matieres = Object.values(notesParMatiere).map((notes) => {
        const matiere = notes[0].matiere;
        return {
          coefficient: matiere.coefficient,
          moyenne: computeSubjectAverageFromNotes(notes, regle),
        };
      });

      const moyenneValue = computeGeneralAverage(matieres);
      const moyenne = moyenneValue !== null ? moyenneValue.toFixed(2) : 'N/A';

      return {
        eleve: `${ins.eleve.prenom} ${ins.eleve.nom}`,
        moyenne,
        details: ins.eleve.notes.map(n => ({
          matiere: n.matiere.nom,
          note: n.valeur,
          appreciation: n.appreciation
        }))
      };
    });

    res.json({ classeId, resultats });
  } catch (error) {
    console.error("Erreur admin resultats:", error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Add a Teacher (creates Utilisateur + Professeur)
app.post('/api/admin/professeurs', async (req, res) => {
  const { nom, prenom, email, specialite, contact, matieresIds, mot_de_passe, photoUrl } = req.body;

  if (!nom?.trim() || !prenom?.trim() || !email?.trim()) {
    return res.status(400).json({ error: 'Nom, prénom et email sont requis.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const existingUser = await prisma.utilisateur.findUnique({
      where: { email: normalizedEmail },
    });
    if (existingUser) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
    }

    const tempPassword = mot_de_passe?.trim() || 'Prof2024';
    const plainPassword = mot_de_passe?.trim() || tempPassword;
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const professeur = await prisma.$transaction(async (tx) => {
      const user = await tx.utilisateur.create({
        data: {
          nom: `${prenom.trim()} ${nom.trim()}`,
          email: normalizedEmail,
          mot_de_passe: hashedPassword,
          role: 'PROFESSEUR',
          photoUrl: photoUrl || null,
        },
      });

      const prof = await tx.professeur.create({
        data: {
          utilisateurId: user.id,
          nom: nom.trim(),
          prenom: prenom.trim(),
          specialite: specialite?.trim() || null,
          contact: contact?.trim() || null,
          photoUrl: photoUrl || null,
        },
      });

      if (matieresIds && matieresIds.length > 0) {
        await tx.matiere.updateMany({
          where: { id: { in: matieresIds.map((id) => parseInt(id, 10)) } },
          data: { professeurId: prof.id },
        });
      }

      return tx.professeur.findUnique({
        where: { id: prof.id },
        include: {
          utilisateur: { select: { id: true, email: true, nom: true, role: true, createdAt: true, photoUrl: true } },
          ...professeurMatieresInclude,
        },
      });
    });

    const emailResult = await sendProfessorWelcomeEmail(prisma, {
      professeur,
      email: normalizedEmail,
      password: plainPassword,
    });

    res.status(201).json({
      message: 'Professeur et compte utilisateur créés avec succès.',
      professeur: formatProfesseurForClient(professeur),
      utilisateur: professeur.utilisateur,
      motDePasseTemporaire: mot_de_passe ? undefined : tempPassword,
      emailSent: emailResult.ok,
      emailError: emailResult.ok ? undefined : emailResult.error,
    });
  } catch (error) {
    console.error('Erreur création prof:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
    }
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Update Teacher profile
app.put('/api/admin/professeurs/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { nom, prenom, specialite, contact, matieresIds, photoUrl } = req.body;

  if (!nom?.trim() || !prenom?.trim()) {
    return res.status(400).json({ error: 'Nom et prénom sont requis.' });
  }

  try {
    const existing = await prisma.professeur.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Professeur introuvable.' });
    }

    const professeur = await prisma.$transaction(async (tx) => {
      await tx.professeur.update({
        where: { id },
        data: {
          nom: nom.trim(),
          prenom: prenom.trim(),
          specialite: specialite?.trim() || null,
          contact: contact?.trim() || null,
          ...(photoUrl !== undefined ? { photoUrl: photoUrl || null } : {}),
        },
      });

      await tx.utilisateur.update({
        where: { id: existing.utilisateurId },
        data: {
          nom: `${prenom.trim()} ${nom.trim()}`,
          ...(photoUrl !== undefined ? { photoUrl: photoUrl || null } : {}),
        },
      });

      await syncProfesseurMatieres(tx, id, matieresIds);

      const updated = await tx.professeur.findUnique({
        where: { id },
        include: {
          utilisateur: { select: { id: true, email: true, nom: true, role: true, createdAt: true, photoUrl: true } },
          ...professeurMatieresInclude,
        },
      });
      return updated;
    });

    res.json({ message: 'Professeur mis à jour avec succès.', professeur: formatProfesseurForClient(professeur) });
  } catch (error) {
    console.error('Erreur mise à jour prof:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Update Teacher's subject assignments
app.put('/api/admin/professeurs/:id/affectations', async (req, res) => {
  const id = parseInt(req.params.id);
  const { matieresIds } = req.body;
  
  try {
    await prisma.$transaction(async (tx) => {
      await syncProfesseurMatieres(tx, id, matieresIds || []);
    });
    res.json({ message: 'Affectations mises à jour' });
  } catch (error) {
    console.error("Erreur mise à jour affectations:", error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.delete('/api/admin/professeurs/:id', async (req, res) => {
  const id = parseInt(req.params.id);

  try {
    const prof = await prisma.professeur.findUnique({ where: { id } });
    if (!prof) {
      return res.status(404).json({ error: 'Professeur introuvable.' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.matiere.updateMany({
        where: { professeurId: id },
        data: { professeurId: null },
      });
      await tx.professeur.delete({ where: { id } });
      await tx.utilisateur.delete({ where: { id: prof.utilisateurId } });
    });

    res.json({ message: 'Professeur et compte utilisateur supprimés.' });
  } catch (error) {
    console.error('Erreur suppression prof:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// ══════════════════════════════════════════════
//  RÉMUNÉRATION PROFESSEURS (tarifs + présences)
// ══════════════════════════════════════════════

app.get('/api/admin/tarifs-horaires', async (req, res) => {
  try {
    const classes = await prisma.classe.findMany({
      include: {
        niveauEtude: true,
        tarifHoraire: true,
      },
      orderBy: [{ niveauEtude: { ordre: 'asc' } }, { nom: 'asc' }],
    });

    res.json(classes.map((c) => ({
      id: c.id,
      nom: c.nom,
      niveau: c.niveau,
      niveauEtude: c.niveauEtude
        ? { id: c.niveauEtude.id, nom: c.niveauEtude.nom, cycle: c.niveauEtude.cycle }
        : null,
      tarif_horaire: c.tarifHoraire?.tarif_horaire ?? null,
      heures_seance: c.tarifHoraire?.heures_seance ?? 1,
    })));
  } catch (error) {
    console.error('Erreur GET tarifs-horaires:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.put('/api/admin/tarifs-horaires/:classeId', async (req, res) => {
  const classeId = parseInt(req.params.classeId);
  const { tarif_horaire, heures_seance } = req.body;

  if (!Number.isFinite(classeId)) {
    return res.status(400).json({ error: 'Classe invalide.' });
  }
  const tarif = parseFloat(tarif_horaire);
  const heures = heures_seance != null ? parseFloat(heures_seance) : 1;

  if (!Number.isFinite(tarif) || tarif < 0) {
    return res.status(400).json({ error: 'Tarif horaire invalide.' });
  }
  if (!Number.isFinite(heures) || heures <= 0) {
    return res.status(400).json({ error: 'Nombre d\'heures par séance invalide.' });
  }

  try {
    const classe = await prisma.classe.findUnique({ where: { id: classeId } });
    if (!classe) {
      return res.status(404).json({ error: 'Classe introuvable.' });
    }

    const saved = await prisma.tarifHoraireClasse.upsert({
      where: { classeId },
      create: { classeId, tarif_horaire: tarif, heures_seance: heures },
      update: { tarif_horaire: tarif, heures_seance: heures },
    });

    res.json(saved);
  } catch (error) {
    console.error('Erreur PUT tarifs-horaires:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.get('/api/admin/presences-professeurs', async (req, res) => {
  const dateStr = req.query.date || todayDateString();
  const date = parsePresenceDate(dateStr);
  if (!date) {
    return res.status(400).json({ error: 'Date invalide (format AAAA-MM-JJ).' });
  }

  try {
    const anneeNom = await getActiveAnneeNom(prisma);
    const matieres = await prisma.matiere.findMany({
      where: {
        professeurId: { not: null },
        classeId: { not: null },
      },
      include: {
        professeur: { select: { id: true, nom: true, prenom: true } },
        classe: {
          include: {
            niveauEtude: true,
            tarifHoraire: true,
          },
        },
      },
      orderBy: [
        { professeur: { nom: 'asc' } },
        { professeur: { prenom: 'asc' } },
        { nom: 'asc' },
      ],
    });

    const presences = await prisma.presenceProfesseur.findMany({
      where: { date_presence: date },
    });

    const professeurs = buildProfesseursAffectations(matieres, presences);
    const heures_jour = presences.reduce((s, p) => s + p.nombre_heures, 0);

    res.json({
      date: dateStr,
      annee_scolaire: anneeNom,
      professeurs,
      heures_jour,
      presences_count: presences.length,
    });
  } catch (error) {
    console.error('Erreur GET presences-professeurs:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.post('/api/admin/presences-professeurs', async (req, res) => {
  const { professeurId, classeId, matiereId, nombre_heures: heuresBody, date: dateStr } = req.body;
  const profId = parseInt(professeurId);
  const classeIdNum = classeId != null ? parseInt(classeId, 10) : null;
  const matId = matiereId != null ? parseInt(matiereId, 10) : null;
  const date = parsePresenceDate(dateStr || todayDateString());

  if (!Number.isFinite(profId) || !date) {
    return res.status(400).json({ error: 'Données invalides.' });
  }
  if (!Number.isFinite(classeIdNum) && !Number.isFinite(matId)) {
    return res.status(400).json({ error: 'Indiquez la classe ou la matière.' });
  }

  try {
    const anneeNom = await getActiveAnneeNom(prisma);
    if (!anneeNom) {
      return res.status(400).json({ error: 'Aucune année scolaire active.' });
    }

    const matiereWhere = Number.isFinite(classeIdNum)
      ? { professeurId: profId, classeId: classeIdNum }
      : { id: matId, professeurId: profId, classeId: { not: null } };

    const matiere = await prisma.matiere.findFirst({
      where: matiereWhere,
      include: { classe: { include: { tarifHoraire: true, niveauEtude: true } } },
      orderBy: { id: 'asc' },
    });

    if (!matiere) {
      return res.status(404).json({ error: 'Affectation introuvable pour ce professeur et cette classe.' });
    }

    const tarif = matiere.classe?.tarifHoraire;
    if (!tarif) {
      return res.status(400).json({
        error: `Aucun tarif horaire défini pour la classe ${matiere.classe.nom}. Configurez-le d'abord.`,
      });
    }

    const heuresParsed = heuresBody != null && heuresBody !== ''
      ? parseFloat(heuresBody)
      : tarif.heures_seance;
    if (!Number.isFinite(heuresParsed) || heuresParsed <= 0) {
      return res.status(400).json({ error: 'Nombre d\'heures invalide (doit être > 0).' });
    }

    const presence = await prisma.presenceProfesseur.create({
      data: {
        professeurId: profId,
        matiereId: matiere.id,
        classeId: matiere.classeId,
        date_presence: date,
        nombre_heures: heuresParsed,
        tarif_horaire: tarif.tarif_horaire,
        montant: 0,
        annee_scolaire: anneeNom,
        enregistre_par: req.authUser?.id || null,
      },
      include: {
        classe: { select: { id: true, nom: true, niveau: true } },
      },
    });

    res.status(201).json({
      ...presence,
      message: `Passage enregistré : ${heuresParsed}h pour ${matiere.classe.nom}.`,
    });
  } catch (error) {
    console.error('Erreur POST presences-professeurs:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.put('/api/admin/presences-professeurs/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const heuresParsed = parseFloat(req.body.nombre_heures);

  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Identifiant invalide.' });
  }
  if (!Number.isFinite(heuresParsed) || heuresParsed <= 0) {
    return res.status(400).json({ error: 'Nombre d\'heures invalide (doit être > 0).' });
  }

  try {
    const presence = await prisma.presenceProfesseur.update({
      where: { id },
      data: { nombre_heures: heuresParsed },
    });
    res.json({
      ...presence,
      message: `Heures mises à jour : ${heuresParsed}h.`,
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Passage introuvable.' });
    }
    console.error('Erreur PUT presences-professeurs:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.delete('/api/admin/presences-professeurs/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Identifiant invalide.' });
  }

  try {
    await prisma.presenceProfesseur.delete({ where: { id } });
    res.json({ message: 'Passage supprimé.' });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Présence introuvable.' });
    }
    console.error('Erreur DELETE presences-professeurs:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.get('/api/admin/remuneration-mensuelle', async (req, res) => {
  const mois = req.query.mois || currentMonthKey();
  const range = monthDateRange(mois);
  if (!range) {
    return res.status(400).json({ error: 'Mois invalide (format AAAA-MM).' });
  }

  try {
    const anneeNom = await getActiveAnneeNom(prisma);
    const presences = await prisma.presenceProfesseur.findMany({
      where: {
        date_presence: { gte: range.start, lt: range.end },
        ...(anneeNom ? { annee_scolaire: anneeNom } : {}),
      },
      include: {
        professeur: { select: { id: true, nom: true, prenom: true } },
        classe: { select: { id: true, nom: true, niveau: true } },
      },
      orderBy: [{ professeur: { nom: 'asc' } }, { date_presence: 'asc' }],
    });

    const profs = computeProfMonthlySummary(presences, currentMonthKey())
      .filter((r) => r.mois === mois);

    const total_heures = profs.reduce((s, p) => s + p.heures, 0);
    const total_montant = profs.reduce((s, p) => s + p.montant, 0);

    res.json({
      mois,
      annee_scolaire: anneeNom,
      est_mois_courant: mois === currentMonthKey(),
      professeurs: profs,
      total_heures,
      total_montant,
      formule: 'Montant mensuel = nombre d\'heures × tarif horaire (par classe)',
    });
  } catch (error) {
    console.error('Erreur GET remuneration-mensuelle:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// --- TEACHER ROUTES (données strictement limitées au professeur connecté) ---

async function requireTeacher(req, res, next) {
  const decoded = getUserFromToken(req);
  if (!decoded || decoded.role !== 'PROFESSEUR') {
    return res.status(401).json({ error: 'Authentification enseignant requise.' });
  }

  const prof = await prisma.professeur.findFirst({
    where: { utilisateurId: decoded.id },
    include: { utilisateur: { select: { id: true, email: true, nom: true, role: true, photoUrl: true } } },
  });

  if (!prof) {
    return res.status(403).json({ error: 'Profil enseignant introuvable.' });
  }

  req.teacher = prof;
  req.user = decoded;
  next();
}

async function getMatiereForTeacher(profId, matiereId) {
  return prisma.matiere.findFirst({
    where: { id: matiereId, professeurId: profId },
    include: { classe: true },
  });
}

async function getNoteForTeacher(profId, noteId) {
  return prisma.note.findFirst({
    where: {
      id: noteId,
      matiere: { professeurId: profId },
    },
    include: { matiere: true },
  });
}

function sanitizeMatiereForTeacher(matiere) {
  if (!matiere) return null;
  return {
    id: matiere.id,
    nom: matiere.nom,
    coefficient: matiere.coefficient,
    classeId: matiere.classeId,
    classe: matiere.classe
      ? { id: matiere.classe.id, nom: matiere.classe.nom, niveau: matiere.classe.niveau }
      : null,
  };
}

function sanitizeEleveForTeacher(eleve) {
  return {
    id: eleve.id,
    matricule: eleve.matricule,
    nom: eleve.nom,
    prenom: eleve.prenom,
    notes: (eleve.notes || []).map((n) => ({
      id: n.id,
      valeur: n.valeur,
      type_evaluation: n.type_evaluation,
      periode: n.periode,
      annee_scolaire: n.annee_scolaire,
      appreciation: n.appreciation,
      matiereId: n.matiereId,
    })),
  };
}

async function isEleveInMatiereClasse(eleveId, matiere, annee_scolaire) {
  if (!matiere?.classeId || !annee_scolaire) return false;
  const ins = await prisma.inscription.findFirst({
    where: {
      eleveId: parseInt(eleveId, 10),
      classeId: matiere.classeId,
      annee_scolaire,
      statut: 'Validé',
      eleve: { statut: 'Actif' },
    },
  });
  return Boolean(ins);
}

// Profil du professeur connecté
app.get('/api/teacher/me', requireTeacher, (req, res) => {
  const { id, nom, prenom, specialite, contact, photoUrl, utilisateur } = req.teacher;
  const resolvedPhoto = resolveUserPhotoUrl(utilisateur, { photoUrl });
  res.json({
    professeur: {
      id,
      nom,
      prenom,
      specialite,
      contact,
      photoUrl: resolvedPhoto,
      email: utilisateur.email,
    },
  });
});

// Année scolaire active uniquement (pas la liste admin complète)
app.get('/api/teacher/annees', requireTeacher, async (req, res) => {
  try {
    const active = await prisma.anneeScolaire.findFirst({ where: { active: true } });
    res.json({
      active: active ? active.nom : null,
      annee: active || null,
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Matières assignées au professeur connecté
app.get('/api/teacher/matieres', requireTeacher, async (req, res) => {
  try {
    const matieres = await prisma.matiere.findMany({
      where: { professeurId: req.teacher.id },
      include: { classe: true },
      orderBy: [{ nom: 'asc' }, { classeId: 'asc' }],
    });

    res.json({
      professeur: {
        id: req.teacher.id,
        nom: req.teacher.nom,
        prenom: req.teacher.prenom,
        email: req.teacher.utilisateur.email,
      },
      matieres: matieres.map(sanitizeMatiereForTeacher),
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Rémunération du professeur connecté (présences cumulées)
app.get('/api/teacher/remuneration', requireTeacher, async (req, res) => {
  try {
    const anneeNom = await getActiveAnneeNom(prisma);
    const where = {
      professeurId: req.teacher.id,
      ...(anneeNom ? { annee_scolaire: anneeNom } : {}),
    };

    const presences = await prisma.presenceProfesseur.findMany({
      where,
      include: {
        matiere: { select: { id: true, nom: true } },
        classe: { select: { id: true, nom: true, niveau: true } },
      },
      orderBy: [{ date_presence: 'desc' }, { createdAt: 'desc' }],
    });

    const parMois = computeMonthlyFromPresences(presences, currentMonthKey());
    const total = parMois.reduce((s, m) => s + m.montant, 0);
    const totalHeures = presences.reduce((s, p) => s + p.nombre_heures, 0);
    const moisCourant = parMois.find((m) => m.est_mois_courant) || null;

    res.json({
      annee_scolaire: anneeNom,
      formule: 'Montant mensuel = heures du mois × tarif horaire défini',
      total,
      total_heures: totalHeures,
      seances: presences.length,
      mois_courant: moisCourant,
      par_mois: parMois,
      historique: presences.map((p) => ({
        id: p.id,
        date: p.date_presence.toISOString().slice(0, 10),
        matiere: p.matiere.nom,
        classe: p.classe ? `${p.classe.nom}${p.classe.niveau ? ` (${p.classe.niveau})` : ''}` : null,
        classe_nom: p.classe?.nom || null,
        nombre_heures: p.nombre_heures,
        tarif_horaire: p.tarif_horaire,
        mois: p.date_presence.toISOString().slice(0, 7),
      })),
    });
  } catch (error) {
    console.error('Erreur GET teacher/remuneration:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Détail d'une matière — uniquement si assignée au professeur
app.get('/api/teacher/matieres/:id', requireTeacher, async (req, res) => {
  const matiereId = parseInt(req.params.id);
  try {
    const matiere = await getMatiereForTeacher(req.teacher.id, matiereId);
    if (!matiere) {
      return res.status(403).json({ error: 'Cette matière ne vous est pas assignée.' });
    }
    res.json({ matiere: sanitizeMatiereForTeacher(matiere) });
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Élèves d'une matière assignée au professeur
app.get('/api/teacher/matieres/:id/eleves', requireTeacher, async (req, res) => {
  const matiereId = parseInt(req.params.id);
  const { annee_scolaire, periode } = req.query;

  try {
    const matiere = await getMatiereForTeacher(req.teacher.id, matiereId);
    if (!matiere) {
      return res.status(403).json({ error: 'Cette matière ne vous est pas assignée.' });
    }
    if (!matiere.classeId) {
      return res.json({ matiere: sanitizeMatiereForTeacher(matiere), eleves: [] });
    }

    const inscriptions = await prisma.inscription.findMany({
      where: {
        classeId: matiere.classeId,
        annee_scolaire,
        statut: 'Validé',
        eleve: { statut: 'Actif' },
      },
      include: {
        eleve: {
          include: {
            notes: {
              where: {
                matiereId,
                ...(periode ? { periode } : {}),
                ...(annee_scolaire ? { annee_scolaire } : {}),
              },
            },
          },
        },
      },
      orderBy: { eleve: { nom: 'asc' } },
    });

    const eleves = [];
    const seen = new Set();
    for (const ins of inscriptions) {
      if (!seen.has(ins.eleve.id)) {
        seen.add(ins.eleve.id);
        eleves.push(ins.eleve);
      }
    }

    res.json({
      matiere: sanitizeMatiereForTeacher(matiere),
      eleves: eleves.map(sanitizeEleveForTeacher),
    });
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Enregistrer les notes d'un élève (ligne complète) + notification
app.post('/api/teacher/notes/eleve', requireTeacher, async (req, res) => {
  const {
    eleveId,
    matiereId,
    periode,
    annee_scolaire,
    d1,
    d2,
    compo,
    d1Id,
    d2Id,
    compoId,
    appreciation,
  } = req.body;

  try {
    const matiere = await getMatiereForTeacher(req.teacher.id, parseInt(matiereId, 10));
    if (!matiere) {
      return res.status(403).json({ error: 'Vous ne pouvez pas saisir de notes pour cette matière.' });
    }

    const enrolled = await isEleveInMatiereClasse(eleveId, matiere, annee_scolaire);
    if (!enrolled) {
      return res.status(403).json({ error: 'Cet élève n\'est pas inscrit dans la classe de cette matière.' });
    }

    const eleve = await prisma.eleve.findUnique({
      where: { id: parseInt(eleveId, 10) },
      select: { id: true, nom: true, prenom: true },
    });
    if (!eleve) return res.status(404).json({ error: 'Élève introuvable.' });

    const gradeInput = [
      { key: 'd1', type: 'Devoir 1', valeur: d1, noteId: d1Id },
      { key: 'd2', type: 'Devoir 2', valeur: d2, noteId: d2Id },
      { key: 'compo', type: 'Composition', valeur: compo, noteId: compoId },
    ];

    const result = await prisma.$transaction(async (tx) => {
      const savedTypes = [];
      let isUpdate = false;

      for (const item of gradeInput) {
        const existing = item.noteId
          ? await tx.note.findFirst({
              where: { id: parseInt(item.noteId, 10), matiereId: matiere.id, eleveId: eleve.id },
            })
          : await tx.note.findFirst({
              where: {
                eleveId: eleve.id,
                matiereId: matiere.id,
                periode,
                type_evaluation: item.type,
              },
            });

        const isEmpty = item.valeur === '' || item.valeur === null || item.valeur === undefined;

        if (isEmpty) {
          if (existing) {
            await tx.note.delete({ where: { id: existing.id } });
            isUpdate = true;
            savedTypes.push(`${item.type} (supprimée)`);
          }
          continue;
        }

        if (existing) {
          await tx.note.update({
            where: { id: existing.id },
            data: {
              valeur: parseFloat(item.valeur),
              appreciation: appreciation || '',
              annee_scolaire,
            },
          });
          isUpdate = true;
          savedTypes.push(item.type);
        } else {
          await tx.note.create({
            data: {
              eleveId: eleve.id,
              matiereId: matiere.id,
              valeur: parseFloat(item.valeur),
              type_evaluation: item.type,
              periode,
              annee_scolaire,
              appreciation: appreciation || '',
            },
          });
          savedTypes.push(item.type);
        }
      }

      return { savedTypes, isUpdate };
    });

    if (result.savedTypes.length > 0) {
      await createGradeSaveNotifications(prisma, {
        teacher: req.teacher,
        matiere,
        eleve,
        periode,
        annee_scolaire,
        savedTypes: result.savedTypes,
        isUpdate: result.isUpdate,
      });
    }

    res.json({
      message: 'Notes enregistrées avec succès.',
      savedTypes: result.savedTypes,
      notificationSent: result.savedTypes.length > 0,
    });
  } catch (error) {
    console.error('Erreur save notes élève prof:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Enregistrer ou mettre à jour une note (matière du professeur uniquement)
app.post('/api/teacher/notes', requireTeacher, async (req, res) => {
  const { eleveId, matiereId, valeur, type_evaluation, periode, annee_scolaire, appreciation } = req.body;

  try {
    const matiere = await getMatiereForTeacher(req.teacher.id, parseInt(matiereId));
    if (!matiere) {
      return res.status(403).json({ error: 'Vous ne pouvez pas saisir de notes pour cette matière.' });
    }

    const enrolled = await isEleveInMatiereClasse(eleveId, matiere, annee_scolaire);
    if (!enrolled) {
      return res.status(403).json({ error: 'Cet élève n\'est pas inscrit dans la classe de cette matière.' });
    }

    const existing = await prisma.note.findFirst({
      where: {
        eleveId: parseInt(eleveId),
        matiereId: matiere.id,
        periode,
        type_evaluation,
      },
    });

    let note;
    if (existing) {
      note = await prisma.note.update({
        where: { id: existing.id },
        data: { valeur: parseFloat(valeur), appreciation, annee_scolaire },
      });
    } else {
      note = await prisma.note.create({
        data: {
          eleveId: parseInt(eleveId),
          matiereId: matiere.id,
          valeur: parseFloat(valeur),
          type_evaluation,
          periode,
          annee_scolaire,
          appreciation,
        },
      });
    }

    res.json(note);
  } catch (error) {
    console.error('Erreur save note prof:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Supprimer une note (uniquement sur ses matières)
app.delete('/api/teacher/notes/:id', requireTeacher, async (req, res) => {
  const noteId = parseInt(req.params.id);
  try {
    const note = await getNoteForTeacher(req.teacher.id, noteId);
    if (!note) {
      return res.status(403).json({ error: 'Note introuvable ou non autorisée.' });
    }
    await prisma.note.delete({ where: { id: noteId } });
    res.json({ message: 'Note supprimée' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Saisie groupée (tableau d'élèves, une évaluation)
app.post('/api/teacher/notes/bulk', requireTeacher, async (req, res) => {
  const { matiereId, type_evaluation, periode, annee_scolaire, notes } = req.body;

  try {
    const matiere = await getMatiereForTeacher(req.teacher.id, parseInt(matiereId));
    if (!matiere) {
      return res.status(403).json({ error: 'Vous ne pouvez pas saisir de notes pour cette matière.' });
    }

    const validEleveIds = new Set();
    if (matiere.classeId && annee_scolaire) {
      const inscriptions = await prisma.inscription.findMany({
        where: { classeId: matiere.classeId, annee_scolaire, statut: 'Validé', eleve: { statut: 'Actif' } },
        select: { eleveId: true },
      });
      inscriptions.forEach((i) => validEleveIds.add(i.eleveId));
    }

    const toSave = (notes || []).filter((n) => validEleveIds.has(n.eleveId) && n.valeur !== '' && n.valeur != null);

    await prisma.$transaction(
      toSave.map((n) =>
        prisma.note.create({
          data: {
            eleveId: n.eleveId,
            matiereId: matiere.id,
            valeur: parseFloat(n.valeur),
            appreciation: n.appreciation || '',
            type_evaluation,
            periode,
            annee_scolaire,
          },
        })
      )
    );

    if (toSave.length > 0) {
      const teacherWithUser = await prisma.professeur.findUnique({
        where: { id: req.teacher.id },
        include: { utilisateur: { select: { id: true } } },
      });
      await createGradeSaveNotifications(prisma, {
        teacher: { ...teacherWithUser, utilisateurId: teacherWithUser.utilisateurId },
        matiere,
        eleve: { id: 0, prenom: '', nom: '' },
        eleveLabel: `${toSave.length} élève(s)`,
        periode,
        annee_scolaire,
        savedTypes: [type_evaluation],
        isUpdate: false,
      });
    }

    res.json({ message: `Notes enregistrées pour ${toSave.length} élève(s).` });
  } catch (error) {
    console.error('Erreur save notes prof:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Calculate Resultats (Global Average)
app.post('/api/admin/resultats/calculer', async (req, res) => {
  const { classeId, annee_scolaire, periode } = req.body;
  
  try {
    const classe = await prisma.classe.findUnique({
      where: { id: parseInt(classeId) },
      include: { niveauEtude: true },
    });
    const regle = getRegleCalcul(classe?.niveauEtude);

    const matieres = await prisma.matiere.findMany({ where: { classeId: parseInt(classeId) } });
    if (matieres.length === 0) return res.status(400).json({ error: "Aucune matière dans cette classe" });

    const inscriptions = await prisma.inscription.findMany({
      where: { classeId: parseInt(classeId), annee_scolaire, statut: 'Validé', eleve: { statut: 'Actif' } }
    });

    const resultatsToCreate = [];

    for (const ins of inscriptions) {
      let totalPoints = 0;
      let totalCoefs = 0;

      for (const matiere of matieres) {
        const notes = await prisma.note.findMany({
          where: { eleveId: ins.eleveId, matiereId: matiere.id, periode, annee_scolaire }
        });

        const avgSubject = computeSubjectAverageFromNotes(notes, regle);
        if (avgSubject !== null) {
          totalPoints += avgSubject * matiere.coefficient;
          totalCoefs += matiere.coefficient;
        }
      }

      if (totalCoefs > 0) {
        const moyenne = totalPoints / totalCoefs;
        const appreciation = moyenne >= 16 ? 'Très Bien' : moyenne >= 14 ? 'Bien' : moyenne >= 12 ? 'Assez Bien' : moyenne >= 10 ? 'Passable' : 'Insuffisant';
        
        resultatsToCreate.push({
          eleveId: ins.eleveId,
          classeId: parseInt(classeId),
          annee_scolaire,
          periode,
          moyenne,
          appreciation
        });
      }
    }

    // Delete existing resultats for this combination to recalculate
    await prisma.resultat.deleteMany({
      where: { classeId: parseInt(classeId), annee_scolaire, periode }
    });

    if (resultatsToCreate.length > 0) {
      await prisma.resultat.createMany({ data: resultatsToCreate });
    }

    res.json({ message: `Moyennes calculées pour ${resultatsToCreate.length} élèves.` });
  } catch (error) {
    console.error("Erreur calcul resultats:", error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Taux de réussite/échec par niveau (calculé depuis les notes de l'année active)
app.get('/api/admin/taux-reussite', async (req, res) => {
  try {
    const { periode } = req.query;
    const activeYear = await prisma.anneeScolaire.findFirst({ where: { active: true } });
    const anneeScolaire = activeYear?.nom || null;

    const result = [];

    for (const niveau of CYCLES) {
      const inscriptions = await prisma.inscription.findMany({
        where: {
          statut: 'Validé',
          eleve: { statut: 'Actif' },
          classe: { cycle: niveau },
          ...(anneeScolaire ? { annee_scolaire: anneeScolaire } : {}),
        },
        include: {
          eleve: {
            include: {
              notes: {
                where: {
                  ...(anneeScolaire ? { annee_scolaire: anneeScolaire } : {}),
                  ...(periode ? { periode } : {}),
                },
              },
            },
          },
          classe: {
            include: {
              matieres: { orderBy: { nom: 'asc' } },
              niveauEtude: true,
            },
          },
        },
      });

      const inscrits = inscriptions.length;
      let reussite = 0;
      let echec = 0;
      let evaluables = 0;
      let seuilReussite = normalizeRegle(null).seuilReussite;

      for (const ins of inscriptions) {
        const regle = getRegleCalcul(ins.classe.niveauEtude);
        seuilReussite = regle.seuilReussite;

        const matieres = ins.classe.matieres.map((mat) => {
          const notesMatiere = ins.eleve.notes.filter((n) => n.matiereId === mat.id);
          return buildMatiereResult(mat, notesMatiere, regle);
        });

        const moyenneGenerale = computeGeneralAverage(matieres);
        if (moyenneGenerale === null) continue;

        evaluables++;
        if (moyenneGenerale >= regle.seuilReussite) reussite++;
        else echec++;
      }

      result.push({
        niveau,
        inscrits,
        evaluables,
        sansNotes: inscrits - evaluables,
        total: evaluables,
        reussite,
        echec,
        seuilReussite,
        tauxReussite: evaluables > 0 ? Math.round((reussite / evaluables) * 100) : 0,
        tauxEchec: evaluables > 0 ? Math.round((echec / evaluables) * 100) : 0,
        anneeScolaire,
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Erreur taux réussite:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// --- PAIEMENTS ROUTES ---

const paymentEleveInclude = {
  eleve: {
    select: {
      id: true,
      nom: true,
      prenom: true,
      matricule: true,
      solde: true,
      statut_financier: true,
      parent_nom: true,
      parent_telephone: true,
      inscriptions: {
        include: { classe: { select: { id: true, nom: true, montant_annuel: true } } },
      },
    },
  },
};

function formatPaymentReference(paiement) {
  const yearPart = (paiement.annee_scolaire || '').replace(/-/g, '');
  return `REC-${yearPart || '0000'}-${String(paiement.id).padStart(5, '0')}`;
}

async function getPaymentWithDetails(paiementId) {
  const paiement = await prisma.paiement.findUnique({
    where: { id: paiementId },
    include: paymentEleveInclude,
  });
  if (!paiement) return null;

  const matchingInscriptions = paiement.eleve.inscriptions.filter(
    (i) => i.annee_scolaire === paiement.annee_scolaire
  );

  return {
    ...paiement,
    eleve: {
      ...paiement.eleve,
      inscriptions: matchingInscriptions.length
        ? matchingInscriptions
        : paiement.eleve.inscriptions.slice(0, 1),
    },
  };
}

// CREATE a new Paiement
app.post('/api/paiements', async (req, res) => {
  const { eleveId, montant, mode_paiement, periode, annee_scolaire, reference, enregistre_par, notes } = req.body;
  const decoded = getUserFromToken(req);
  try {
    const paiement = await prisma.$transaction(async (tx) => {
      const ctx = await getStudentPaymentContext(parseInt(eleveId), annee_scolaire);
      if (!ctx) {
        throw new Error('Élève non trouvé');
      }

      const { eleve, annualAmount, totalPaid } = ctx;
      const expectedAmount = computeExpectedPaymentAmount({
        periode,
        montant,
        eleve,
        annualAmount,
        totalPaid,
      });

      if (!expectedAmount || expectedAmount <= 0) {
        throw new Error('Montant invalide ou rien à payer pour cette période.');
      }

      const finalReference = reference?.trim() || null;

      let newPaiement = await tx.paiement.create({
        data: {
          eleveId: parseInt(eleveId),
          montant: expectedAmount,
          mode_paiement,
          periode,
          annee_scolaire,
          reference: finalReference,
          enregistre_par: enregistre_par ? parseInt(enregistre_par) : decoded?.id || null,
          notes,
        },
      });

      if (!finalReference) {
        newPaiement = await tx.paiement.update({
          where: { id: newPaiement.id },
          data: { reference: formatPaymentReference(newPaiement) },
        });
      }

      const newSolde = (eleve.solde || 0) - expectedAmount;
      const isUpToDate = await isStudentUpToDate(parseInt(eleveId), annee_scolaire, expectedAmount);
      const newStatutFinancier = isUpToDate
        ? 'À jour'
        : (newSolde < 0 ? 'À jour partiel' : 'En retard');

      await tx.eleve.update({
        where: { id: parseInt(eleveId) },
        data: {
          solde: newSolde,
          statut_financier: newStatutFinancier,
        },
      });

      return newPaiement;
    });

    const fullPaiement = await getPaymentWithDetails(paiement.id);
    res.json({ message: 'Paiement enregistré avec succès', paiement: fullPaiement });
  } catch (error) {
    console.error('Erreur création paiement:', error);
    res.status(500).json({ error: error.message || 'Erreur interne.' });
  }
});

// Montant attendu pour un paiement (aperçu)
app.get('/api/paiements/montant-attendu', async (req, res) => {
  const { eleveId, annee_scolaire, periode, montant } = req.query;
  if (!eleveId || !annee_scolaire || !periode) {
    return res.status(400).json({ error: 'eleveId, annee_scolaire et periode sont requis.' });
  }

  try {
    const ctx = await getStudentPaymentContext(parseInt(eleveId, 10), annee_scolaire);
    if (!ctx) {
      return res.status(404).json({ error: 'Élève introuvable.' });
    }

    const { eleve, annualAmount, totalPaid, remainingYear } = ctx;
    const expectedAmount = computeExpectedPaymentAmount({
      periode,
      montant,
      eleve,
      annualAmount,
      totalPaid,
    });

    res.json({
      montant: expectedAmount,
      montant_annuel: annualAmount,
      total_paye: totalPaid,
      solde_restant_annee: remainingYear,
      paiement_integral: isFullPaymentPeriod(periode),
    });
  } catch (error) {
    console.error('Erreur calcul montant paiement:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// GET all Paiements (admin)
app.get('/api/paiements', async (req, res) => {
  const { eleveId, annee_scolaire } = req.query;
  try {
    const where = {};
    if (eleveId) where.eleveId = parseInt(eleveId);
    if (annee_scolaire) where.annee_scolaire = annee_scolaire;

    const paiements = await prisma.paiement.findMany({
      where,
      include: paymentEleveInclude,
      orderBy: { date_paiement: 'desc' }
    });
    res.json(paiements);
  } catch (error) {
    console.error('Erreur récupération paiements:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// GET un paiement (reçu détaillé)
app.get('/api/paiements/:id', async (req, res) => {
  const paiementId = parseInt(req.params.id);
  if (Number.isNaN(paiementId)) {
    return res.status(400).json({ error: 'Identifiant invalide.' });
  }
  try {
    const paiement = await getPaymentWithDetails(paiementId);
    if (!paiement) {
      return res.status(404).json({ error: 'Paiement introuvable.' });
    }
    res.json(paiement);
  } catch (error) {
    console.error('Erreur récupération paiement:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// GET Paiements by Eleve ID
app.get('/api/paiements/eleve/:id', async (req, res) => {
  const eleveId = parseInt(req.params.id);
  const { annee_scolaire } = req.query;
  try {
    const where = { eleveId };
    if (annee_scolaire) where.annee_scolaire = annee_scolaire;

    const paiements = await prisma.paiement.findMany({
      where,
      orderBy: { date_paiement: 'desc' }
    });
    res.json(paiements);
  } catch (error) {
    console.error('Erreur récupération paiements élève:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// GET Paiement status for an Eleve
app.get('/api/paiements/statut/:eleveId', async (req, res) => {
  const eleveId = parseInt(req.params.eleveId);
  const { annee_scolaire } = req.query;
  try {
    const eleve = await prisma.eleve.findUnique({
      where: { id: eleveId },
      select: {
        id: true,
        nom: true,
        prenom: true,
        solde: true,
        statut_financier: true
      }
    });

    if (!eleve) {
      return res.status(404).json({ error: 'Élève non trouvé' });
    }

    // Get payments for the specified academic year
    const where = { eleveId };
    if (annee_scolaire) where.annee_scolaire = annee_scolaire;

    const paiements = await prisma.paiement.findMany({
      where,
      orderBy: { date_paiement: 'desc' }
    });

    res.json({
      eleve,
      paiements,
      peutVoirNotes: eleve.statut_financier === 'À jour'
    });
  } catch (error) {
    console.error('Erreur vérification statut paiement:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// UPDATE a Paiement
app.put('/api/paiements/:id', async (req, res) => {
  const paiementId = parseInt(req.params.id);
  const { montant, mode_paiement, periode, reference, notes } = req.body;
  try {
    const paiement = await prisma.paiement.update({
      where: { id: paiementId },
      data: {
        montant: montant ? parseFloat(montant) : undefined,
        mode_paiement,
        periode,
        reference,
        notes
      }
    });
    res.json({ message: 'Paiement mis à jour avec succès', paiement });
  } catch (error) {
    console.error('Erreur mise à jour paiement:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// DELETE a Paiement
app.delete('/api/paiements/:id', async (req, res) => {
  const paiementId = parseInt(req.params.id);
  try {
    const paiement = await prisma.$transaction(async (tx) => {
      // Get the payment to be deleted
      const existingPaiement = await tx.paiement.findUnique({
        where: { id: paiementId },
        include: { eleve: true }
      });

      if (!existingPaiement) {
        throw new Error('Paiement non trouvé');
      }

      // Delete the payment
      await tx.paiement.delete({
        where: { id: paiementId }
      });

      // Restore the student's balance (add back the amount)
      const eleve = await tx.eleve.findUnique({
        where: { id: existingPaiement.eleveId }
      });

      const newSolde = (eleve.solde || 0) + existingPaiement.montant;
      
      // Update financial status
      let newStatutFinancier = "En retard";
      if (newSolde <= 0) {
        newStatutFinancier = "À jour";
      } else if (newSolde > 0) {
        newStatutFinancier = "À jour partiel";
      }

      await tx.eleve.update({
        where: { id: existingPaiement.eleveId },
        data: {
          solde: newSolde,
          statut_financier: newStatutFinancier
        }
      });

      return existingPaiement;
    });

    res.json({ message: 'Paiement supprimé avec succès' });
  } catch (error) {
    console.error('Erreur suppression paiement:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// UPDATE Eleve financial status (manual adjustment) — admin uniquement
app.put('/api/eleves/:id/financier', requireAdmin, async (req, res) => {
  const eleveId = parseInt(req.params.id);
  const { solde, statut_financier } = req.body;
  try {
    const eleve = await prisma.eleve.update({
      where: { id: eleveId },
      data: {
        solde: solde !== undefined ? parseFloat(solde) : undefined,
        statut_financier: statut_financier
      }
    });
    res.json({ message: 'Statut financier mis à jour avec succès', eleve });
  } catch (error) {
    console.error('Erreur mise à jour statut financier:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Port
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
