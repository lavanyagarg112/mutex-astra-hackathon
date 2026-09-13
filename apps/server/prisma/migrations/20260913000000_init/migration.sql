CREATE TYPE "ProjectRole" AS ENUM ('OWNER', 'MEMBER');
CREATE TYPE "TaskType" AS ENUM ('NORMAL', 'REFINEMENT');
CREATE TYPE "TaskStatus" AS ENUM ('QUEUED', 'WAITING_FOR_REQUESTER', 'SYNCING', 'PLANNING', 'EDITING', 'VALIDATING', 'PUSHING', 'SYNCING_TEAM', 'COMMITTED', 'PAUSED', 'FAILED', 'CANCELLED', 'REMOTE_DIVERGED', 'ROLLED_BACK', 'DISCARDED_BY_ROLLBACK');
CREATE TYPE "TaskMessageRole" AS ENUM ('INITIAL', 'IN_FLIGHT_REFINEMENT');

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "avatarUrl" TEXT,
  "daemonTokenHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Project" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "repositoryOwner" TEXT NOT NULL,
  "repositoryName" TEXT NOT NULL,
  "repositoryUrl" TEXT NOT NULL,
  "branch" TEXT NOT NULL DEFAULT 'main',
  "coordinatorModel" TEXT NOT NULL DEFAULT 'coordinator-lite',
  "developerModel" TEXT NOT NULL DEFAULT 'local-agent',
  "agentCredential" TEXT,
  "toolPermissions" JSONB NOT NULL DEFAULT '{"fileRead":true,"fileWrite":true,"shell":true,"git":true,"tests":true,"network":false}',
  "installCommand" TEXT,
  "frontendCommand" TEXT,
  "backendCommand" TEXT,
  "testCommand" TEXT,
  "rollbackLocked" BOOLEAN NOT NULL DEFAULT false,
  "nextTaskNumber" INTEGER NOT NULL DEFAULT 1,
  "nextQueueSequence" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectMember" (
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "ProjectRole" NOT NULL DEFAULT 'MEMBER',
  "repositoryWrite" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("projectId", "userId")
);

CREATE TABLE "Message" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "replyToMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Task" (
  "id" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "projectId" TEXT NOT NULL,
  "rootMessageId" TEXT NOT NULL,
  "parentTaskId" TEXT,
  "type" "TaskType" NOT NULL,
  "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
  "queuePriority" INTEGER NOT NULL,
  "queueSequence" INTEGER NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "executorUserId" TEXT,
  "baseCommitSha" TEXT,
  "commitSha" TEXT,
  "amendable" BOOLEAN NOT NULL DEFAULT false,
  "shortStatus" TEXT,
  "diff" JSONB,
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskMessage" (
  "taskId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "role" "TaskMessageRole" NOT NULL,
  CONSTRAINT "TaskMessage_pkey" PRIMARY KEY ("taskId", "messageId")
);

CREATE TABLE "RollbackAction" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "targetTaskId" TEXT NOT NULL,
  "initiatedById" TEXT NOT NULL,
  "targetCommitSha" TEXT NOT NULL,
  "previousHeadSha" TEXT,
  "status" TEXT NOT NULL,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "RollbackAction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivityEvent" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "taskId" TEXT,
  "userId" TEXT,
  "category" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
CREATE UNIQUE INDEX "Task_rootMessageId_key" ON "Task"("rootMessageId");
CREATE UNIQUE INDEX "Task_projectId_number_key" ON "Task"("projectId", "number");
CREATE INDEX "Task_projectId_queuePriority_queueSequence_idx" ON "Task"("projectId", "queuePriority", "queueSequence");
CREATE UNIQUE INDEX "TaskMessage_messageId_key" ON "TaskMessage"("messageId");
CREATE INDEX "ActivityEvent_projectId_createdAt_idx" ON "ActivityEvent"("projectId", "createdAt");

ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_rootMessageId_fkey" FOREIGN KEY ("rootMessageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_executorUserId_fkey" FOREIGN KEY ("executorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaskMessage" ADD CONSTRAINT "TaskMessage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskMessage" ADD CONSTRAINT "TaskMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RollbackAction" ADD CONSTRAINT "RollbackAction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RollbackAction" ADD CONSTRAINT "RollbackAction_targetTaskId_fkey" FOREIGN KEY ("targetTaskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RollbackAction" ADD CONSTRAINT "RollbackAction_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

