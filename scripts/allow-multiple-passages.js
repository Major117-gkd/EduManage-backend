/**
 * Supprime la contrainte unique (1 passage/jour/classe) pour autoriser
 * plusieurs passages avec heures saisies manuellement.
 * Usage: node scripts/allow-multiple-passages.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'PresenceProfesseur_professeurId_classeId_date_presence_key'
      ) THEN
        ALTER TABLE "PresenceProfesseur"
        DROP CONSTRAINT "PresenceProfesseur_professeurId_classeId_date_presence_key";
        RAISE NOTICE 'Contrainte unique supprimée.';
      ELSE
        RAISE NOTICE 'Aucune contrainte unique à supprimer (déjà OK).';
      END IF;
    END $$;
  `);
  console.log('OK — plusieurs passages par jour autorisés.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
