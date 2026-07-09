const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.admin.deleteMany().then(() => console.log('Cleaned')).finally(() => prisma.$disconnect());
