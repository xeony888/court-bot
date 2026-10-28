import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { env } from "./env.js";

export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.databaseUrl }) });

export async function getSettings() {
  return prisma.settings.upsert({ where: { id: 1 }, create: {}, update: {} });
}
