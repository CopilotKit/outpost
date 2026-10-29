import type { NextAuthOptions, Profile } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import type { OAuthConfig } from 'next-auth/providers/oauth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GithubProvider from 'next-auth/providers/github';
import { prisma } from '@copilotkit/outpost/db';
import { verifyPassword } from '@copilotkit/outpost/shared';
import { providerHasSessionCheck } from '@/lib/auth-provider';

// `||` rather than `??`, matching the client's read in src/app/login/page.tsx. A blank value
// is easy to produce in a dashboard, and `??` would accept '' — the server would then fall
// through to the `default:` arm below and throw `Unknown AUTH_PROVIDER:` while the client
// silently fell back to credentials. Both halves must treat empty as "not configured" for
// the two to stay in agreement.
const AUTH_PROVIDER = process.env.AUTH_PROVIDER || 'credentials';

// ─── Provider Factories ────────────────────────────────────────────────────

function buildCredentialsProvider() {
    return CredentialsProvider({
        name: 'Credentials',
        credentials: {
            email: { label: 'Email', type: 'email' },
            password: { label: 'Password', type: 'password' },
        },
        async authorize(credentials) {
            if (!credentials?.email || !credentials?.password) {
                return null;
            }

            // Setup, OIDC, and invite-accept all store emails lowercased, so
            // normalize here too. Otherwise `Alex@…` silently fails with the
            // right password.
            const email = credentials.email.toLowerCase();

            const member = await prisma.teamMember.findUnique({
                where: { email },
            });

            if (!member || !member.passwordHash) {
                return null;
            }

            const valid = await verifyPassword(credentials.password, member.passwordHash);
            if (!valid) {
                return null;
            }

            // Checked after the password so a disabled account and a wrong password
            // take the same time. Without this a DISABLED member with a password
            // could still sign in.
            if (member.status !== 'ACTIVE') {
                return null;
            }

            return {
                id: member.id,
                name: member.name,
                email: member.email,
                image: member.avatarUrl,
                role: member.role,
                sessionVersion: member.sessionVersion,
            };
        },
    });
}

function buildGithubProvider() {
    return GithubProvider({
        clientId: process.env.GITHUB_CLIENT_ID ?? '',
        clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
        authorization: {
            params: {
                scope: 'read:user user:email read:org',
            },
        },
    });
}

function buildOidcProvider(): OAuthConfig<Profile> {
    return {
        id: 'oidc',
        name: 'SSO',
        type: 'oauth',
        wellKnown: `${process.env.OIDC_ISSUER}/.well-known/openid-configuration`,
        clientId: process.env.OIDC_CLIENT_ID ?? '',
        clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
        authorization: { params: { scope: 'openid email profile' } },
        idToken: true,
        checks: ['pkce', 'state'],
        profile(profile) {
            return {
                id: profile.sub ?? '',
                name: (profile.name ?? profile.email ?? '') as string,
                email: profile.email as string,
                image: ((profile as Record<string, unknown>).picture ?? profile.image ?? null) as
                    | string
                    | null,
            };
        },
    };
}

// ─── GitHub org gating (only used when AUTH_PROVIDER=github) ───────────────

const ALLOWED_ORG = process.env.GITHUB_ALLOWED_ORG ?? 'CopilotKit';
const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN ?? '';

async function githubSignInGate(
    account: Record<string, unknown> | null,
    profile?: Record<string, unknown>,
): Promise<boolean | string> {
    if (ALLOWED_EMAIL_DOMAIN && profile?.email) {
        if ((profile.email as string).endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
            return true;
        }
    }

    if (ALLOWED_ORG && account?.access_token) {
        try {
            const res = await fetch(
                `https://api.github.com/orgs/${ALLOWED_ORG}/members/${profile?.login}`,
                {
                    headers: {
                        Authorization: `Bearer ${account.access_token}`,
                    },
                },
            );
            if (res.status === 204) {
                return true;
            }
        } catch {
            // Fall through to deny
        }
    }

    if (!ALLOWED_ORG && !ALLOWED_EMAIL_DOMAIN) {
        return true;
    }

    return '/login?error=AccessDenied';
}

// ─── OIDC domain gating + auto-provisioning ───────────────────────────────

async function oidcSignInGate(
    user: { id?: string; name?: string | null; email?: string | null; image?: string | null },
    profile?: Record<string, unknown>,
): Promise<boolean | string> {
    const email = ((user.email ?? profile?.email ?? '') as string).toLowerCase();

    if (!email) {
        return '/login?error=AccessDenied';
    }

    if (ALLOWED_EMAIL_DOMAIN) {
        if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN.toLowerCase()}`)) {
            return '/login?error=AccessDenied';
        }
    }

    const name = (user.name ?? profile?.name ?? email.split('@')[0]) as string;
    const avatarUrl = (user.image ?? null) as string | null;

    // Sign-in must leave an ACTIVE member behind or refuse. The per-request session
    // check (assertSessionCurrent) signs out anything else, so letting an INVITED or
    // DISABLED member through here would sign them out on every request.
    try {
        const existing = await prisma.teamMember.findUnique({
            where: { email },
            select: { id: true, status: true },
        });

        if (!existing) {
            await prisma.teamMember.create({
                data: {
                    name,
                    email,
                    role: 'MEMBER',
                    status: 'ACTIVE',
                    joinedAt: new Date(),
                    avatarUrl,
                },
            });
            return true;
        }

        if (existing.status === 'ACTIVE') {
            await prisma.teamMember.update({
                where: { id: existing.id },
                data: { name, avatarUrl },
            });
            return true;
        }

        if (existing.status === 'INVITED') {
            // Same transition invite-accept makes. OIDC already auto-provisions any
            // allowed-domain email as ACTIVE, so this grants nothing new.
            await prisma.teamMember.update({
                where: { id: existing.id },
                data: { name, avatarUrl, status: 'ACTIVE', joinedAt: new Date() },
            });
            return true;
        }

        // DISABLED, and any status added later: fail closed.
        return '/login?error=AccessDenied';
    } catch (error) {
        console.error(
            '[OIDC Auth] Auto-provisioning failed:',
            error instanceof Error ? error.message : String(error),
        );
        return '/login?error=AccessDenied';
    }
}

// ─── Session revocation (credentials + OIDC) ──────────────────────────────

/**
 * Throws when the session behind `token` has been revoked: the member is gone,
 * is not ACTIVE, or has a different sessionVersion than the token carries.
 * Otherwise refreshes `token.role` from the database, so a role change takes
 * effect on the next request without signing the member out.
 *
 * Throwing is the mechanism, not an error path. NextAuth v4's session route
 * catches it, logs JWT_SESSION_ERROR, clears the session cookie, and returns an
 * empty body, so getServerSession() yields null. Returning a session without
 * `user` instead would leave useSession() reporting "authenticated".
 *
 * A database error propagates too, which revokes the session (fail closed).
 */
async function assertSessionCurrent(token: JWT): Promise<void> {
    const memberId = typeof token.memberId === 'string' ? token.memberId : null;
    if (!memberId) {
        throw new Error('SESSION_REVOKED');
    }
    const member = await prisma.teamMember.findUnique({
        where: { id: memberId },
        select: { sessionVersion: true, status: true, role: true },
    });
    const tokenVersion = typeof token.sv === 'number' ? token.sv : 0;
    if (!member || member.status !== 'ACTIVE' || member.sessionVersion !== tokenVersion) {
        throw new Error('SESSION_REVOKED');
    }
    token.role = member.role;
}

// ─── Assemble Auth Options ─────────────────────────────────────────────────

function buildAuthOptions(): NextAuthOptions {
    const providers = (() => {
        switch (AUTH_PROVIDER) {
            case 'credentials':
                return [buildCredentialsProvider()];
            case 'github':
                return [buildGithubProvider()];
            case 'oidc':
                return [buildOidcProvider()];
            default:
                throw new Error(`Unknown AUTH_PROVIDER: ${AUTH_PROVIDER}`);
        }
    })();

    return {
        providers,
        session: {
            strategy: 'jwt',
        },
        callbacks: {
            async signIn({ user, account, profile }) {
                if (AUTH_PROVIDER === 'github') {
                    return githubSignInGate(
                        account as unknown as Record<string, unknown> | null,
                        profile as unknown as Record<string, unknown> | undefined,
                    );
                }
                if (AUTH_PROVIDER === 'oidc') {
                    return oidcSignInGate(
                        user,
                        profile as unknown as Record<string, unknown> | undefined,
                    );
                }
                return true;
            },
            // `trigger` and `session` (the client update() payload) are deliberately
            // never read: any holder of the cookie can call update(), so nothing in
            // the token may come from it (spec §4).
            async jwt({ token, user, account }) {
                if (user) {
                    if (account?.provider === 'oidc') {
                        // Throwing here happens inside NextAuth's OAuth callback route,
                        // before any session cookie is written: NextAuth logs
                        // OAUTH_CALLBACK_HANDLER_ERROR and redirects to
                        // /login?…&error=Callback. A fallback to the OIDC `sub` would
                        // produce a memberId that can never pass assertSessionCurrent.
                        const email =
                            typeof token.email === 'string' ? token.email.toLowerCase() : '';
                        if (!email) {
                            throw new Error('OIDC_MEMBER_UNRESOLVED');
                        }
                        let member: { id: string; role: string; sessionVersion: number } | null;
                        try {
                            member = await prisma.teamMember.findUnique({
                                where: { email },
                                select: { id: true, role: true, sessionVersion: true },
                            });
                        } catch (error) {
                            console.error(
                                '[OIDC Auth] Failed to resolve TeamMember for JWT:',
                                error instanceof Error ? error.message : String(error),
                            );
                            throw error;
                        }
                        if (!member) {
                            console.error('[OIDC Auth] No TeamMember for the signed-in OIDC user');
                            throw new Error('OIDC_MEMBER_UNRESOLVED');
                        }
                        token.memberId = member.id;
                        token.role = member.role;
                        token.sv = member.sessionVersion;
                    } else {
                        const signedIn = user as unknown as Record<string, unknown>;
                        token.role = signedIn.role ?? 'MEMBER';
                        token.memberId = user.id;
                        if (typeof signedIn.sessionVersion === 'number') {
                            token.sv = signedIn.sessionVersion;
                        }
                    }
                    return token;
                }

                if (providerHasSessionCheck(AUTH_PROVIDER)) {
                    await assertSessionCurrent(token);
                }
                return token;
            },
            async session({ session, token }) {
                if (session.user) {
                    (session.user as Record<string, unknown>).id = token.memberId;
                    (session.user as Record<string, unknown>).role = token.role;
                    (session.user as Record<string, unknown>).memberId = token.memberId;
                }
                return session;
            },
        },
        pages: {
            signIn: '/login',
            error: '/login',
        },
        secret: process.env.NEXTAUTH_SECRET,
    };
}

export const authOptions = buildAuthOptions();
