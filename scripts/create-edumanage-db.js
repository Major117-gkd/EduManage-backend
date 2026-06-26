/**
 * Crée la base PostgreSQL "edumanage" si elle n'existe pas.
 * Usage: node scripts/create-edumanage-db.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant dans .env');

  const adminUrl = url.replace(/\/([^/?]+)(\?|$)/, '/postgres$2');
  const prisma = new PrismaClient({ datasources: { db: { url: adminUrl } } });

  const existing = await prisma.$queryRaw`
    SELECT 1 AS ok FROM pg_database WHERE datname = 'edumanage'
  `;

  if (existing.length) {
    console.log('La base "edumanage" existe déjà.');
  } else {
    await prisma.$executeRawUnsafe('CREATE DATABASE edumanage');
    console.log('Base "edumanage" créée.');
  }

  await prisma.$disconnect();

  const newUrl = url.replace(/\/([^/?]+)(\?|$)/, '/edumanage$2');
  console.log('\nMettez à jour DATABASE_URL dans .env :');
  console.log(newUrl.replace(/:([^:@]+)@/, ':***@'));
  console.log('\nPuis exécutez :');
  console.log('  npx prisma db push');
  console.log('  node scripts/add-student-account-link.js');
  console.log('  node seed.js');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
