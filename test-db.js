const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  try {
    await prisma.$connect();
    console.log("SUCCESS");
  } catch (e) {
    console.log("ERROR", e);
  } finally {
    await prisma.$disconnect();
  }
}
main();
