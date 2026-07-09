const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    const admin = await prisma.admin.create({
      data: { email: 'admin@sys.in', password: 'abc' }
    });
    console.log('Admin created:', admin);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await prisma.$disconnect();
  }
}
main();
