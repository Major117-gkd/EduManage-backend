/**
 * Ajoute eleveId sur Utilisateur pour l'espace élève.
 * Usage: node scripts/add-student-account-link.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Utilisateur" ADD COLUMN IF NOT EXISTS "eleveId" INTEGER;
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Utilisateur_eleveId_key'
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'Utilisateur_eleveId_key'
      ) THEN
        ALTER TABLE "Utilisateur"
        ADD CONSTRAINT "Utilisateur_eleveId_key" UNIQUE ("eleveId");
      END IF;
    END $$;
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Utilisateur_eleveId_fkey'
      ) THEN
        ALTER TABLE "Utilisateur"
        ADD CONSTRAINT "Utilisateur_eleveId_fkey"
        FOREIGN KEY ("eleveId") REFERENCES "Eleve"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$;
  `);

  console.log('OK — colonne eleveId prête pour les comptes élèves.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
