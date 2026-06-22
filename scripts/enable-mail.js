const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  await prisma.parametreSite.upsert({
    where: { id: 1 },
    update: {
      mail_enabled: true,
      smtp_user: 'samakedelamou858@gmail.com',
      email_contact: 'samakedelamou858@gmail.com',
    },
    create: {
      id: 1,
      mail_enabled: true,
      smtp_user: 'samakedelamou858@gmail.com',
      email_contact: 'samakedelamou858@gmail.com',
    },
  });
  console.log('mail_enabled activé dans la base.');
}

main()
  .finally(() => prisma.$disconnect());
