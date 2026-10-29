-- Password reset (outpost#206) and session revocation (the old #207).
--
-- "TeamMember"."sessionVersion" is copied into the JWT at sign-in and compared on
-- every server-side session read; a password reset, a profile password change, or a
-- disable bumps it, which revokes every older session. NOT NULL DEFAULT 0 with a
-- constant default is a catalog-only change on PG11+, so the ACCESS EXCLUSIVE lock on
-- "TeamMember" is brief. Every existing row starts at 0 and the callback treats a
-- token with no `sv` as 0, so no existing ACTIVE session is signed out by this deploy.
--
-- "PasswordResetToken" stores only sha256(token). "memberId" is deliberately not
-- unique: issuing deletes the member's unused rows explicitly and used rows stay for
-- a 7-day audit trail. "AuthRateLimit" is the fixed-window counter for the public
-- reset routes and the admin send.
--
-- Additive only. apps/web/start.sh and apps/worker/start.sh both run `migrate deploy`
-- against this database from the same commit; whichever starts first applies it, and
-- old replicas still running during the rollout ignore the new column and tables.
-- No lock_timeout, for the same reason as 20260820120000_add_job_claim_fencing:
-- waiting is recoverable, a half-recorded migration is not.

-- AlterTable
ALTER TABLE "TeamMember" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedVersion" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthRateLimit" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AuthRateLimit_pkey" PRIMARY KEY ("key","windowStart")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_memberId_idx" ON "PasswordResetToken"("memberId");

-- CreateIndex
CREATE INDEX "AuthRateLimit_windowStart_idx" ON "AuthRateLimit"("windowStart");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "TeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
