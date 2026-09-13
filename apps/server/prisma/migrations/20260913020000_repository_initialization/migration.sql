CREATE TYPE "TaskExecutionMode" AS ENUM ('NORMAL', 'INITIALIZATION');

ALTER TABLE "Task"
ADD COLUMN "executionMode" "TaskExecutionMode" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN "initializationConfig" JSONB;
