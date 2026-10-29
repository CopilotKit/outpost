// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

const mockInviteFindUnique = vi.fn();
vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        inviteToken: { findUnique: (...a: unknown[]) => mockInviteFindUnique(...a) },
        organization: { findFirst: vi.fn() },
        teamMember: { update: vi.fn() },
        $transaction: vi.fn(),
    },
}));
const mockHashPassword = vi.fn();
vi.mock('@copilotkit/outpost/shared', () => ({
    hashPassword: (...a: unknown[]) => mockHashPassword(...a),
}));

import { POST } from '@/app/api/team/invite/accept/route';

describe('POST /api/team/invite/accept password policy', () => {
    it('rejects a password over 72 bytes before touching the token or hashing', async () => {
        const password = 'é'.repeat(37);
        const res = await POST(
            new Request('http://localhost:3000/api/team/invite/accept', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: 't',
                    name: 'New',
                    password,
                    confirmPassword: password,
                }),
            }),
        );

        expect(res.status).toBe(400);
        expect((await res.json()).errors).toContain('Password must be 72 bytes or fewer.');
        expect(mockInviteFindUnique).not.toHaveBeenCalled();
        expect(mockHashPassword).not.toHaveBeenCalled();
    });
});
