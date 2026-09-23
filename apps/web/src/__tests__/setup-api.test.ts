import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Prisma ────────────────────────────────────────────────────────────

const mockCount = vi.fn();
const mockTransaction = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        teamMember: {
            count: () => mockCount(),
        },
        $transaction: (fn: (tx: unknown) => Promise<unknown>) => mockTransaction(fn),
    },
}));

// ─── Mock hashPassword ──────────────────────────────────────────────────────

vi.mock('@copilotkit/outpost/shared', () => ({
    hashPassword: vi.fn().mockResolvedValue('hashed-password-123'),
    // Faithful mirror of the real policy (min 8 chars, max 72 UTF-8 bytes).
    validatePassword: (pw: unknown) => {
        if (typeof pw !== 'string' || pw.length === 0) return 'Password is required.';
        if (pw.length < 8) return 'Password must be at least 8 characters.';
        if (new TextEncoder().encode(pw).length > 72) {
            return 'Password must be at most 72 bytes; bcrypt ignores anything beyond that.';
        }
        return null;
    },
}));

// Import after mocks
import { POST } from '@/app/api/setup/route';

function makeRequest(body: Record<string, unknown>): Request {
    return new Request('http://localhost:3000/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('POST /api/setup', () => {
    beforeEach(() => {
        mockCount.mockReset();
        mockTransaction.mockReset();
    });

    it('creates an organization and admin when no team members exist', async () => {
        mockCount.mockResolvedValue(0);

        const mockOrg = {
            id: 'org-123',
            name: 'Acme Corp',
            email: 'support@acme.com',
            logoUrl: null,
            tagline: null,
        };
        const mockMember = {
            id: 'cuid-123',
            name: 'Admin User',
            email: 'admin@example.com',
            role: 'ADMIN',
            status: 'ACTIVE',
            createdAt: new Date('2025-01-01'),
        };

        mockTransaction.mockImplementation(async (fn) => {
            const tx = {
                organization: {
                    create: vi.fn().mockResolvedValue(mockOrg),
                },
                teamMember: {
                    create: vi.fn().mockResolvedValue(mockMember),
                },
            };
            return fn(tx);
        });

        const res = await POST(makeRequest({
            orgName: 'Acme Corp',
            orgEmail: 'support@acme.com',
            name: 'Admin User',
            email: 'admin@example.com',
            password: 'securepass123',
            confirmPassword: 'securepass123',
        }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.organization.name).toBe('Acme Corp');
        expect(body.admin.name).toBe('Admin User');
        expect(body.admin.email).toBe('admin@example.com');
        expect(body.admin.role).toBe('ADMIN');
        expect(body.admin.passwordHash).toBeUndefined();
    });

    it('returns 403 when team members already exist', async () => {
        mockCount.mockResolvedValue(1);

        const res = await POST(makeRequest({
            orgName: 'Evil Corp',
            orgEmail: 'evil@corp.com',
            name: 'Hacker',
            email: 'hacker@evil.com',
            password: 'password123',
            confirmPassword: 'password123',
        }));

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toContain('already exists');
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('validates required fields including org fields', async () => {
        mockCount.mockResolvedValue(0);

        const res = await POST(makeRequest({}));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.errors).toEqual(
            expect.arrayContaining([
                expect.stringContaining('Organization name'),
                expect.stringContaining('Organization email'),
                expect.stringContaining('Name'),
                expect.stringContaining('Email'),
                expect.stringContaining('Password'),
            ]),
        );
    });

    it('validates email format', async () => {
        mockCount.mockResolvedValue(0);

        const res = await POST(makeRequest({
            orgName: 'Acme',
            orgEmail: 'bad-email',
            name: 'Test',
            email: 'not-an-email',
            password: 'password123',
            confirmPassword: 'password123',
        }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.errors).toEqual(
            expect.arrayContaining([
                expect.stringContaining('Organization email must be a valid'),
                expect.stringContaining('valid email'),
            ]),
        );
    });

    it('validates password length', async () => {
        mockCount.mockResolvedValue(0);

        const res = await POST(makeRequest({
            orgName: 'Acme',
            orgEmail: 'support@acme.com',
            name: 'Test',
            email: 'test@example.com',
            password: 'short',
            confirmPassword: 'short',
        }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.errors).toEqual(
            expect.arrayContaining([
                expect.stringContaining('8 characters'),
            ]),
        );
    });

    it('rejects passwords longer than bcrypts 72-byte limit', async () => {
        mockCount.mockResolvedValue(0);

        const longPassword = 'a'.repeat(73);
        const res = await POST(makeRequest({
            orgName: 'Acme',
            orgEmail: 'support@acme.com',
            name: 'Test',
            email: 'test@example.com',
            password: longPassword,
            confirmPassword: longPassword,
        }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.errors).toEqual(
            expect.arrayContaining([
                expect.stringContaining('at most 72 bytes'),
            ]),
        );
    });

    it('validates passwords match', async () => {
        mockCount.mockResolvedValue(0);

        const res = await POST(makeRequest({
            orgName: 'Acme',
            orgEmail: 'support@acme.com',
            name: 'Test',
            email: 'test@example.com',
            password: 'password123',
            confirmPassword: 'different456',
        }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.errors).toEqual(
            expect.arrayContaining([
                expect.stringContaining('do not match'),
            ]),
        );
    });
});
