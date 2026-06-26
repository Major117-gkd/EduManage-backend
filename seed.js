const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding en cours...');

  const hashedPassword = await bcrypt.hash('password123', 10);

  const admin = await prisma.utilisateur.upsert({
    where: { email: 'admin@edumanage.fr' },
    update: {},
    create: {
      nom: 'Administrateur Principal',
      email: 'admin@edumanage.fr',
      mot_de_passe: hashedPassword,
      role: 'ADMIN',
    },
  });

  console.log('Admin:', admin.email);

  const eleve = await prisma.eleve.findFirst({
    where: { statut: 'Actif' },
    orderBy: { id: 'asc' },
  });

  if (eleve) {
    const studentEmail = `eleve.${eleve.matricule.toLowerCase().replace(/[^a-z0-9]/g, '')}@gsp.local`;
    const student = await prisma.utilisateur.upsert({
      where: { email: studentEmail },
      update: { eleveId: eleve.id, role: 'ELEVE' },
      create: {
        nom: `${eleve.prenom} ${eleve.nom}`,
        email: studentEmail,
        mot_de_passe: hashedPassword,
        role: 'ELEVE',
        eleveId: eleve.id,
        photoUrl: eleve.photoUrl || null,
      },
    });
    console.log('Compte élève:', student.email, '→', eleve.matricule);
  } else {
    console.log('Aucun élève actif — compte élève non créé.');
  }

  console.log('--- Identifiants test ---');
  console.log('Admin  : admin@edumanage.fr / password123');
  if (eleve) {
    console.log(`Élève  : identifiant ${eleve.matricule} / password123 (${eleve.prenom} ${eleve.nom})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
