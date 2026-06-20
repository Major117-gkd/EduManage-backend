require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

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
    const profs = await prisma.professeur.findMany({ orderBy: { nom: 'asc' }, include: { matieres: { include: { classe: true } } } });
    res.json(profs);
  } catch (error) {
    res.status(500).json({ error: 'Erreur interne.' });
  }
});



// LIST all Eleves
app.get('/api/admin/eleves', async (req, res) => {
  try {
    const eleves = await prisma.eleve.findMany({
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
  const { nom, prenom, date_naissance, adresse, parent_nom, parent_telephone, parent_email, filiation, infos_importantes, classeId, annee_scolaire, matricule, photoUrl } = req.body;
  try {
    // Generate a unique matricule if not provided
    const count = await prisma.eleve.count();
    const finalMatricule = matricule ? matricule : `GSP-${String(count + 1).padStart(4, '0')}`;

    const eleve = await prisma.$transaction(async (tx) => {
      const newEleve = await tx.eleve.create({
        data: { matricule: finalMatricule, nom, prenom, date_naissance: date_naissance ? new Date(date_naissance) : null, adresse, parent_nom, parent_telephone, parent_email, filiation, infos_importantes, photoUrl }
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
  const { prenom, nom, date_naissance, adresse, parent_nom, filiation, parent_telephone, parent_email, infos_importantes, photoUrl } = req.body;
  const eleveId = parseInt(req.params.id);
  try {
    const eleve = await prisma.eleve.update({
      where: { id: eleveId },
      data: {
        prenom, nom, 
        date_naissance: date_naissance ? new Date(date_naissance) : null,
        adresse, parent_nom, filiation, parent_telephone, parent_email, infos_importantes, photoUrl
      }
    });
    res.json({ message: 'Élève mis à jour avec succès', eleve });
  } catch (error) {
    console.error('Erreur mise à jour élève:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// DELETE an Eleve
app.delete('/api/admin/eleves/:id', async (req, res) => {
  const eleveId = parseInt(req.params.id);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.note.deleteMany({ where: { eleveId } });
      await tx.resultat.deleteMany({ where: { eleveId } });
      await tx.inscription.deleteMany({ where: { eleveId } });
      await tx.eleve.delete({ where: { id: eleveId } });
    });
    res.json({ message: 'Élève supprimé avec succès' });
  } catch (error) {
    console.error('Erreur suppression élève:', error);
    res.status(500).json({ error: 'Erreur interne.' });
  }
});

// CREATE a Re-registration (nouvelle inscription pour un élève existant)
app.post('/api/admin/eleves/:id/reinscription', async (req, res) => {
  const { classeId, annee_scolaire } = req.body;
  const eleveId = parseInt(req.params.id);
  try {
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
  const { nom, niveau, capacite, anneeScolaireId } = req.body;
  try {
    const newClass = await prisma.classe.create({
      data: {
        nom,
        niveau,
        capacite: parseInt(capacite) || 30,
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
  const { nom, niveau, capacite, anneeScolaireId } = req.body;
  try {
    const updatedClass = await prisma.classe.update({
      where: { id },
      data: {
        nom,
        niveau,
        capacite: parseInt(capacite) || 30,
        anneeScolaireId: anneeScolaireId ? parseInt(anneeScolaireId) : null
      }
    });
    res.json(updatedClass);
  } catch (error) {
    console.error("Erreur modification classe:", error);
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
    const totalEleves = await prisma.eleve.count();
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

    const levelCounts = { 'Maternelle': 0, 'Primaire': 0, 'Collège': 0, 'Lycée': 0 };
    classes.forEach(c => {
      if (levelCounts[c.niveau] !== undefined) {
        levelCounts[c.niveau] += c._count.inscriptions;
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
app.get('/api/admin/classes/:classeId/matieres/:matiereId/notes', async (req, res) => {
  const classeId = parseInt(req.params.classeId);
  const matiereId = parseInt(req.params.matiereId);
  const { periode } = req.query;

  try {
    // Get all validated students in this class
    const inscriptions = await prisma.inscription.findMany({
      where: { classeId, statut: 'Validé' },
      include: {
        eleve: {
          include: {
            notes: {
              where: {
                matiereId,
                ...(periode ? { periode } : {})
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
//  RESULTATS (Results / Bulletins) ROUTES
// ═══════════════════════════════════════════════

// Get full results for a class (bulletin data)
app.get('/api/admin/classes/:id/bulletins', async (req, res) => {
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
          include: {
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
        const moyMatiere = notesEleve.length > 0
          ? (notesEleve.reduce((s, n) => s + n.valeur, 0) / notesEleve.length).toFixed(2)
          : null;
        return {
          matiereId: mat.id,
          matiere: mat.nom,
          coefficient: mat.coefficient,
          professeur: `${mat.professeur.prenom} ${mat.professeur.nom}`,
          notes: notesEleve.map(n => ({ id: n.id, valeur: n.valeur, type: n.type_evaluation, appreciation: n.appreciation })),
          moyenne: moyMatiere
        };
      });

      // Calculate general average (weighted)
      const matiereAvecMoyenne = notesParMatiere.filter(m => m.moyenne !== null);
      const totalCoeff = matiereAvecMoyenne.reduce((s, m) => s + m.coefficient, 0);
      const totalPoints = matiereAvecMoyenne.reduce((s, m) => s + (parseFloat(m.moyenne) * m.coefficient), 0);
      const moyenneGenerale = totalCoeff > 0 ? (totalPoints / totalCoeff).toFixed(2) : null;

      return {
        eleveId: eleve.id,
        nom: eleve.nom,
        prenom: eleve.prenom,
        matricule: eleve.matricule,
        matieres: notesParMatiere,
        moyenneGenerale
      };
    });

    // Calculate class rank
    const sorted = [...bulletins].filter(b => b.moyenneGenerale !== null).sort((a, b) => parseFloat(b.moyenneGenerale) - parseFloat(a.moyenneGenerale));
    bulletins.forEach(b => {
      b.rang = sorted.findIndex(s => s.eleveId === b.eleveId) + 1 || '-';
    });

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

    // Calculate averages (simplified for example)
    const resultats = inscriptions.map(ins => {
      const notes = ins.eleve.notes;
      const totalCoeff = notes.reduce((sum, n) => sum + n.matiere.coefficient, 0);
      const totalPoints = notes.reduce((sum, n) => sum + (n.valeur * n.matiere.coefficient), 0);
      const moyenne = totalCoeff > 0 ? (totalPoints / totalCoeff).toFixed(2) : 'N/A';

      return {
        eleve: `${ins.eleve.prenom} ${ins.eleve.nom}`,
        moyenne,
        details: notes.map(n => ({
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

// Add a Teacher (creates User and Professeur)
app.post('/api/admin/professeurs', async (req, res) => {
  const { nom, prenom, email, specialite, contact, matieresIds } = req.body;
  try {
    const hashedPassword = await bcrypt.hash('Prof2024', 10);
    
    // Create User AND Professeur in a transaction
    const newProf = await prisma.$transaction(async (tx) => {
      const user = await tx.utilisateur.create({
        data: {
          nom: `${prenom} ${nom}`,
          email,
          mot_de_passe: hashedPassword,
          role: 'PROFESSEUR'
        }
      });
      
      const prof = await tx.professeur.create({
        data: {
          utilisateurId: user.id,
          nom,
          prenom,
          specialite,
          contact
        }
      });

      if (matieresIds && matieresIds.length > 0) {
        await tx.matiere.updateMany({
          where: { id: { in: matieresIds } },
          data: { professeurId: prof.id }
        });
      }

      return prof;
    });
    
    res.json({ message: 'Professeur créé avec succès', professeur: newProf });
  } catch (error) {
    console.error("Erreur création prof:", error);
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

// Get Teacher's assigned classes and subjects
app.get('/api/teacher/matieres', async (req, res) => {
  try {
    // For demo purposes: find the first Professeur if ID not provided
    const prof = await prisma.professeur.findFirst();
    if (!prof) return res.status(404).json({ error: 'Aucun professeur trouvé' });

    const matieres = await prisma.matiere.findMany({
      where: { professeurId: prof.id },
      include: { classe: true }
    });

    res.json({ matieres });
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
        // Average note for this subject for this student in this period
        const notes = await prisma.note.findMany({
          where: { eleveId: ins.eleveId, matiereId: matiere.id, periode, annee_scolaire }
        });

        if (notes.length > 0) {
          const avgSubject = notes.reduce((acc, n) => acc + n.valeur, 0) / notes.length;
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
      const classes = await prisma.classe.findMany({ where: { niveau } });
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

// Port
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
