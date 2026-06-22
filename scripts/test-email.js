const { PrismaClient } = require('@prisma/client');
const { resolveSmtpConfig, createTransporter } = require('../emailService');

const prisma = new PrismaClient();

async function main() {
  const s = await prisma.parametreSite.findUnique({ where: { id: 1 } });
  const cfg = resolveSmtpConfig(s || {});

  console.log('Configuration actuelle :');
  console.log('  mail_enabled (UI) :', s?.mail_enabled);
  console.log('  MAIL_ENABLED (.env):', process.env.MAIL_ENABLED);
  console.log('  smtp_user         :', cfg.user || '—');
  console.log('  mot de passe      :', cfg.pass ? '✓ présent' : '✗ manquant');
  console.log('  email_contact     :', s?.email_contact);

  const transport = await createTransporter(s || {});
  if (transport.error) {
    console.log('\n✗ Connexion SMTP :', transport.error);
    if (transport.details) console.log('  Détail :', transport.details);
    return;
  }

  console.log('\n✓ Connexion SMTP OK — la configuration est valide.');
  console.log('  Utilisez « Envoyer un e-mail de test » dans Paramètres du site pour recevoir un message.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
