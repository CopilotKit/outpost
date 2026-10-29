import { test, expect, type Browser } from '@playwright/test';
import {
    ADMIN,
    MEMBER_PASSWORD,
    ORG_NAME,
    PENDING_INVITE,
    USERS,
    newContext,
    messagesTo,
    profileStatus,
    resetLinkFrom,
    signIn,
    sql,
    waitForMail,
} from './support';

const NEUTRAL = "If an account exists for that address, we've sent a link to reset your password.";
const EXPIRED = 'This reset link is invalid or has expired.';
const RESET_SUBJECT = `Reset your ${ORG_NAME} Outpost password`;
const CHANGED_SUBJECT = `Your ${ORG_NAME} Outpost password was changed`;
const BUTTON_TITLE = 'Send password reset link';

async function requestReset(browser: Browser, email: string) {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto('/forgot-password');
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.fill('#email', email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText(NEUTRAL)).toBeVisible();
    await context.close();
}

async function setPasswordFromLink(browser: Browser, link: string, password: string) {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto(link);
    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
    expect(page.url()).not.toContain('#token');
    await page.getByLabel('New password', { exact: true }).fill(password);
    await page.getByLabel('Confirm new password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Set new password' }).click();
    await page.waitForURL('**/login?reset=1');
    await expect(
        page.getByText('Your password has been reset. Sign in with your new password.'),
    ).toBeVisible();
    await context.close();
}

async function expectSignInFails(browser: Browser, email: string, password: string) {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto('/login');
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/error=CredentialsSignin/);
    await context.close();
}

test('0: the built image sends email over SMTP', async () => {
    // globalSetup invited every member; on a working image the invite reached Mailpit.
    const mail = await waitForMail(USERS.selfService, "You've been invited");
    expect(mail.Text).toContain('/invite/accept?token=');
});

test('RED 2: /forgot-password is public', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto('/forgot-password');
    await expect(page).toHaveURL(/\/forgot-password$/);
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
    await context.close();
});

test('RED 1 / GREEN 1-9: self-service reset, single use, all sessions revoked', async ({
    browser,
}) => {
    const email = USERS.selfService;
    const contextA = await signIn(browser, email, MEMBER_PASSWORD);
    expect(await profileStatus(contextA)).toBe(200);

    const contextB = await newContext(browser);
    const b = await contextB.newPage();
    await b.goto('/login');
    await b.getByRole('link', { name: 'Forgot password?' }).click();
    await b.waitForURL('**/forgot-password**');
    await b.fill('#email', email);
    await b.getByRole('button', { name: 'Send reset link' }).click();
    await expect(b.getByText(NEUTRAL)).toBeVisible();

    await requestReset(browser, 'nobody@e2e.test');

    const link = resetLinkFrom(await waitForMail(email, RESET_SUBJECT));
    expect(link).toMatch(/^http:\/\/localhost:3100\/reset-password#token=[0-9a-f]{64}$/);
    // The unknown request's after() started after the member's, so it has had less time.
    // Wait 2 s more so that a mistaken send to the unknown address can arrive before we check.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await messagesTo('nobody@e2e.test')).toHaveLength(0);

    const newPassword = 'self-pass-2';
    await setPasswordFromLink(browser, link, newPassword);

    await (await signIn(browser, email, newPassword)).close();
    await expectSignInFails(browser, email, MEMBER_PASSWORD);

    const reopen = await newContext(browser);
    const reopenPage = await reopen.newPage();
    await reopenPage.goto(link);
    await expect(reopenPage.getByText(EXPIRED)).toBeVisible();
    await reopen.close();

    expect(await profileStatus(contextA)).toBe(401);
    const session = await contextA.request.get('/api/auth/session');
    expect(await session.json()).toEqual({});
    const a = await contextA.newPage();
    await a.goto('/dashboard');
    await a.waitForURL('**/login**');

    await waitForMail(email, CHANGED_SUBJECT);
    await contextA.close();
    await contextB.close();
});

test('GREEN 10: an expired link shows the expired state', async ({ browser }) => {
    await requestReset(browser, USERS.expiry);
    const link = resetLinkFrom(await waitForMail(USERS.expiry, RESET_SUBJECT));
    expect(
        sql(
            `UPDATE "PasswordResetToken" SET "expiresAt" = now() - interval '1 minute' ` +
                `WHERE "usedAt" IS NULL AND "memberId" = (SELECT "id" FROM "TeamMember" WHERE "email" = '${USERS.expiry}')`,
        ),
    ).toBe('UPDATE 1');

    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto(link);
    await expect(page.getByText(EXPIRED)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();
    await context.close();
});

test('RED 3 / GREEN 11: profile change keeps this session and revokes the others', async ({
    browser,
}) => {
    const email = USERS.profile;
    const contextA = await signIn(browser, email, MEMBER_PASSWORD);
    const contextB = await signIn(browser, email, MEMBER_PASSWORD);
    const newPassword = 'profile-pass-2';

    const a = await contextA.newPage();
    await a.goto('/settings/profile');
    await a.fill('#currentPassword', MEMBER_PASSWORD);
    await a.fill('#newPassword', newPassword);
    await a.fill('#confirmNewPassword', newPassword);
    await a.getByRole('button', { name: /Save Changes/ }).click();
    // Either message, so on main the test reaches the revocation assertion below.
    await expect(
        a.getByText(
            /Password changed\. Your other sessions have been signed out\.|Profile updated successfully\./,
        ),
    ).toBeVisible();

    expect(await profileStatus(contextB)).toBe(401);
    await expect(
        a.getByText('Password changed. Your other sessions have been signed out.'),
    ).toBeVisible();
    expect(await profileStatus(contextA)).toBe(200);

    const a2 = await contextA.newPage();
    await a2.goto('/dashboard');
    await expect(a2).toHaveURL(/\/dashboard/);
    const b2 = await contextB.newPage();
    await b2.goto('/dashboard');
    await b2.waitForURL('**/login**');

    await (await signIn(browser, email, newPassword)).close();
    await contextA.close();
    await contextB.close();
});

test('RED 4 / GREEN 12: admin sends a reset link; sending revokes nothing, using it does', async ({
    browser,
}) => {
    const email = USERS.adminSend;
    const contextC = await signIn(browser, email, MEMBER_PASSWORD);
    const admin = await signIn(browser, ADMIN.email, ADMIN.password);
    const page = await admin.newPage();
    await page.goto('/settings/team');

    const memberRow = page.locator('tr', { hasText: email });
    await expect(memberRow.getByTitle(BUTTON_TITLE)).toBeVisible();
    await expect(page.locator('tr', { hasText: ADMIN.email }).getByTitle(BUTTON_TITLE)).toHaveCount(
        0,
    );
    await expect(
        page.locator('tr', { hasText: PENDING_INVITE }).getByTitle(BUTTON_TITLE),
    ).toHaveCount(0);

    page.once('dialog', (dialog) => dialog.accept());
    const responsePromise = page.waitForResponse(
        (r) => r.url().endsWith('/password-reset') && r.request().method() === 'POST',
    );
    await memberRow.getByTitle(BUTTON_TITLE).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true, emailSent: true });
    await expect(
        page.getByText(`Password reset link sent to ${email}. It expires in 30 minutes.`),
    ).toBeVisible();

    const mail = await waitForMail(email, RESET_SUBJECT);
    expect((await messagesTo(email)).filter((m) => m.Subject.includes(RESET_SUBJECT))).toHaveLength(
        1,
    );
    expect(await profileStatus(contextC)).toBe(200);

    await setPasswordFromLink(browser, resetLinkFrom(mail), 'adminsend-pass-2');
    expect(await profileStatus(contextC)).toBe(401);
    expect(await profileStatus(admin)).toBe(200);

    await contextC.close();
    await admin.close();
});
