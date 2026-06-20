const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding en cours...');

  // Mot de passe: "password123"
  const hashedPassword = await bcrypt.hash('password123', 10);

  // Création ou mise à jour (upsert)
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

  console.log('Utilisateur de test créé avec succès !');
  console.log('--- Identifiants ---');
  console.log(`Email : ${admin.email}`);
  console.log(`Mot de passe : password123`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
