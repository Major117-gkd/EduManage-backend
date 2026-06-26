/**
 * Vérifie que la base pointée par DATABASE_URL contient les tables EduManage.
 * Usage: node scripts/check-db.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const url = process.env.DATABASE_URL || '';
  const dbMatch = url.match(/\/([^/?]+)(\?|$)/);
  const dbName = dbMatch ? dbMatch[1] : '?';

  const tables = await prisma.$queryRaw`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `;

  const names = tables.map((t) => t.table_name);
  const required = ['Utilisateur', 'Eleve', 'Classe'];
  const missing = required.filter((t) => !names.includes(t));

  console.log(`Base connectée : ${dbName}`);
  console.log(`Tables (${names.length}) : ${names.slice(0, 12).join(', ')}${names.length > 12 ? '…' : ''}`);

  if (missing.length) {
    console.error('\n❌ Tables EduManage manquantes :', missing.join(', '));
    console.error('→ Corrigez DATABASE_URL dans .env (ex. base edumanage dédiée), puis :');
    console.error('   npx prisma db push');
    console.error('   node scripts/add-student-account-link.js');
    console.error('   node seed.js');
    process.exit(1);
  }

  const cols = await prisma.$queryRaw`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Utilisateur'
  `;
  const hasEleveId = cols.some((c) => c.column_name === 'eleveId');
  if (!hasEleveId) {
    console.log('\n⚠ Colonne Utilisateur.eleveId absente — exécutez : node scripts/add-student-account-link.js');
  } else {
    console.log('\n✓ Colonne Utilisateur.eleveId présente.');
  }
}

main()
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
