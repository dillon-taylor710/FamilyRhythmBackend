import { PrismaClient } from '@prisma/client';

// Single shared client — re-creating one per request exhausts Postgres
// connections under load and is the most common Prisma+Express mistake.
export const prisma = new PrismaClient();
