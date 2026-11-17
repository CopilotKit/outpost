import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock Setup ─────────────────────────────────────────────────────────────

const mockTeamMemberFindUnique = vi.fn();
const mockTeamMemberUpsert = vi.fn();
const mockTeamMemberCreate = vi.fn();
const mockTeamMemberUpdate = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        teamMember: {
            findUnique: mockTeamMemberFindUnique,
            upsert: mockTeamMemberUpsert,
            create: mockTeamMemberCreate,
            update: mockTeamMemberUpdate,
        },
    },
}));

vi.mock('@copilotkit/outpost/shared', () => ({
    verifyPassword: vi.fn(),
}));

function oidcSignInArgs(email: string, name: string | undefined = 'Alice') {
    return {
        user: { id: 'oidc-sub-1', name, email },
        account: { provider: 'oidc', type: 'oauth', providerAccountId: 'oidc-sub-1' } as never,
        profile: { sub: 'oidc-sub-1', email, name } as never,
        credentials: undefined,
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('OIDC auth', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.AUTH_PROVIDER = 'oidc';
        process.env.OIDC_ISSUER = 'https://accounts.google.com';
        process.env.OIDC_CLIENT_ID = 'test-client-id';
        process.env.OIDC_CLIENT_SECRET = 'test-client-secret';
        process.env.ALLOWED_EMAIL_DOMAIN = 'copilotkit.ai';
        process.env.NEXTAUTH_SECRET = 'test-secret';
    });

    afterEach(() => {
        process.env = { ...originalEnv };
        vi.resetModules();
    });

    describe('signIn callback — domain restriction', () => {
        it('allows sign-in for matching email domain', async () => {
            const { authOptions } = await import('../lib/auth.js');
            const result = await authOptions.callbacks!.signIn!({
                user: { id: 'oidc-sub-1', name: 'Alice', email: 'alice@copilotkit.ai' },
                account: {
                    provider: 'oidc',
                    type: 'oauth',
                    providerAccountId: 'oidc-sub-1',
                } as never,
                profile: {
                    sub: 'oidc-sub-1',
                    email: 'alice@copilotkit.ai',
                    name: 'Alice',
                } as never,
                credentials: undefined,
            });

            expect(result).toBe(true);
        });

        it('rejects sign-in for non-matching email domain', async () => {
            const { authOptions } = await import('../lib/auth.js');
            const result = await authOptions.callbacks!.signIn!({
                user: { id: 'oidc-sub-2', name: 'Eve', email: 'eve@evil.com' },
                account: {
                    provider: 'oidc',
                    type: 'oauth',
                    providerAccountId: 'oidc-sub-2',
                } as never,
                profile: { sub: 'oidc-sub-2', email: 'eve@evil.com', name: 'Eve' } as never,
                credentials: undefined,
            });

            expect(result).toBe('/login?error=AccessDenied');
        });

        it('rejects sign-in when email is missing', async () => {
            const { authOptions } = await import('../lib/auth.js');
            const result = await authOptions.callbacks!.signIn!({
                user: { id: 'oidc-sub-3', name: 'NoEmail' },
                account: {
                    provider: 'oidc',
                    type: 'oauth',
                    providerAccountId: 'oidc-sub-3',
                } as never,
                profile: { sub: 'oidc-sub-3', name: 'NoEmail' } as never,
                credentials: undefined,
            });

            expect(result).toBe('/login?error=AccessDenied');
        });

        it('allows any email when ALLOWED_EMAIL_DOMAIN is empty', async () => {
            process.env.ALLOWED_EMAIL_DOMAIN = '';
            const { authOptions } = await import('../lib/auth.js');
            const result = await authOptions.callbacks!.signIn!({
                user: { id: 'oidc-sub-4', name: 'Anyone', email: 'anyone@anywhere.com' },
                account: {
                    provider: 'oidc',
                    type: 'oauth',
                    providerAccountId: 'oidc-sub-4',
                } as never,
                profile: {
                    sub: 'oidc-sub-4',
                    email: 'anyone@anywhere.com',
                    name: 'Anyone',
                } as never,
                credentials: undefined,
            });

            expect(result).toBe(true);
        });

        it('rejects sign-in when email is missing and ALLOWED_EMAIL_DOMAIN is empty', async () => {
            process.env.ALLOWED_EMAIL_DOMAIN = '';
            const { authOptions } = await import('../lib/auth.js');
            const result = await authOptions.callbacks!.signIn!({
                user: { id: 'oidc-sub-5', name: 'Ghost' },
                account: {
                    provider: 'oidc',
                    type: 'oauth',
                    providerAccountId: 'oidc-sub-5',
                } as never,
                profile: { sub: 'oidc-sub-5', name: 'Ghost' } as never,
                credentials: undefined,
            });

            expect(result).toBe('/login?error=AccessDenied');
        });

        it('allows sign-in with case-insensitive domain matching', async () => {
            const { authOptions } = await import('../lib/auth.js');
            const result = await authOptions.callbacks!.signIn!({
                user: { id: 'oidc-sub-6', name: 'Alice', email: 'alice@CopilotKit.AI' },
                account: {
                    provider: 'oidc',
                    type: 'oauth',
                    providerAccountId: 'oidc-sub-6',
                } as never,
                profile: {
                    sub: 'oidc-sub-6',
                    email: 'alice@CopilotKit.AI',
                    name: 'Alice',
                } as never,
                credentials: undefined,
            });

            expect(result).toBe(true);
        });

        it('rejects email with domain as substring but not exact match', async () => {
            const { authOptions } = await import('../lib/auth.js');
            const result = await authOptions.callbacks!.signIn!({
                user: { id: 'oidc-evil', name: 'Evil', email: 'evil@notcopilotkit.ai' },
                account: {
                    provider: 'oidc',
                    type: 'oauth',
                    providerAccountId: 'oidc-evil',
                } as never,
                profile: { sub: 'oidc-evil', email: 'evil@notcopilotkit.ai' } as never,
                credentials: undefined,
            });
            expect(result).toBe('/login?error=AccessDenied');
        });
    });

    describe('signIn callback — provisioning and status', () => {
        it('creates an ACTIVE TeamMember on first OIDC login', async () => {
            mockTeamMemberFindUnique.mockResolvedValue(null);
            mockTeamMemberCreate.mockResolvedValue({ id: 'member-new' });

            const { authOptions } = await import('../lib/auth.js');
            const result = await authOptions.callbacks!.signIn!(
                oidcSignInArgs('alice@copilotkit.ai'),
            );

            expect(result).toBe(true);
            expect(mockTeamMemberCreate).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    name: 'Alice',
                    email: 'alice@copilotkit.ai',
                    role: 'MEMBER',
                    status: 'ACTIVE',
                }),
            });
            expect(mockTeamMemberUpsert).not.toHaveBeenCalled();
        });

        it('promotes an INVITED member to ACTIVE with joinedAt', async () => {
            mockTeamMemberFindUnique.mockResolvedValue({ id: 'm-inv', status: 'INVITED' });
            mockTeamMemberUpdate.mockResolvedValue({ id: 'm-inv' });

            const { authOptions } = await import('../lib/auth.js');
            const result = await authOptions.callbacks!.signIn!(
                oidcSignInArgs('alice@copilotkit.ai'),
            );

            expect(result).toBe(true);
            expect(mockTeamMemberUpdate).toHaveBeenCalledWith({
                where: { id: 'm-inv' },
                data: expect.objectContaining({
                    status: 'ACTIVE',
                    joinedAt: expect.any(Date),
                    name: 'Alice',
                }),
            });
        });

        it('updates name and avatar for an ACTIVE member without touching status', async () => {
            mockTeamMemberFindUnique.mockResolvedValue({ id: 'm1', status: 'ACTIVE' });
            mockTeamMemberUpdate.mockResolvedValue({ id: 'm1' });

            const { authOptions } = await import('../lib/auth.js');
            await authOptions.callbacks!.signIn!(oidcSignInArgs('alice@copilotkit.ai'));

            const call = mockTeamMemberUpdate.mock.calls[0][0] as { data: Record<string, unknown> };
            expect(call.data).toEqual({ name: 'Alice', avatarUrl: null });
        });

        it('denies a DISABLED member', async () => {
            mockTeamMemberFindUnique.mockResolvedValue({ id: 'm-off', status: 'DISABLED' });

            const { authOptions } = await import('../lib/auth.js');
            const result = await authOptions.callbacks!.signIn!(
                oidcSignInArgs('alice@copilotkit.ai'),
            );

            expect(result).toBe('/login?error=AccessDenied');
            expect(mockTeamMemberUpdate).not.toHaveBeenCalled();
            expect(mockTeamMemberCreate).not.toHaveBeenCalled();
        });

        it('denies sign-in when the database work throws', async () => {
            mockTeamMemberFindUnique.mockRejectedValue(new Error('DB timeout'));

            const { authOptions } = await import('../lib/auth.js');
            const result = await authOptions.callbacks!.signIn!(
                oidcSignInArgs('alice@copilotkit.ai'),
            );

            expect(result).toBe('/login?error=AccessDenied');
        });

        it('looks up a mixed-case IdP email as lowercase', async () => {
            mockTeamMemberFindUnique.mockResolvedValue({ id: 'm1', status: 'ACTIVE' });
            mockTeamMemberUpdate.mockResolvedValue({ id: 'm1' });

            const { authOptions } = await import('../lib/auth.js');
            await authOptions.callbacks!.signIn!(oidcSignInArgs('Alex@CopilotKit.ai'));

            expect(mockTeamMemberFindUnique).toHaveBeenCalledWith(
                expect.objectContaining({ where: { email: 'alex@copilotkit.ai' } }),
            );
        });

        it('uses email local-part as name when user.name and profile.name are missing', async () => {
            mockTeamMemberFindUnique.mockResolvedValue(null);
            mockTeamMemberCreate.mockResolvedValue({ id: 'member-new' });
            const { authOptions } = await import('../lib/auth.js');
            await authOptions.callbacks!.signIn!({
                user: { id: 'oidc-sub-7', email: 'bob@copilotkit.ai' },
                account: {
                    provider: 'oidc',
                    type: 'oauth',
                    providerAccountId: 'oidc-sub-7',
                } as never,
                profile: { sub: 'oidc-sub-7', email: 'bob@copilotkit.ai' } as never,
                credentials: undefined,
            });

            expect(mockTeamMemberCreate).toHaveBeenCalledWith({
                data: expect.objectContaining({ name: 'bob' }),
            });
        });
    });

    describe('jwt callback — OIDC identity resolution', () => {
        const signInJwt = (email?: string) => ({
            token: email ? { sub: 'oidc-sub-1', email } : { sub: 'oidc-sub-1' },
            user: { id: 'oidc-sub-1', name: 'Alice', ...(email ? { email } : {}) },
            account: { provider: 'oidc', type: 'oauth' } as never,
            trigger: 'signIn',
        });

        it('resolves memberId, role and sv by lowercased email', async () => {
            mockTeamMemberFindUnique.mockResolvedValue({
                id: 'member-1',
                role: 'ADMIN',
                sessionVersion: 3,
            });

            const { authOptions } = await import('../lib/auth.js');
            const token = await authOptions.callbacks!.jwt!(
                signInJwt('Alex@CopilotKit.ai') as never,
            );

            expect(mockTeamMemberFindUnique).toHaveBeenCalledWith({
                where: { email: 'alex@copilotkit.ai' },
                select: { id: true, role: true, sessionVersion: true },
            });
            expect(token).toMatchObject({ memberId: 'member-1', role: 'ADMIN', sv: 3 });
        });

        it('throws (no fallback to the OIDC sub) when no TeamMember matches', async () => {
            mockTeamMemberFindUnique.mockResolvedValue(null);
            const { authOptions } = await import('../lib/auth.js');
            await expect(
                authOptions.callbacks!.jwt!(signInJwt('alice@copilotkit.ai') as never),
            ).rejects.toThrow('OIDC_MEMBER_UNRESOLVED');
        });

        it('throws when the lookup fails', async () => {
            mockTeamMemberFindUnique.mockRejectedValue(new Error('connection refused'));
            const { authOptions } = await import('../lib/auth.js');
            await expect(
                authOptions.callbacks!.jwt!(signInJwt('alice@copilotkit.ai') as never),
            ).rejects.toThrow('connection refused');
        });

        it('throws when the token has no email', async () => {
            const { authOptions } = await import('../lib/auth.js');
            await expect(authOptions.callbacks!.jwt!(signInJwt() as never)).rejects.toThrow(
                'OIDC_MEMBER_UNRESOLVED',
            );
            expect(mockTeamMemberFindUnique).not.toHaveBeenCalled();
        });

        it('an INVITED member promoted at sign-in passes the next session read', async () => {
            const { authOptions } = await import('../lib/auth.js');
            mockTeamMemberFindUnique.mockResolvedValueOnce({ id: 'm-inv', status: 'INVITED' });
            mockTeamMemberUpdate.mockResolvedValue({ id: 'm-inv' });
            expect(
                await authOptions.callbacks!.signIn!(oidcSignInArgs('alice@copilotkit.ai')),
            ).toBe(true);

            mockTeamMemberFindUnique.mockResolvedValueOnce({
                id: 'm-inv',
                role: 'MEMBER',
                sessionVersion: 0,
            });
            const token = await authOptions.callbacks!.jwt!(
                signInJwt('alice@copilotkit.ai') as never,
            );

            mockTeamMemberFindUnique.mockResolvedValueOnce({ sessionVersion: 0, status: 'ACTIVE' });
            await expect(authOptions.callbacks!.jwt!({ token } as never)).resolves.toMatchObject({
                memberId: 'm-inv',
            });
        });
    });
});
