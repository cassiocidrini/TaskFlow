/*
  Warnings:

  - A unique constraint covering the columns `[aggregate_id,version]` on the table `events` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "events_aggregate_id_version_idx";

-- CreateIndex
CREATE UNIQUE INDEX "events_aggregate_id_version_key" ON "events"("aggregate_id", "version");
