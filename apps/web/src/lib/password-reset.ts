import { createHash, randomBytes } from 'crypto';
import { prisma } from '@copilotkit/outpost/db';
import { sendEmail } from '@copilotkit/outpost/shared/server';

export const RESET_TTL_MS = 30 * 60 * 1000;
export const RESET_TTL_TEXT = '30 minutes';
const AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

export interface ResetMember {
    id: string;
    email: string;
    sessionVersion: number;
}

/** 256 bits as hex: only [0-9a-f], so nothing in it is Markdown or HTML syntax. */
export function generateResetToken(): string {
    return randomBytes(32).toString('hex');
}

/** Only this hash is stored. 256 bits of entropy make a fast unsalted hash correct. */
export function hashResetToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export function isWellFormedResetToken(token: unknown): token is string {
    return typeof token === 'string' && TOKEN_SHAPE.test(token);
}

/**
 * The link base is NEXTAUTH_URL only, never the request's Host or X-Forwarded-Host,
 * which an attacker controls (reset-link poisoning). The token goes in the fragment,
 * which browsers never send to a server, so it stays out of request logs and Referer.
 * In production with NEXTAUTH_URL unset this returns null: no localhost fallback.
 */
export function buildResetUrl(token: string): string | null {
    const base = process.env.NEXTAUTH_URL;
    if (!base) {
        if (process.env.NODE_ENV === 'production') return null;
        return `http://localhost:3000/reset-password#token=${token}`;
    }
    return `${base.replace(/\/+$/, '')}/reset-password#token=${token}`;
}

async function orgContext(): Promise<{ name: string; email: string }> {
    const org = await prisma.organization.findFirst();
    return { name: org?.name || 'Outpost', email: org?.email || 'noreply@outpost.dev' };
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Issue a reset link and email it. Shared by the self-service request route and the
 * admin route so both produce identical tokens and emails.
 *
 * Precondition (checked by the caller): the member is ACTIVE and has a password.
 * Does not change sessionVersion: a link revokes nothing until it is used. Never
 * returns or logs the token, its hash, or the URL. A failed send keeps the previous
 * link working; only a delivered link replaces it.
 */
export async function issuePasswordReset(
    member: ResetMember,
    { requestedById }: { requestedById: string | null },
): Promise<{ emailSent: boolean }> {
    const token = generateResetToken();
    const url = buildResetUrl(token);
    if (!url) {
        console.error(
            `[PASSWORD_RESET] NEXTAUTH_URL is not set; not sending memberId=${member.id}`,
        );
        return { emailSent: false };
    }

    const now = Date.now();
    const issued = await prisma.passwordResetToken.create({
        data: {
            memberId: member.id,
            tokenHash: hashResetToken(token),
            issuedVersion: member.sessionVersion,
            expiresAt: new Date(now + RESET_TTL_MS),
            requestedById,
        },
    });

    if (requestedById) {
        console.info(`[PASSWORD_RESET] admin-issued memberId=${member.id} by=${requestedById}`);
    } else {
        console.info(`[PASSWORD_RESET] issued memberId=${member.id}`);
    }

    const emailSent = await sendResetEmail(member, url);
    try {
        if (!emailSent) {
            // The member never got this link, so drop it. Their previous link, if any,
            // is untouched and still works.
            await prisma.passwordResetToken.deleteMany({ where: { id: issued.id } });
            return { emailSent: false };
        }
        // Delivered: unused links created before this one stop working. When two issues
        // overlap, both links can work until the newer one reaches this step; then only it
        // does. createdAt has millisecond precision, so two issues can tie; the row with the
        // greater id wins the tie, so exactly one of them stays live.
        // Used rows stay as an audit trail. Any row older than 7 days is dropped here, so
        // that trail is trimmed only when this member next gets a reset email.
        // Lock order is the same as consumePasswordReset: member row first, then tokens.
        // Without it, this delete can hold an older link's row while it waits on a link a
        // confirm has claimed, and the confirm's sibling sweep waits on that older row:
        // Postgres 40P01, a 500 for the user.
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "TeamMember" WHERE "id" = ${member.id} FOR UPDATE`;
            await tx.passwordResetToken.deleteMany({
                where: {
                    memberId: member.id,
                    OR: [
                        { usedAt: null, createdAt: { lt: issued.createdAt } },
                        { usedAt: null, createdAt: issued.createdAt, id: { lt: issued.id } },
                        { createdAt: { lt: new Date(now - AUDIT_RETENTION_MS) } },
                    ],
                },
            });
        });
    } catch (err) {
        // The email outcome is already decided; a cleanup failure does not change it.
        console.error(
            `[PASSWORD_RESET] token cleanup failed memberId=${member.id} error=${errorText(err)}`,
        );
    }
    return { emailSent };
}

async function sendResetEmail(member: ResetMember, url: string): Promise<boolean> {
    try {
        const result = await sendEmail({
            to: member.email,
            template: 'system/password-reset',
            context: {
                org: await orgContext(),
                // Never member.name: interpolation does no HTML escaping and the name is user-editable.
                member: { email: member.email },
                reset: { url, expiresIn: RESET_TTL_TEXT },
            },
            requireTransport: true,
            trackLinks: 'None',
        });
        if (!result.success) {
            console.error(
                `[PASSWORD_RESET] send failed memberId=${member.id} error=${result.error ?? 'unknown'}`,
            );
            return false;
        }
        return true;
    } catch (err) {
        console.error(`[PASSWORD_RESET] send failed memberId=${member.id} error=${errorText(err)}`);
        return false;
    }
}

/**
 * Valid when the row exists, is unused and unexpired, the member is ACTIVE, and no
 * password change has happened since issue (sessionVersion === issuedVersion).
 * Unknown, used, expired, and stale tokens are indistinguishable to the caller.
 */
export async function isResetTokenValid(token: unknown): Promise<boolean> {
    if (!isWellFormedResetToken(token)) return false;
    const row = await prisma.passwordResetToken.findUnique({
        where: { tokenHash: hashResetToken(token) },
        include: { member: { select: { status: true, sessionVersion: true } } },
    });
    return (
        !!row &&
        row.usedAt === null &&
        row.expiresAt.getTime() > Date.now() &&
        row.member.status === 'ACTIVE' &&
        row.member.sessionVersion === row.issuedVersion
    );
}

class StaleResetToken extends Error {}

export type ConsumeResult = { ok: true; member: { id: string; email: string } } | { ok: false };

/**
 * Set the new password (already hashed by the caller, outside the transaction) and
 * revoke every session. Single use even under concurrency: only one request can win
 * the conditional claim, and the member write is a compare-and-set on the version the
 * token was issued against.
 *
 * Lock order is member row first, then tokens. Two links for the same member can be
 * live at once (see issuePasswordReset). Without the member lock up front, confirm A
 * holds the member row and waits on B's claimed token in the sibling sweep, while B
 * holds that token and waits on the member row: Postgres 40P01, a 500 for the user.
 */
export async function consumePasswordReset(
    token: unknown,
    passwordHash: string,
): Promise<ConsumeResult> {
    if (!isWellFormedResetToken(token)) return { ok: false };
    const tokenHash = hashResetToken(token);
    const now = new Date();

    try {
        return await prisma.$transaction(async (tx) => {
            // Serializes every consume for this member. A token's memberId never changes.
            await tx.$queryRaw`
                SELECT m."id" FROM "TeamMember" m
                JOIN "PasswordResetToken" t ON t."memberId" = m."id"
                WHERE t."tokenHash" = ${tokenHash}
                FOR UPDATE OF m`;

            const claimed = await tx.passwordResetToken.updateMany({
                where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
                data: { usedAt: now },
            });
            if (claimed.count !== 1) return { ok: false } as const;

            const row = await tx.passwordResetToken.findUnique({
                where: { tokenHash },
                include: {
                    member: {
                        select: { id: true, email: true, status: true, sessionVersion: true },
                    },
                },
            });
            if (
                !row ||
                row.member.status !== 'ACTIVE' ||
                row.member.sessionVersion !== row.issuedVersion
            ) {
                throw new StaleResetToken();
            }

            const updated = await tx.teamMember.updateMany({
                where: { id: row.memberId, status: 'ACTIVE', sessionVersion: row.issuedVersion },
                data: { passwordHash, sessionVersion: { increment: 1 } },
            });
            if (updated.count !== 1) throw new StaleResetToken();

            await tx.passwordResetToken.updateMany({
                where: { memberId: row.memberId, usedAt: null },
                data: { usedAt: now },
            });
            return { ok: true, member: { id: row.member.id, email: row.member.email } } as const;
        });
    } catch (err) {
        if (err instanceof StaleResetToken) return { ok: false };
        throw err;
    }
}

/** The "your password was changed" notice. Failures are logged, never thrown. */
export async function sendPasswordChangedEmail(member: {
    id: string;
    email: string;
}): Promise<void> {
    try {
        const result = await sendEmail({
            to: member.email,
            template: 'system/password-changed',
            context: { org: await orgContext(), member: { email: member.email } },
            requireTransport: true,
        });
        if (!result.success) {
            console.error(
                `[PASSWORD_RESET] send failed memberId=${member.id} error=${result.error ?? 'unknown'}`,
            );
        }
    } catch (err) {
        console.error(`[PASSWORD_RESET] send failed memberId=${member.id} error=${errorText(err)}`);
    }
}
