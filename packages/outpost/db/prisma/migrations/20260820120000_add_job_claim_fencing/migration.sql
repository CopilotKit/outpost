-- Fences writes to the worker execution that owns a claim, and records the
-- deadline that execution was granted so reclaim has a single authority.
--
-- Additive and nullable with no backfill, which is deliberate: a NULL claimToken
-- on an in-flight row means "claimed before this deployed", and the reclaim's
-- legacy branch handles those on an absolute ceiling instead of a granted
-- deadline.
--
-- On ordering: `apps/worker/start.sh` runs `migrate deploy` at container start,
-- so this ships WITH the new code rather than ahead of it. There is no two-phase
-- deploy here. What makes that safe is the additive-nullable shape, not any
-- sequencing guarantee -- during the rollout an old replica's unfenced
-- `prisma.job.update` writes race the new replica's fenced ones, and the old
-- replica simply does not see these columns.
--
-- Takes ACCESS EXCLUSIVE on "Job" for the length of this transaction. That is
-- brief for a nullable ADD COLUMN with no default (a catalog-only change in
-- PG11+), but it does queue behind in-flight claim UPDATEs and block everything
-- behind it while it waits. Deliberately no `lock_timeout`: a statement that
-- times out here aborts the migration, and `migrate deploy` records the failure
-- in `_prisma_migrations` with `finished_at = NULL`, which is the P3009 state
-- `start.sh` exists to diagnose and which needs a manual `migrate resolve`.
-- Waiting is recoverable; a half-recorded migration is not. Same trade `start.sh`
-- makes when it leaves `migrate deploy` unbounded.
ALTER TABLE "Job"
ADD COLUMN "claimToken" TEXT,
ADD COLUMN "lockUntil" TIMESTAMP(3);
