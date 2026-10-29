/**
 * The server-side auth provider, read at call time so routes and tests see the
 * current environment. `||` rather than `??` for the same reason as lib/auth.ts:
 * an empty value means "not configured".
 */
export function authProvider(): string {
    return process.env.AUTH_PROVIDER || 'credentials';
}

/**
 * Whether `token.memberId` is a TeamMember id under this provider, so the
 * sessionVersion check can run. GitHub mode stores the GitHub account id there,
 * which is not a TeamMember row, so revocation does not apply (spec §4, backlog).
 */
export function providerHasSessionCheck(provider: string = authProvider()): boolean {
    return provider === 'credentials' || provider === 'oidc';
}
