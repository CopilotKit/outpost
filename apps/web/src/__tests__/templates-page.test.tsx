import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TemplatesPage from '@/app/settings/templates/page';

/**
 * Template editor: preview containment and draft fidelity (outpost#226).
 *
 * The preview rendered author-authored HTML through `dangerouslySetInnerHTML` with no
 * sanitisation. Templates are dashboard-editable, so that is a STORED sink — whatever
 * an author saved executed in every later viewer's session. It also mattered more than
 * a typical XSS here, because the csrf cookie is `httpOnly: false` by necessity (the
 * client reads it to build the `X-CSRF-Token` header), so script on this page could
 * read the CSRF token directly.
 *
 * These tests assert containment structurally — the preview must render inside a
 * sandboxed iframe that permits neither scripts nor same-origin access — rather than
 * asserting that some particular payload string was escaped, which an allowlist could
 * pass while still admitting the next payload.
 */

const mockApiFetch = vi.fn();
vi.mock('@/lib/api-fetch', () => ({
    apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const TEMPLATE_LIST = [
    {
        slug: 'welcome',
        name: 'Welcome',
        subject: 'Hi',
        isOverride: false,
        updatedAt: null,
        editedBy: null,
    },
];

const TEMPLATE_DETAIL = {
    slug: 'welcome',
    name: 'Welcome',
    subject: 'Hi {{member.name}}',
    from: 'support@acme.com',
    body: 'Stored body',
    isOverride: false,
};

/** A rendered preview whose content would execute if it were injected into this document. */
const MALICIOUS_PREVIEW = {
    subject: 'Pwned subject',
    html: '<p>hello</p><script data-xss="1">window.__xssFired = true;</script><img data-xss-img src=x onerror="window.__xssFired = true">',
    text: 'hello',
    markdown: 'hello',
};

function jsonOk(data: unknown) {
    return { ok: true, json: async () => data };
}

/** Route apiFetch by URL and method so the component drives a realistic sequence. */
function routeApiFetch(previewPayload: unknown = MALICIOUS_PREVIEW) {
    mockApiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
        if (url === '/api/templates') return jsonOk(TEMPLATE_LIST);
        if (url === '/api/templates/welcome' && (!init?.method || init.method === 'GET')) {
            return jsonOk(TEMPLATE_DETAIL);
        }
        if (url.endsWith('/preview')) return jsonOk(previewPayload);
        return jsonOk({ ok: true });
    });
}

/** Select the one template and wait for the editor to appear. */
async function openTemplate() {
    render(<TemplatesPage />);
    const row = await screen.findByText('Welcome');
    fireEvent.click(row);
    await screen.findByDisplayValue('Stored body');
}

async function openPreview() {
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    await waitFor(() => expect(screen.getByTitle(/preview/i)).toBeTruthy());
}

describe('template preview containment (outpost#226)', () => {
    beforeEach(() => {
        mockApiFetch.mockReset();
        routeApiFetch();
        delete (window as unknown as Record<string, unknown>).__xssFired;
    });

    it('renders the preview inside an iframe rather than injecting it into the page', async () => {
        await openTemplate();
        await openPreview();

        const frame = screen.getByTitle(/preview/i) as HTMLIFrameElement;
        expect(frame.tagName).toBe('IFRAME');
        expect(frame.getAttribute('srcdoc')).toContain('<p>hello</p>');
    });

    it('sandboxes the iframe so neither scripts nor same-origin access are permitted', async () => {
        await openTemplate();
        await openPreview();

        const frame = screen.getByTitle(/preview/i) as HTMLIFrameElement;
        // The attribute must be present. An absent sandbox attribute is full privileges.
        expect(frame.hasAttribute('sandbox')).toBe(true);

        // Asserted as an exact value, not by excluding two tokens: `sandbox=
        // "allow-top-navigation allow-forms"` passes a not-contains check while letting a
        // saved template's <meta refresh> redirect the admin's whole tab. The source
        // comment promises "grants nothing", so the test should hold it to exactly that.
        expect(frame.getAttribute('sandbox')).toBe('');
    });

    it('does not place the preview markup in the parent document', async () => {
        await openTemplate();
        await openPreview();

        // If the html were injected via dangerouslySetInnerHTML, these would exist in
        // this document. Inside an iframe's srcdoc they are inert text.
        expect(document.querySelector('script[data-xss]')).toBeNull();
        expect(document.querySelector('img[data-xss-img]')).toBeNull();
        expect((window as unknown as Record<string, unknown>).__xssFired).toBeUndefined();
    });
});

describe('the editor reports what the server actually said (outpost#226)', () => {
    beforeEach(() => {
        mockApiFetch.mockReset();
    });

    /** Route reads normally, but fail the named mutation with `status` and `payload`. */
    function failMutation(match: string, status: number, payload: unknown) {
        mockApiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
            if (url === '/api/templates') return jsonOk(TEMPLATE_LIST);
            if (url === '/api/templates/welcome' && (!init?.method || init.method === 'GET')) {
                return jsonOk(TEMPLATE_DETAIL);
            }
            if (init?.method === match) {
                return {
                    ok: false,
                    status,
                    json: async () => {
                        if (payload === undefined) throw new SyntaxError('no body');
                        return payload;
                    },
                };
            }
            return jsonOk({ ok: true });
        });
    }

    it('surfaces a validation message instead of a generic failure', async () => {
        failMutation('PUT', 400, { error: 'subject and body are required' });
        await openTemplate();

        fireEvent.click(screen.getByRole('button', { name: /save/i }));

        // The reachable case: an author clears a field. "Save failed" would send them
        // hunting for an outage instead of showing them the empty field.
        expect(await screen.findByText('subject and body are required')).toBeTruthy();
    });

    it('surfaces a permission message rather than looking like a bug', async () => {
        failMutation('PUT', 403, { error: 'Forbidden: admin access required' });
        await openTemplate();

        fireEvent.click(screen.getByRole('button', { name: /save/i }));

        expect(await screen.findByText('Forbidden: admin access required')).toBeTruthy();
    });

    it('distinguishes a server error from a rejected input by showing the status', async () => {
        // A genuine 500 has no JSON body, so the status code is the only thing that
        // separates "your input was rejected" from "the server broke".
        failMutation('PUT', 500, undefined);
        await openTemplate();

        fireEvent.click(screen.getByRole('button', { name: /save/i }));

        expect(await screen.findByText(/HTTP 500/)).toBeTruthy();
    });
});

// A save writes the override and every read surface honours it, but outgoing email
// does not — `sendEmail` consults an override only when handed a `dbLookup`, and
// neither invite call site passes one, so the invitee gets the on-disk copy.
// "Template saved successfully" was true about the row and false about the thing
// the author cared about. These pin the honest copy, because the dishonest version
// is the shorter and more natural string to write.
describe('the editor does not claim more than a save delivers (outpost#226)', () => {
    beforeEach(() => {
        mockApiFetch.mockReset();
    });

    it('says the save is not yet used for outgoing email', async () => {
        mockApiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
            if (url === '/api/templates') return jsonOk(TEMPLATE_LIST);
            if (url === '/api/templates/welcome' && (!init?.method || init.method === 'GET')) {
                return jsonOk(TEMPLATE_DETAIL);
            }
            return jsonOk({ ok: true });
        });
        await openTemplate();

        fireEvent.click(screen.getByRole('button', { name: /save/i }));

        const banner = await screen.findByText(/not yet used for outgoing email/i);
        expect(banner).toBeTruthy();
        // The bare claim must not be what the author reads.
        expect(screen.queryByText('Template saved successfully')).toBeNull();
    });

    it('marks an overridden template as preview-only in the list', async () => {
        // The shared fixture is un-overridden, so this test supplies its own — the
        // badge only appears for a template that actually has a stored override.
        const overridden = [{ ...TEMPLATE_LIST[0], isOverride: true }];
        mockApiFetch.mockImplementation(async (url: string) => {
            if (url === '/api/templates') return jsonOk(overridden);
            return jsonOk(TEMPLATE_DETAIL);
        });
        render(<TemplatesPage />);

        expect(await screen.findByText(/custom \(preview only\)/i)).toBeTruthy();
    });
});

describe('reset gives the author feedback (outpost#226)', () => {
    beforeEach(() => {
        mockApiFetch.mockReset();
    });

    function resetReturns(payload: unknown) {
        mockApiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
            if (url === '/api/templates') return jsonOk(TEMPLATE_LIST);
            if (url === '/api/templates/welcome' && (!init?.method || init.method === 'GET')) {
                return jsonOk(TEMPLATE_DETAIL);
            }
            if (init?.method === 'DELETE') return jsonOk(payload);
            return jsonOk({ ok: true });
        });
    }

    it('confirms the reset after the editor reloads', async () => {
        // DELETE now really deletes, so a reset with no confirmation is a destructive
        // action with no feedback at all.
        resetReturns({ slug: 'welcome', reset: true, hadOverride: true });
        await openTemplate();

        fireEvent.click(screen.getByRole('button', { name: /reset/i }));

        expect(await screen.findByText(/reset to default/i)).toBeTruthy();
    });

    it('says so when the template was already using the default', async () => {
        resetReturns({ slug: 'welcome', reset: true, hadOverride: false });
        await openTemplate();

        fireEvent.click(screen.getByRole('button', { name: /reset/i }));

        expect(await screen.findByText(/already using the default/i)).toBeTruthy();
    });
});

describe('preview shows the unsaved draft (outpost#226)', () => {
    beforeEach(() => {
        mockApiFetch.mockReset();
        routeApiFetch();
    });

    it('sends the current editor content, not an empty body', async () => {
        await openTemplate();

        const bodyField = screen.getByDisplayValue('Stored body');
        fireEvent.change(bodyField, { target: { value: 'Edited but unsaved' } });

        fireEvent.click(screen.getByRole('button', { name: /preview/i }));

        await waitFor(() => {
            const call = mockApiFetch.mock.calls.find(([url]) => String(url).endsWith('/preview'));
            expect(call).toBeTruthy();
            const sent = JSON.parse(call![1].body);
            expect(sent.draft.body).toBe('Edited but unsaved');
        });
    });

    it('sends the edited subject too', async () => {
        await openTemplate();

        const subjectField = screen.getByDisplayValue('Hi {{member.name}}');
        fireEvent.change(subjectField, { target: { value: 'New subject' } });

        fireEvent.click(screen.getByRole('button', { name: /preview/i }));

        await waitFor(() => {
            const call = mockApiFetch.mock.calls.find(([url]) => String(url).endsWith('/preview'));
            const sent = JSON.parse(call![1].body);
            expect(sent.draft.subject).toBe('New subject');
        });
    });
});
