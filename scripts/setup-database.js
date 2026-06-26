/**
 * Applique le schéma Prisma (tables Annonce, ParentEleveLink, motif_rejet, etc.)
 * Usage: node scripts/setup-database.js
 */
const { execSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

function run(cmd, label) {
  console.log(`\n▶ ${label}…`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

try {
  run('npx prisma generate', 'Génération du client Prisma');
  run('npx prisma db push', 'Synchronisation de la base de données');
  console.log('\n✓ Base de données à jour (Annonce, ParentEleveLink, motif_rejet, …)\n');
} catch (error) {
  console.error('\n✗ Échec de la configuration de la base. Vérifiez DATABASE_URL dans .env\n');
  process.exit(1);
}
