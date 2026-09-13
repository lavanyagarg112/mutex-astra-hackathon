import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const users = [
    { id: "alice", name: "Alice Chen", username: "alice", avatarUrl: null },
    { id: "bob", name: "Bob Martinez", username: "bob", avatarUrl: null },
    { id: "charlie", name: "Charlie Okafor", username: "charlie", avatarUrl: null },
  ];
  for (const user of users) await prisma.user.upsert({ where: { id: user.id }, update: user, create: user });

  // Remove the legacy showcase project if an older local database contains it.
  // Real projects created by users are never touched by the seed command.
  await prisma.project.deleteMany({ where: { id: "project-alpha" } });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("Seed failed", error instanceof Error ? error.message : "Unknown error");
    await prisma.$disconnect();
    process.exit(1);
  });
