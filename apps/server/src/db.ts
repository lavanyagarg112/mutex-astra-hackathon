import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __relaycodePrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__relaycodePrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalThis.__relaycodePrisma = prisma;

