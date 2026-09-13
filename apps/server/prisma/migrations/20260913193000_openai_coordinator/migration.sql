ALTER TABLE "Project" ALTER COLUMN "coordinatorModel" SET DEFAULT 'gpt-5-mini';

UPDATE "Project"
SET "coordinatorModel" = 'gpt-5-mini'
WHERE "coordinatorModel" IN ('coordinator-lite', 'local-classifier');
