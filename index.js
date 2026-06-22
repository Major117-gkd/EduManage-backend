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

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

// --- MIDDLEWARES ---

// Helper function to check if a student is "up to date" with payments
const isStudentUpToDate = async (eleveId, annee_scolaire) => {
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
        // Only count current month payments
        return paymentMonth === currentMonth ? sum + p.montant : sum;
      } else {
        // Count all payments in the current tranche
        return trancheMonths.includes(paymentMonth) ? sum + p.montant : sum;
      }
    }, 0);

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

// --- ROUTES ---

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
    res.json({
      message: 'Connexion réussie',
      token,
      user: {
        id: user.id,
        nom: user.nom,
        email: user.email,
        role: user.role
      }
    });

  } catch (error) {
    console.error("Erreur login:", error);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// --- ADMIN ROUTES ---

// LIST all classes (for dropdown in modal)

// LIST all Professeurs
app.get('/api/admin/professeurs', async (req, res) => {
  try {
    const profs = await prisma.professeur.findMany({
      orderBy: { nom: 'asc' },
      include: {
        utilisateur: { select: { id: true, email: true, nom: true, role: true, createdAt: true } },
        matieres: { include: { classe: true } },
      },
    });
    res.json(profs);
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});



// LIST all Eleves
app.get('/api/admin/eleves', async (req, res) => {
  const { show_inactive } = req.query;
  try {
    const eleves = await prisma.eleve.findMany({
      where: show_inactive === 'true' ? {} : { statut: 'Actif' },
      orderBy: { createdAt: 'desc' },
      include: {
        inscriptions: {
          include: { classe: true }
        }
      }
    });
    res.json(eleves);
  } catch (error) {
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
  const { prenom, nom, date_naissance, adresse, parent_nom, filiation, parent_telephone, parent_email, infos_importantes, photoUrl, exception_paiement_mensuel } = req.body;
  const eleveId = parseInt(req.params.id);
  try {
    const eleve = await prisma.eleve.update({
      where: { id: eleveId },
      data: {
        prenom, nom, 
        date_naissance: date_naissance ? new Date(date_naissance) : null,
        adresse, parent_nom, filiation, parent_telephone, parent_email, infos_importantes, photoUrl,
        exception_paiement_mensuel: exception_paiement_mensuel !== undefined ? exception_paiement_mensuel : undefined
      }
    });
    res.json({ message: 'Élève mis à jour avec succès', eleve });
  } catch (error) {
    console.error('Erreur mise à jour élève:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// DELETE (soft delete) an Eleve
app.delete('/api/admin/eleves/:id', async (req, res) => {
  const eleveId = parseInt(req.params.id);
  try {
    await prisma.eleve.update({
      where: { id: eleveId },
      data: { statut: 'Inactif' }
    });
    res.json({ message: 'Élève marqué comme inactif avec succès' });
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
app.get('/api/admin/classes', async (req, res) => {
  try {
    const classes = await prisma.classe.findMany({
      include: { anneeScolaire: true }
    });
    res.json(classes);
  } catch (error) {
    console.error("Erreur récupération classes:", error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

app.post('/api/admin/classes', async (req, res) => {
  const { nom, niveau, cycle, capacite, montant_annuel, anneeScolaireId } = req.body;
  try {
    const newClass = await prisma.classe.create({
      data: {
        nom,
        niveau,
        cycle: cycle || 'Collège',
        capacite: parseInt(capacite) || 30,
        montant_annuel: parseFloat(montant_annuel) || 0,
        anneeScolaireId: anneeScolaireId ? parseInt(anneeScolaireId) : null
      }
    });
    res.json(newClass);
  } catch (error) {
    console.error("Erreur création classe:", error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});
app.put('/api/admin/classes/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { nom, niveau, cycle, capacite, montant_annuel, anneeScolaireId } = req.body;
  try {
    const updatedClass = await prisma.classe.update({
      where: { id },
      data: {
        nom,
        niveau,
        cycle: cycle || 'Collège',
        capacite: capacite ? parseInt(capacite) : undefined,
        montant_annuel: montant_annuel !== undefined ? parseFloat(montant_annuel) : undefined,
        anneeScolaireId: anneeScolaireId ? parseInt(anneeScolaireId) : null
      }
    });
    res.json(updatedClass);
  } catch (error) {
    console.error("Erreur mise à jour classe:", error);
    res.status(500).json({ error: 'Erreur interne.' });
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
      include: { professeur: true }
    });
    res.json(matieres);
  } catch (e) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Create a subject for a class
app.post('/api/admin/matieres', async (req, res) => {
  const { nom, coefficient, professeurId, classeId } = req.body;
  try {
    const m = await prisma.matiere.create({
      data: {
        nom,
        coefficient: parseFloat(coefficient) || 1,
        professeurId: professeurId ? parseInt(professeurId) : null,
        classeId: classeId ? parseInt(classeId) : null
      },
      include: { professeur: true }
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
  const { nom, coefficient, professeurId, classeId } = req.body;
  try {
    const m = await prisma.matiere.update({
      where: { id },
      data: { 
        nom, 
        coefficient: parseFloat(coefficient) || 1, 
        professeurId: professeurId ? parseInt(professeurId) : null,
        classeId: classeId ? parseInt(classeId) : null
      },
      include: { professeur: true }
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

// Save or update a note for a student
app.post('/api/admin/notes', async (req, res) => {
  const { eleveId, matiereId, valeur, type_evaluation, periode, annee_scolaire, appreciation } = req.body;
  try {
    // Check if note already exists for this student/subject/period/type
    const existing = await prisma.note.findFirst({
      where: { eleveId: parseInt(eleveId), matiereId: parseInt(matiereId), periode, type_evaluation }
    });

    let note;
    if (existing) {
      note = await prisma.note.update({
        where: { id: existing.id },
        data: { valeur: parseFloat(valeur), appreciation, annee_scolaire }
      });
    } else {
      note = await prisma.note.create({
        data: {
          eleveId: parseInt(eleveId),
          matiereId: parseInt(matiereId),
          valeur: parseFloat(valeur),
          type_evaluation,
          periode,
          annee_scolaire,
          appreciation
        }
      });
    }
    res.json(note);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Delete a note
app.delete('/api/admin/notes/:id', async (req, res) => {
  try {
    await prisma.note.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: 'Note supprimée' });
  } catch (e) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
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
          include: { matieres: { orderBy: { nom: 'asc' } } },
        },
      },
      orderBy: [{ classe: { nom: 'asc' } }, { eleve: { nom: 'asc' } }],
    });

    const eleves = inscriptions.map((ins) => {
      const matieres = ins.classe.matieres.map((mat) => {
        const notesMatiere = ins.eleve.notes.filter((n) => n.matiereId === mat.id);
        const result = buildMatiereResult(mat, notesMatiere);
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
      include: { matieres: { include: { professeur: true } } }
    });

    if (!classe) return res.status(404).json({ error: 'Classe introuvable' });

    const inscriptions = await prisma.inscription.findMany({
      where: { classeId, statut: 'Validé' },
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
        return buildMatiereResult(mat, notesEleve);
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

    res.json({ classe: classe.nom, niveau: classe.niveau, bulletins });
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
    const inscriptions = await prisma.inscription.findMany({
      where: { classeId, statut: 'Validé' },
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
          moyenne: computeSubjectAverageFromNotes(notes),
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
  const { nom, prenom, email, specialite, contact, matieresIds, mot_de_passe } = req.body;

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
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const professeur = await prisma.$transaction(async (tx) => {
      const user = await tx.utilisateur.create({
        data: {
          nom: `${prenom.trim()} ${nom.trim()}`,
          email: normalizedEmail,
          mot_de_passe: hashedPassword,
          role: 'PROFESSEUR',
        },
      });

      const prof = await tx.professeur.create({
        data: {
          utilisateurId: user.id,
          nom: nom.trim(),
          prenom: prenom.trim(),
          specialite: specialite?.trim() || null,
          contact: contact?.trim() || null,
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
          utilisateur: { select: { id: true, email: true, nom: true, role: true, createdAt: true } },
          matieres: { include: { classe: true } },
        },
      });
    });

    res.status(201).json({
      message: 'Professeur et compte utilisateur créés avec succès.',
      professeur,
      utilisateur: professeur.utilisateur,
      motDePasseTemporaire: mot_de_passe ? undefined : tempPassword,
    });
  } catch (error) {
    console.error('Erreur création prof:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
    }
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Update Teacher's subjects
app.put('/api/admin/professeurs/:id/affectations', async (req, res) => {
  const id = parseInt(req.params.id);
  const { matieresIds } = req.body;
  
  try {
    await prisma.$transaction(async (tx) => {
      // 1. Remove teacher from all current subjects
      await tx.matiere.updateMany({
        where: { professeurId: id },
        data: { professeurId: null }
      });
      
      // 2. Add teacher to the selected subjects
      if (matieresIds && matieresIds.length > 0) {
        await tx.matiere.updateMany({
          where: { id: { in: matieresIds } },
          data: { professeurId: id }
        });
      }
    });
    res.json({ message: 'Affectations mises à jour' });
  } catch (error) {
    console.error("Erreur mise à jour affectations:", error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// --- TEACHER ROUTES ---

async function getProfesseurFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    return prisma.professeur.findFirst({
      where: { utilisateurId: decoded.id },
      include: { utilisateur: true },
    });
  } catch {
    return null;
  }
}

// Get Teacher's assigned classes and subjects
app.get('/api/teacher/matieres', async (req, res) => {
  try {
    const prof = await getProfesseurFromRequest(req);
    if (!prof) return res.status(401).json({ error: 'Non authentifié ou profil enseignant introuvable.' });

    const matieres = await prisma.matiere.findMany({
      where: { professeurId: prof.id },
      include: { classe: true }
    });

    res.json({ professeur: { id: prof.id, nom: prof.nom, prenom: prof.prenom }, matieres });
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Get Students for a given Matiere
app.get('/api/teacher/matieres/:id/eleves', async (req, res) => {
  const matiereId = parseInt(req.params.id);
  const { annee_scolaire } = req.query;

  try {
    const matiere = await prisma.matiere.findUnique({ where: { id: matiereId } });
    if (!matiere || !matiere.classeId) return res.json({ eleves: [] });

    const inscriptions = await prisma.inscription.findMany({
      where: {
        classeId: matiere.classeId,
        annee_scolaire: annee_scolaire,
        statut: 'Validé' // Only fetch validated students
      },
      include: {
        eleve: {
          include: {
            notes: {
              where: { matiereId: matiereId }
            }
          }
        }
      }
    });

    const result = [];
    const seen = new Set();
    for (const ins of inscriptions) {
      if (!seen.has(ins.eleve.id)) {
        seen.add(ins.eleve.id);
        result.push(ins.eleve);
      }
    }

    res.json({ eleves: result });
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Save Notes
app.post('/api/teacher/notes', async (req, res) => {
  const { matiereId, type_evaluation, periode, annee_scolaire, notes } = req.body;
  // notes: [{ eleveId: 1, valeur: 15, appreciation: "Bien" }, ...]

  try {
    await prisma.$transaction(
      notes.map(n => 
        prisma.note.create({
          data: {
            eleveId: n.eleveId,
            matiereId: parseInt(matiereId),
            valeur: parseFloat(n.valeur),
            appreciation: n.appreciation,
            type_evaluation,
            periode,
            annee_scolaire
          }
        })
      )
    );
    res.json({ message: 'Notes enregistrées avec succès' });
  } catch (error) {
    console.error('Erreur save notes:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// Calculate Resultats (Global Average)
app.post('/api/admin/resultats/calculer', async (req, res) => {
  const { classeId, annee_scolaire, periode } = req.body;
  
  try {
    const matieres = await prisma.matiere.findMany({ where: { classeId: parseInt(classeId) } });
    if (matieres.length === 0) return res.status(400).json({ error: "Aucune matière dans cette classe" });

    const inscriptions = await prisma.inscription.findMany({
      where: { classeId: parseInt(classeId), annee_scolaire, statut: 'Validé' }
    });

    const resultatsToCreate = [];

    for (const ins of inscriptions) {
      let totalPoints = 0;
      let totalCoefs = 0;

      for (const matiere of matieres) {
        const notes = await prisma.note.findMany({
          where: { eleveId: ins.eleveId, matiereId: matiere.id, periode, annee_scolaire }
        });

        const avgSubject = computeSubjectAverageFromNotes(notes);
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

// Taux de réussite/échec par niveau
app.get('/api/admin/taux-reussite', async (req, res) => {
  try {
    const niveaux = ['Primaire', 'Collège', 'Lycée'];
    const result = [];

    for (const niveau of niveaux) {
      // Get all classes for this level
      const classes = await prisma.classe.findMany({ where: { cycle: niveau } });
      const classeIds = classes.map(c => c.id);

      if (classeIds.length === 0) {
        result.push({ niveau, inscrits: 0, total: 0, reussite: 0, echec: 0, tauxReussite: 0, tauxEchec: 0 });
        continue;
      }

      // Count validated inscriptions for this level
      const inscrits = await prisma.inscription.count({
        where: { classeId: { in: classeIds }, statut: 'Validé' }
      });

      // Get all resultats for those classes
      const resultats = await prisma.resultat.findMany({
        where: { classeId: { in: classeIds } }
      });

      const total = resultats.length;
      const reussite = resultats.filter(r => r.moyenne >= 10).length;
      const echec = total - reussite;

      result.push({
        niveau,
        inscrits,
        total,
        reussite,
        echec,
        tauxReussite: total > 0 ? Math.round((reussite / total) * 100) : 0,
        tauxEchec: total > 0 ? Math.round((echec / total) * 100) : 0,
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Erreur taux réussite:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// --- PAIEMENTS ROUTES ---

// CREATE a new Paiement
app.post('/api/paiements', async (req, res) => {
  const { eleveId, montant, mode_paiement, periode, annee_scolaire, reference, enregistre_par, notes } = req.body;
  try {
    const paiement = await prisma.$transaction(async (tx) => {
      // Get student info with class and exception status
      const eleve = await tx.eleve.findUnique({
        where: { id: parseInt(eleveId) },
        include: {
          inscriptions: {
            where: { annee_scolaire },
            include: { classe: true }
          }
        }
      });

      if (!eleve) {
        throw new Error('Élève non trouvé');
      }

      // Calculate expected amount based on tranche system
      const inscription = eleve.inscriptions[0];
      const annualAmount = inscription?.classe?.montant_annuel || 0;
      const monthlyAmount = annualAmount / 9; // 9-month school year

      let expectedAmount = parseFloat(montant);

      // If no amount provided, calculate based on tranche system
      if (!montant && monthlyAmount > 0) {
        if (eleve.exception_paiement_mensuel) {
          // Monthly exception: single month amount
          expectedAmount = monthlyAmount;
        } else {
          // Default: 3-month tranche
          expectedAmount = monthlyAmount * 3;
        }
      }

      // Create the payment
      const newPaiement = await tx.paiement.create({
        data: {
          eleveId: parseInt(eleveId),
          montant: expectedAmount,
          mode_paiement,
          periode,
          annee_scolaire,
          reference,
          enregistre_par: enregistre_par ? parseInt(enregistre_par) : null,
          notes
        }
      });

      // Update student's balance (reduce debt)
      const newSolde = (eleve.solde || 0) - expectedAmount;

      // Determine financial status based on new tranche logic
      const isUpToDate = await isStudentUpToDate(parseInt(eleveId), annee_scolaire);
      const newStatutFinancier = isUpToDate ? "À jour" : (newSolde < 0 ? "À jour partiel" : "En retard");

      await tx.eleve.update({
        where: { id: parseInt(eleveId) },
        data: {
          solde: newSolde,
          statut_financier: newStatutFinancier
        }
      });

      return newPaiement;
    });

    res.json({ message: 'Paiement enregistré avec succès', paiement });
  } catch (error) {
    console.error('Erreur création paiement:', error);
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
      include: {
        eleve: {
          select: {
            id: true,
            nom: true,
            prenom: true,
            matricule: true
          }
        }
      },
      orderBy: { date_paiement: 'desc' }
    });
    res.json(paiements);
  } catch (error) {
    console.error('Erreur récupération paiements:', error);
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

// UPDATE Eleve financial status (manual adjustment)
app.put('/api/eleves/:id/financier', async (req, res) => {
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
