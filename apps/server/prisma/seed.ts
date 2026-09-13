import "dotenv/config";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const daemonHash = (token: string) => createHash("sha256").update(token).digest("hex");

async function main() {
  const users = [
    { id: "alice", name: "Alice Chen", username: "alice", avatarUrl: null, daemonTokenHash: daemonHash("alice-daemon-token") },
    { id: "bob", name: "Bob Martinez", username: "bob", avatarUrl: null, daemonTokenHash: daemonHash("bob-daemon-token") },
    { id: "charlie", name: "Charlie Okafor", username: "charlie", avatarUrl: null, daemonTokenHash: daemonHash("charlie-daemon-token") },
  ];
  for (const user of users) await prisma.user.upsert({ where: { id: user.id }, update: user, create: user });

  const repositoryUrl = process.env.DEMO_REPOSITORY_URL ?? "https://github.com/example/relaycode-demo.git";
  const parsed = repositoryUrl.replace(/\.git$/, "").split("/");
  const repositoryName = parsed.at(-1) ?? "relaycode-demo";
  const repositoryOwner = parsed.at(-2) ?? "example";
  await prisma.project.upsert({
    where: { id: "project-alpha" },
    update: { repositoryOwner, repositoryName, repositoryUrl },
    create: {
      id: "project-alpha",
      name: "RelayCode Demo",
      slug: "relaycode-demo",
      repositoryOwner,
      repositoryName,
      repositoryUrl,
      branch: process.env.DEMO_BRANCH ?? "main",
      coordinatorModel: "coordinator-lite",
      developerModel: "local-agent",
      installCommand: "npm install",
      frontendCommand: "npm run dev",
      backendCommand: "npm run server",
      testCommand: "npm test",
    },
  });
  for (const user of users) {
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: "project-alpha", userId: user.id } },
      update: { repositoryWrite: true, role: user.id === "alice" ? "OWNER" : "MEMBER" },
      create: { projectId: "project-alpha", userId: user.id, repositoryWrite: true, role: user.id === "alice" ? "OWNER" : "MEMBER" },
    });
  }
  const existing = await prisma.activityEvent.findFirst({ where: { projectId: "project-alpha", category: "SYSTEM", message: "Project ready for local companion connections" } });
  if (!existing) await prisma.activityEvent.create({ data: { projectId: "project-alpha", category: "SYSTEM", message: "Project ready for local companion connections", metadata: {} } });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("Seed failed", error instanceof Error ? error.message : "Unknown error");
    await prisma.$disconnect();
    process.exit(1);
  });
