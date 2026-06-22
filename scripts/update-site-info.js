const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const data = {
    nom_ecole: 'GSP Elhadj Mamadou Saïdou Diallo',
    email_contact: 'samakedelamou858@gmail.com',
    smtp_user: 'samakedelamou858@gmail.com',
    telephone: '+224 629 40 30 19',
    adresse: 'Labé, Guinée',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 587,
    smtp_secure: false,
  };

  const settings = await prisma.parametreSite.upsert({
    where: { id: 1 },
    update: data,
    create: { id: 1, ...data },
  });

  console.log('Paramètres enregistrés :');
  console.log('  E-mail :', settings.email_contact);
  console.log('  Téléphone :', settings.telephone);
  console.log('  Adresse :', settings.adresse);
  console.log('  SMTP :', settings.smtp_user);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
