// Creates (or updates the password of) the first admin account. There's
// deliberately no admin signup endpoint — admin accounts are provisioned
// out-of-band, by whoever has shell/DB access, not self-service.
//
// Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... npm run seed
// Add ADMIN_SUPER=true to also grant access to the Sumup page (monthly
// profit confirmation) — see `src/middleware/adminGuard.ts#superAdminGuard`.
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const isSuperAdmin = process.env.ADMIN_SUPER === 'true';

  if (!email || !password) {
    console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD env vars before running this script.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('ADMIN_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.adminUser.upsert({
    where: { email: email.toLowerCase() },
    create: { email: email.toLowerCase(), passwordHash, isSuperAdmin },
    update: { passwordHash, isSuperAdmin },
  });

  console.log(`Admin user ready: ${admin.email}${admin.isSuperAdmin ? ' (super admin)' : ''}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
