/**
 * Tests for the Postmark inbound email webhook.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Prisma ────────────────────────────────────────────────────────────

const mockTicketFindUnique = vi.fn();
const mockTicketFindFirst = vi.fn();
const mockTicketFindMany = vi.fn();
const mockTicketCreate = vi.fn();
const mockTicketUpdate = vi.fn();
const mockMessageCreate = vi.fn();
const mockMessageFindFirst = vi.fn();
const mockMessageFindMany = vi.fn();
const mockJobCreate = vi.fn();
const mockTransaction = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        $transaction: (...args: unknown[]) => mockTransaction(...args),
        ticket: {
            findUnique: (...args: unknown[]) => mockTicketFindUnique(...args),
            findFirst: (...args: unknown[]) => mockTicketFindFirst(...args),
            findMany: (...args: unknown[]) => mockTicketFindMany(...args),
            create: (...args: unknown[]) => mockTicketCreate(...args),
            update: (...args: unknown[]) => mockTicketUpdate(...args),
        },
        message: {
            create: (...args: unknown[]) => mockMessageCreate(...args),
            findFirst: (...args: unknown[]) => mockMessageFindFirst(...args),
            findMany: (...args: unknown[]) => mockMessageFindMany(...args),
        },
        job: {
            create: (...args: unknown[]) => mockJobCreate(...args),
        },
    },
}));

// ─── Mock generateTicketId ──────────────────────────────────────────────────

// reopensOnCustomerReply is deliberately NOT stubbed — this webhook and the
// shared InboundHandler must agree on which statuses a reply reopens, so the
// test exercises the real shared implementation.
vi.mock('@copilotkit/outpost/shared', async (importActual) => ({
    ...(await importActual<typeof import('@copilotkit/outpost/shared')>()),
    generateTicketId: vi.fn().mockReturnValue('TKT-TESTID01'),
}));

// ─── Mock queue ────────────────────────────────────────────────────────────

const mockCreateJob = vi.fn().mockResolvedValue('job-1');

vi.mock('@copilotkit/outpost/queue', () => ({
    createJob: (...args: unknown[]) => mockCreateJob(...args),
    JobType: { AI_RESPONSE: 'AI_RESPONSE' },
}));

// ─── Import route + helpers ─────────────────────────────────────────────────

import { POST } from '@/app/api/webhooks/postmark/route';
import {
    decodeHtmlEntities,
    EMPTY_EMAIL_BODY_PLACEHOLDER,
    extractTicketId,
    extractEmail,
    extractName,
    extractReplyMessageIds,
    getHeaderValue,
    getHeaderValues,
    hasReplyHeaders,
    htmlToText,
    isTicketParticipant,
    MAX_REPLY_MESSAGE_IDS,
    normalizeMessageId,
    normalizeParticipantEmail,
    resolveMessageBody,
} from '@/app/api/webhooks/postmark/utils';
import type { PostmarkInboundPayload } from '@/app/api/webhooks/postmark/utils';

// ─── Helpers ────────────────────────────────────────────────────────────────

function postmarkRequest(payload: Partial<PostmarkInboundPayload>): Request {
    return new Request('http://localhost:3000/api/webhooks/postmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

function fullPayload(overrides: Partial<PostmarkInboundPayload> = {}): PostmarkInboundPayload {
    return {
        From: 'Alice Smith <alice@example.com>',
        FromName: 'Alice Smith',
        To: 'support@outpost.dev',
        Subject: 'Need help with billing',
        TextBody: 'I have a question about my invoice.',
        HtmlBody: '<p>I have a question about my invoice.</p>',
        MessageID: 'msg-001@postmark.example',
        ...overrides,
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Postmark inbound webhook', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockTicketCreate.mockReset();
        mockTicketFindFirst.mockReset();
        mockJobCreate.mockReset();
        mockTransaction.mockReset();
        mockCreateJob.mockReset();
        mockTicketFindMany.mockReset();
        mockMessageFindMany.mockReset();
        mockMessageFindFirst.mockReset();
        mockTicketFindUnique.mockReset();
        mockTicketFindFirst.mockResolvedValue(null);
        mockTicketFindMany.mockResolvedValue([]);
        mockMessageFindMany.mockResolvedValue([]);
        // No prior delivery of this MessageID unless a test says otherwise.
        mockMessageFindFirst.mockResolvedValue(null);
        mockTicketFindUnique.mockResolvedValue(null);
        mockJobCreate.mockResolvedValue({ id: 'job-1' });
        mockCreateJob.mockResolvedValue('job-1');
        mockTransaction.mockImplementation(
            async (
                callback: (tx: {
                    ticket: { create: typeof mockTicketCreate; update: typeof mockTicketUpdate };
                    message: { create: typeof mockMessageCreate };
                    job: { create: typeof mockJobCreate };
                }) => Promise<unknown>,
            ) =>
                callback({
                    ticket: { create: mockTicketCreate, update: mockTicketUpdate },
                    message: { create: mockMessageCreate },
                    job: { create: mockJobCreate },
                }),
        );
    });

    // ── Helper function tests ──────────────────────────────────────────────

    describe('extractTicketId', () => {
        it('extracts ticket ID from MailboxHash', () => {
            expect(extractTicketId('TKT-AB12CD34')).toBe('TKT-AB12CD34');
        });

        it('uppercases the ticket ID', () => {
            expect(extractTicketId('tkt-ab12cd34')).toBe('TKT-AB12CD34');
        });

        it('returns null for empty string', () => {
            expect(extractTicketId('')).toBeNull();
        });

        it('returns null for undefined', () => {
            expect(extractTicketId(undefined)).toBeNull();
        });

        it('returns null for invalid format', () => {
            expect(extractTicketId('not-a-ticket-id')).toBeNull();
        });
    });

    describe('extractEmail', () => {
        it('extracts email from angle-bracket format', () => {
            expect(extractEmail('Alice <alice@test.com>')).toBe('alice@test.com');
        });

        it('returns raw string when no angle brackets', () => {
            expect(extractEmail('alice@test.com')).toBe('alice@test.com');
        });
    });

    describe('extractName', () => {
        it('uses fromName when provided', () => {
            expect(extractName('Alice <alice@test.com>', 'Alice Smith')).toBe('Alice Smith');
        });

        it('extracts name from angle-bracket format', () => {
            expect(extractName('Alice Smith <alice@test.com>')).toBe('Alice Smith');
        });

        it('returns full string when no angle brackets', () => {
            expect(extractName('alice@test.com')).toBe('alice@test.com');
        });
    });

    // Postmark's MessageID field is bare while header values are angle-bracketed
    // and may be folded across lines. If normalization is off by a bracket the
    // route silently stops recognizing replies, so it is tested directly.
    describe('normalizeMessageId', () => {
        it('strips angle brackets', () => {
            expect(normalizeMessageId('<abc@example.com>')).toBe('abc@example.com');
        });

        it('leaves a bare ID untouched', () => {
            expect(normalizeMessageId('abc@example.com')).toBe('abc@example.com');
        });

        it('strips surrounding and inner-edge whitespace, including folded lines', () => {
            expect(normalizeMessageId('\r\n\t <abc@example.com> ')).toBe('abc@example.com');
            expect(normalizeMessageId('< abc@example.com >')).toBe('abc@example.com');
        });

        it('returns null for empty, bracket-only, and missing values', () => {
            expect(normalizeMessageId('')).toBeNull();
            expect(normalizeMessageId('   ')).toBeNull();
            expect(normalizeMessageId('<>')).toBeNull();
            expect(normalizeMessageId(undefined)).toBeNull();
            expect(normalizeMessageId(null)).toBeNull();
        });
    });

    describe('getHeaderValue', () => {
        it('matches header names case-insensitively', () => {
            const list = [{ Name: 'in-REPLY-to', Value: '<a@b>' }];
            expect(getHeaderValue(list, 'In-Reply-To')).toBe('<a@b>');
        });

        it('returns undefined for a missing header or missing list', () => {
            expect(getHeaderValue([{ Name: 'Date', Value: 'x' }], 'References')).toBeUndefined();
            expect(getHeaderValue(undefined, 'References')).toBeUndefined();
        });
    });

    // Some mail clients split a long References chain across several header
    // lines, and Postmark surfaces each line as its own Headers[] entry. Reading
    // only the first entry drops chain segments — including, for a long thread,
    // the root ID the ticket is stored under.
    describe('getHeaderValues', () => {
        it('returns every occurrence of a repeated header, in order', () => {
            expect(
                getHeaderValues(
                    [
                        { Name: 'References', Value: '<a@x>' },
                        { Name: 'Date', Value: 'x' },
                        { Name: 'references', Value: '<b@x>' },
                        { Name: 'REFERENCES', Value: '<c@x>' },
                    ],
                    'References',
                ),
            ).toEqual(['<a@x>', '<b@x>', '<c@x>']);
        });

        it('returns an empty list for a missing header or missing list', () => {
            expect(getHeaderValues([{ Name: 'Date', Value: 'x' }], 'References')).toEqual([]);
            expect(getHeaderValues(undefined, 'References')).toEqual([]);
        });
    });

    describe('extractReplyMessageIds', () => {
        it('collects In-Reply-To and the whole References chain, normalized and deduped', () => {
            expect(
                extractReplyMessageIds([
                    { Name: 'In-Reply-To', Value: '<b@x>' },
                    { Name: 'References', Value: '<a@x> <b@x>\r\n\t<c@x>' },
                ]),
            ).toEqual(['b@x', 'a@x', 'c@x']);
        });

        it('tolerates comma-separated References', () => {
            expect(extractReplyMessageIds([{ Name: 'References', Value: '<a@x>, <b@x>' }])).toEqual(
                ['a@x', 'b@x'],
            );
        });

        it('returns an empty list when there are no threading headers', () => {
            expect(extractReplyMessageIds([{ Name: 'Subject', Value: 'hi' }])).toEqual([]);
            expect(extractReplyMessageIds(undefined)).toEqual([]);
        });

        it('drops unparseable tokens', () => {
            expect(extractReplyMessageIds([{ Name: 'In-Reply-To', Value: '<>' }])).toEqual([]);
        });

        it('caps a sender-supplied chain, keeping the oldest IDs that hold the thread root', () => {
            const chain = Array.from({ length: 500 }, (_, i) => `<id-${i}@x>`).join(' ');
            const ids = extractReplyMessageIds([
                { Name: 'In-Reply-To', Value: '<newest@x>' },
                { Name: 'References', Value: chain },
            ]);

            expect(ids).toHaveLength(MAX_REPLY_MESSAGE_IDS);
            // In-Reply-To first, then References oldest → newest, so the thread
            // root survives truncation.
            expect(ids[0]).toBe('newest@x');
            expect(ids[1]).toBe('id-0@x');
        });

        it('reads every occurrence of a repeated References header, not just the first', () => {
            expect(
                extractReplyMessageIds([
                    { Name: 'In-Reply-To', Value: '<newest@x>' },
                    { Name: 'References', Value: '<root@x> <second@x>' },
                    { Name: 'References', Value: '<third@x>\r\n\t<newest@x>' },
                ]),
            ).toEqual(['newest@x', 'root@x', 'second@x', 'third@x']);
        });

        it('still caps the total when the chain is spread across many header lines', () => {
            const lines = Array.from({ length: 200 }, (_, line) => ({
                Name: 'References',
                Value: Array.from({ length: 5 }, (_, i) => `<id-${line}-${i}@x>`).join(' '),
            }));

            const ids = extractReplyMessageIds([
                { Name: 'In-Reply-To', Value: '<newest@x>' },
                ...lines,
            ]);

            // Widening the input to repeated headers must not widen the fan-out
            // the cap exists to bound.
            expect(ids).toHaveLength(MAX_REPLY_MESSAGE_IDS);
            expect(ids[0]).toBe('newest@x');
            expect(ids[1]).toBe('id-0-0@x');
        });
    });

    // HtmlBody used to be ignored entirely: an HTML-only email (Outlook and most
    // marketing suites send text/html with no text/plain part) produced an empty
    // description, an empty opening message, and an AI job over an empty question.
    describe('htmlToText', () => {
        it('turns an HTML-only body into readable text', () => {
            expect(
                htmlToText('<html><body><p>Hi there,</p><p>My invoice is wrong.</p></body></html>'),
            ).toBe('Hi there,\nMy invoice is wrong.');
        });

        it('breaks lines on br and list items', () => {
            expect(htmlToText('a<br>b<ul><li>one</li><li>two</li></ul>')).toBe('a\nb\none\ntwo');
        });

        it('drops style, script and head content instead of emitting it as text', () => {
            expect(
                htmlToText(
                    '<head><title>ignored</title><style>.x{color:red}</style></head>' +
                        '<body><script>alert(1)</script><p>real words</p></body>',
                ),
            ).toBe('real words');
        });

        it('drops HTML comments, including Outlook conditional blocks', () => {
            expect(htmlToText('<!--[if mso]><p>outlook only</p><![endif]--><p>shared</p>')).toBe(
                'shared',
            );
        });

        it('decodes entities and keeps escaped markup as literal text', () => {
            expect(htmlToText('<p>Tom &amp; Jerry &mdash; caf&#233; &#x2019;s</p>')).toBe(
                'Tom & Jerry — café ’s',
            );
            // An escaped tag in the customer's prose must not be re-read as markup.
            expect(htmlToText('<p>use &lt;div&gt; here</p>')).toBe('use <div> here');
        });

        it('collapses nbsp runs, and every run of breaks becomes one newline', () => {
            // Deliberate: without a DOM, "paragraph gap" and "two adjacent block
            // tags" are indistinguishable, and Outlook emits one div per line.
            expect(htmlToText('<p>a&nbsp;&nbsp; b</p><p></p><p></p><p>c</p>')).toBe('a b\nc');
            expect(htmlToText('a<br><br><br>b')).toBe('a\nb');
        });

        it('returns an empty string for markup with no words, and for missing input', () => {
            expect(htmlToText('<div><br><span></span></div>')).toBe('');
            expect(htmlToText('   ')).toBe('');
            expect(htmlToText(undefined)).toBe('');
            expect(htmlToText(null)).toBe('');
        });
    });

    describe('decodeHtmlEntities', () => {
        it('leaves unknown named entities and out-of-range numerics verbatim', () => {
            expect(decodeHtmlEntities('&notarealentity; &#0; &#1114112;')).toBe(
                '&notarealentity; &#0; &#1114112;',
            );
        });
    });

    describe('resolveMessageBody', () => {
        it('prefers StrippedTextReply, then TextBody', () => {
            expect(
                resolveMessageBody({
                    StrippedTextReply: 'stripped',
                    TextBody: 'plain',
                    HtmlBody: '<p>html</p>',
                }),
            ).toEqual({ content: 'stripped', hasText: true });

            expect(resolveMessageBody({ TextBody: 'plain', HtmlBody: '<p>html</p>' })).toEqual({
                content: 'plain',
                hasText: true,
            });
        });

        it('falls back to text derived from HtmlBody when there is no plain text', () => {
            expect(
                resolveMessageBody({
                    StrippedTextReply: '',
                    TextBody: '   ',
                    HtmlBody: '<div><p>Outlook only sent HTML.</p></div>',
                }),
            ).toEqual({ content: 'Outlook only sent HTML.', hasText: true });
        });

        // Deliberate: no source yields text, so the route still files the ticket
        // (a real customer email is never dropped) but must NOT enqueue an AI job.
        it('reports hasText false with an explicit placeholder when nothing is readable', () => {
            expect(
                resolveMessageBody({ StrippedTextReply: '', TextBody: '', HtmlBody: '<br>' }),
            ).toEqual({ content: EMPTY_EMAIL_BODY_PLACEHOLDER, hasText: false });
            expect(EMPTY_EMAIL_BODY_PLACEHOLDER.trim().length).toBeGreaterThan(0);
        });
    });

    describe('hasReplyHeaders', () => {
        it('is true for a non-empty In-Reply-To or References', () => {
            expect(hasReplyHeaders([{ Name: 'In-Reply-To', Value: '<a@x>' }])).toBe(true);
            expect(hasReplyHeaders([{ Name: 'References', Value: '<a@x>' }])).toBe(true);
        });

        it('is true when only a later occurrence of a repeated header has content', () => {
            expect(
                hasReplyHeaders([
                    { Name: 'References', Value: '   ' },
                    { Name: 'References', Value: '<a@x>' },
                ]),
            ).toBe(true);
        });

        it('is true even when the value cannot be parsed into an ID', () => {
            // A malformed threading header is still proof this is a reply, so the
            // bot must stay silent rather than answering mid-conversation.
            expect(hasReplyHeaders([{ Name: 'In-Reply-To', Value: '<>' }])).toBe(true);
        });

        it('is false for whitespace-only, absent, and undefined headers', () => {
            expect(hasReplyHeaders([{ Name: 'References', Value: '  ' }])).toBe(false);
            expect(hasReplyHeaders([{ Name: 'Subject', Value: 'hi' }])).toBe(false);
            expect(hasReplyHeaders(undefined)).toBe(false);
        });
    });

    describe('normalizeParticipantEmail', () => {
        it('parses an addressed author label, case-folded', () => {
            expect(normalizeParticipantEmail('Alice Smith <Alice@Example.COM>')).toBe(
                'alice@example.com',
            );
            expect(normalizeParticipantEmail('alice@example.com')).toBe('alice@example.com');
        });

        it('rejects non-address author labels other channels write to the same column', () => {
            // Message.author is shared with every other source; none of these may
            // ever be usable as a participant identity.
            expect(normalizeParticipantEmail('Outpost AI')).toBeNull();
            expect(normalizeParticipantEmail('System')).toBeNull();
            expect(normalizeParticipantEmail('slack:U123456')).toBeNull();
            expect(normalizeParticipantEmail('octocat (583231)')).toBeNull();
            expect(normalizeParticipantEmail('alice@localhost')).toBeNull();
            expect(normalizeParticipantEmail('')).toBeNull();
            expect(normalizeParticipantEmail(undefined)).toBeNull();
            expect(normalizeParticipantEmail(null)).toBeNull();
        });
    });

    // The header reply path is authorization-gated because In-Reply-To /
    // References are attacker-supplied and a Message-ID is *known* to everyone
    // who was ever on the thread, CCs included.
    describe('isTicketParticipant', () => {
        it('accepts the address recorded on an existing message author', () => {
            expect(
                isTicketParticipant('alice@example.com', {
                    messages: [{ author: 'Alice Smith <alice@example.com>' }],
                }),
            ).toBe(true);
        });

        it('accepts the ticket\'s linked user email, case-insensitively', () => {
            expect(
                isTicketParticipant('ALICE@example.com', {
                    user: { email: 'alice@Example.com' },
                    messages: [],
                }),
            ).toBe(true);
        });

        it('accepts a second address at the ticket account domain so aliases are not locked out', () => {
            expect(
                isTicketParticipant('a.smith@acme.com', {
                    account: { domain: 'ACME.com' },
                    messages: [{ author: 'Alice Smith <alice@acme.com>' }],
                }),
            ).toBe(true);
            // Tolerate a domain stored with a leading @.
            expect(
                isTicketParticipant('a.smith@acme.com', {
                    account: { domain: '@acme.com' },
                }),
            ).toBe(true);
        });

        it('rejects an outsider who merely knows a Message-ID from the thread', () => {
            expect(
                isTicketParticipant('cc-observer@evil.test', {
                    user: { email: 'alice@example.com' },
                    account: { domain: 'example.com' },
                    messages: [
                        { author: 'Alice Smith <alice@example.com>' },
                        { author: 'Outpost AI' },
                    ],
                }),
            ).toBe(false);
        });

        it('does not treat the derived domain of a participant address as a domain match', () => {
            // Otherwise every gmail.com sender would be a participant on any
            // ticket opened from a gmail.com address.
            expect(
                isTicketParticipant('attacker@gmail.com', {
                    user: { email: 'victim@gmail.com' },
                    messages: [{ author: 'Victim <victim@gmail.com>' }],
                }),
            ).toBe(false);
        });

        it('rejects a bot-looking sender and an empty participant set', () => {
            expect(isTicketParticipant('Outpost AI', { messages: [{ author: 'Outpost AI' }] })).toBe(
                false,
            );
            expect(isTicketParticipant('alice@example.com', {})).toBe(false);
            expect(isTicketParticipant('', { messages: [{ author: null }] })).toBe(false);
        });
    });

    // ── Route handler tests ────────────────────────────────────────────────

    describe('POST handler', () => {
        /**
         * Answer the `MailboxHash` lookup the way Postgres would: a row comes
         * back only when the query's `source` filter matches the row's own
         * source, and `displayId` has to match.
         *
         * Enforcing the filter inside the mock is what makes the cross-channel
         * test meaningful — a mock that ignored `where.source` could not tell a
         * scoped lookup from an unscoped one, so a DISCORD-ticket case would
         * pass against the vulnerable code too.
         */
        function ticketsByDisplayId(
            map: Record<string, { source?: string } & Record<string, unknown>>,
        ) {
            mockTicketFindUnique.mockImplementation(async (args: unknown) => {
                const where =
                    (args as { where?: { displayId?: string; source?: string } }).where ?? {};
                const row = where.displayId ? map[where.displayId] : undefined;
                if (!row) return null;
                if (where.source !== undefined && (row.source ?? 'EMAIL') !== where.source) {
                    return null;
                }
                return row;
            });
        }

        it('creates a new ticket from a new email', async () => {
            mockTicketCreate.mockResolvedValue({
                id: 'ticket-1',
                displayId: 'TKT-TESTID01',
            });

            const res = await POST(postmarkRequest(fullPayload()));
            expect(res.status).toBe(200);

            const body = await res.json();
            expect(body.status).toBe('ticket_created');
            expect(body.ticketId).toBe('TKT-TESTID01');

            expect(mockTicketCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        displayId: 'TKT-TESTID01',
                        title: 'Need help with billing',
                        description: 'I have a question about my invoice.',
                        source: 'EMAIL',
                        sourceId: 'msg-001@postmark.example',
                    }),
                }),
            );

            // Ticket, opening message, and AI job share one transaction.
            expect(mockTransaction).toHaveBeenCalledTimes(1);
            expect(mockJobCreate).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    type: 'AI_RESPONSE',
                    payload: { ticketId: 'ticket-1', source: 'web' },
                }),
            });
            expect(mockCreateJob).not.toHaveBeenCalled();
        });

        it('creates a ticket with real content from an HTML-only email, and answers it', async () => {
            mockTicketCreate.mockResolvedValue({ id: 'ticket-html', displayId: 'TKT-TESTID01' });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        TextBody: '',
                        HtmlBody:
                            '<html><body><div>Hello,</div><div>My invoice charged me twice.</div></body></html>',
                    }),
                ),
            );

            expect(res.status).toBe(200);
            const expected = 'Hello,\nMy invoice charged me twice.';
            expect(mockTicketCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        description: expected,
                        messages: expect.objectContaining({
                            create: expect.objectContaining({ content: expected }),
                        }),
                    }),
                }),
            );
            // A readable question still earns the ticket's one AI answer.
            expect(mockJobCreate).toHaveBeenCalledTimes(1);
        });

        // An email with no readable text anywhere: still filed for a human (the
        // subject and any attachments are real evidence and must not be dropped),
        // but never handed to the model — answering an empty question produces the
        // apology fallback, delivers it, and marks the ticket answered.
        it('files a ticket but enqueues no AI job when no source yields text', async () => {
            mockTicketCreate.mockResolvedValue({ id: 'ticket-empty', displayId: 'TKT-TESTID01' });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        TextBody: '   ',
                        StrippedTextReply: '',
                        HtmlBody: '<html><body><div><br></div></body></html>',
                        Attachments: [
                            {
                                Name: 'scan.pdf',
                                Content: 'AAAA',
                                ContentType: 'application/pdf',
                                ContentLength: 4,
                            },
                        ],
                    }),
                ),
            );

            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ status: 'ticket_created' });
            expect(mockTicketCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        title: 'Need help with billing',
                        description: EMPTY_EMAIL_BODY_PLACEHOLDER,
                    }),
                }),
            );
            expect(mockJobCreate).not.toHaveBeenCalled();
            expect(mockCreateJob).not.toHaveBeenCalled();
        });

        it('creates one ticket and AI job for concurrent deliveries of the same MessageID', async () => {
            const ticket = {
                id: 'ticket-concurrent',
                displayId: 'TKT-TESTID01',
                source: 'EMAIL',
                sourceId: 'msg-001@postmark.example',
            };
            mockTicketFindFirst
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null)
                .mockResolvedValue(ticket);

            let sourceIdClaimed = false;
            mockTicketCreate.mockImplementation(async () => {
                if (sourceIdClaimed) {
                    throw {
                        code: 'P2002',
                        meta: { target: 'Ticket_email_sourceId_key' },
                    };
                }
                sourceIdClaimed = true;
                return ticket;
            });

            const [first, second] = await Promise.all([
                POST(postmarkRequest(fullPayload())),
                POST(postmarkRequest(fullPayload())),
            ]);

            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(await first.json()).toMatchObject({ ticketId: 'TKT-TESTID01' });
            expect(await second.json()).toMatchObject({ ticketId: 'TKT-TESTID01' });
            expect(mockTicketCreate).toHaveBeenCalledTimes(2);
            expect(mockJobCreate).toHaveBeenCalledTimes(1);
            expect(mockCreateJob).not.toHaveBeenCalled();
        });

        it('rolls back ticket creation when the atomic AI job insert fails, then retries once', async () => {
            const ticket = {
                id: 'ticket-after-retry',
                displayId: 'TKT-TESTID01',
                source: 'EMAIL',
                sourceId: 'msg-001@postmark.example',
            };
            let committedTicket: typeof ticket | null = null;
            let committedJobs = 0;
            let ticketAttempts = 0;
            let failJobInsert = true;

            mockTicketFindFirst.mockImplementation(async () => committedTicket);
            mockTransaction.mockImplementation(
                async (
                    callback: (tx: {
                        ticket: { create: () => Promise<typeof ticket> };
                        job: { create: () => Promise<{ id: string }> };
                    }) => Promise<unknown>,
                ) => {
                    let stagedTicket: typeof ticket | null = null;
                    let stagedJob = false;
                    const result = await callback({
                        ticket: {
                            create: async () => {
                                ticketAttempts += 1;
                                stagedTicket = ticket;
                                return ticket;
                            },
                        },
                        job: {
                            create: async () => {
                                if (failJobInsert) {
                                    failJobInsert = false;
                                    throw new Error('queue insert unavailable');
                                }
                                stagedJob = true;
                                return { id: 'job-after-retry' };
                            },
                        },
                    });
                    committedTicket = stagedTicket;
                    if (stagedJob) committedJobs += 1;
                    return result;
                },
            );

            const first = await POST(postmarkRequest(fullPayload()));
            const retry = await POST(postmarkRequest(fullPayload()));

            expect(first.status).toBe(500);
            expect(retry.status).toBe(200);
            expect(ticketAttempts).toBe(2);
            expect(committedTicket).toEqual(ticket);
            expect(committedJobs).toBe(1);
            expect(mockTransaction).toHaveBeenCalledTimes(2);
            expect(mockCreateJob).not.toHaveBeenCalled();
        });

        it('appends to existing ticket via MailboxHash (plus-addressing)', async () => {
            ticketsByDisplayId({
                'TKT-EXIST123': ticket({
                    id: 'existing-ticket-1',
                    displayId: 'TKT-EXIST123',
                    status: 'OPEN',
                }),
            });
            mockMessageCreate.mockResolvedValue({ id: 'msg-1' });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        MailboxHash: 'TKT-EXIST123',
                        Subject: 'Re: Need help with billing',
                        TextBody: 'Thanks for the update!',
                    }),
                ),
            );

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.status).toBe('message_appended');
            expect(body.ticketId).toBe('TKT-EXIST123');

            // The lookup is scoped at the query, not filtered afterwards, so an
            // inbound mail can never even read a non-EMAIL ticket.
            expect(mockTicketFindUnique).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { displayId: 'TKT-EXIST123', source: 'EMAIL' },
                }),
            );

            expect(mockMessageCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        ticketId: 'existing-ticket-1',
                        content: 'Thanks for the update!',
                        type: 'USER',
                    }),
                }),
            );

            // Should NOT create a new ticket
            expect(mockTicketCreate).not.toHaveBeenCalled();

            // Should NOT enqueue AI_RESPONSE for the reply — one answer per
            // ticket, on the opening email only. A human owns the thread after
            // the first response.
            expect(mockCreateJob).not.toHaveBeenCalled();
        });

        it('uses StrippedTextReply when available', async () => {
            mockTicketCreate.mockResolvedValue({
                id: 'ticket-stripped',
                displayId: 'TKT-TESTID01',
            });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        TextBody: 'Full email with quoted text\n\n> Original message...',
                        StrippedTextReply: 'Just the reply part',
                    }),
                ),
            );

            expect(res.status).toBe(200);
            expect(mockTicketCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        description: 'Just the reply part',
                    }),
                }),
            );
        });

        it('re-opens resolved ticket on new inbound reply', async () => {
            ticketsByDisplayId({
                'TKT-RESOLVED': ticket({
                    id: 'resolved-ticket',
                    displayId: 'TKT-RESOLVED',
                    status: 'RESOLVED',
                }),
            });
            mockMessageCreate.mockResolvedValue({ id: 'msg-reopen' });
            mockTicketUpdate.mockResolvedValue({});

            await POST(
                postmarkRequest(
                    fullPayload({
                        MailboxHash: 'TKT-RESOLVED',
                    }),
                ),
            );

            expect(mockTicketUpdate).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 'resolved-ticket' },
                    data: expect.objectContaining({ status: 'OPEN' }),
                }),
            );
        });

        // WAITING_ON_CUSTOMER used to be missing from this path's status list, so
        // an email reply to a ticket that was waiting on the customer stayed out
        // of the queue entirely — replies no longer trigger an AI response, so
        // the reopen is the only signal that reaches a human.
        it.each(['WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'])(
            're-opens a %s ticket on a new inbound reply',
            async (status) => {
                ticketsByDisplayId({
                    'TKT-DORMANT1': ticket({
                        id: 'dormant-ticket',
                        displayId: 'TKT-DORMANT1',
                        status,
                    }),
                });
                mockMessageCreate.mockResolvedValue({ id: 'msg-reopen' });
                mockTicketUpdate.mockResolvedValue({});

                await POST(postmarkRequest(fullPayload({ MailboxHash: 'TKT-DORMANT1' })));

                expect(mockTicketUpdate).toHaveBeenCalledWith(
                    expect.objectContaining({
                        where: { id: 'dormant-ticket' },
                        data: expect.objectContaining({ status: 'OPEN' }),
                    }),
                );
            },
        );

        it.each(['OPEN', 'IN_PROGRESS', 'WAITING_ON_TEAM'])(
            'leaves a %s ticket status untouched on a new inbound reply',
            async (status) => {
                ticketsByDisplayId({
                    'TKT-LIVE0001': ticket({
                        id: 'live-ticket',
                        displayId: 'TKT-LIVE0001',
                        status,
                    }),
                });
                mockMessageCreate.mockResolvedValue({ id: 'msg-append' });

                await POST(postmarkRequest(fullPayload({ MailboxHash: 'TKT-LIVE0001' })));

                expect(mockMessageCreate).toHaveBeenCalled();
                expect(mockTicketUpdate).not.toHaveBeenCalled();
            },
        );

        // ── Reply redelivery idempotency ───────────────────────────────────
        //
        // Postmark retries every non-2xx delivery and this route's catch returns
        // 500, so the same reply reaches us more than once as a matter of course.
        // Appending twice and reopening twice are two separate observable
        // effects; both have to be no-ops on the retry.
        describe('redelivered reply', () => {
            /**
             * Stand in for the `@@unique([ticketId, sourceMessageId])` index:
             * remembers what has been appended so `message.findFirst` answers
             * the second delivery truthfully, and rejects a second insert of the
             * same key with Prisma's P2002 the way Postgres would.
             */
            function withMessageStore() {
                const stored = new Set<string>();
                const key = (ticketId: string, sourceMessageId: string | null) =>
                    `${ticketId}::${sourceMessageId}`;

                mockMessageFindFirst.mockImplementation(
                    async (args: {
                        where: { ticketId: string; sourceMessageId: string | null };
                    }) =>
                        stored.has(key(args.where.ticketId, args.where.sourceMessageId))
                            ? { id: 'existing-msg' }
                            : null,
                );
                mockMessageCreate.mockImplementation(
                    async (args: {
                        data: { ticketId: string; sourceMessageId?: string | null };
                    }) => {
                        const k = key(args.data.ticketId, args.data.sourceMessageId ?? null);
                        if (stored.has(k)) {
                            throw Object.assign(new Error('Unique constraint failed'), {
                                code: 'P2002',
                            });
                        }
                        stored.add(k);
                        return { id: `msg-${stored.size}` };
                    },
                );
                return stored;
            }

            it('appends exactly one message and reopens once when the same MessageID is delivered twice', async () => {
                withMessageStore();
                mockTicketFindUnique.mockResolvedValue({
                    id: 'resolved-ticket',
                    displayId: 'TKT-RESOLVED',
                    status: 'RESOLVED',
                    // Since the MailboxHash path became participant-gated, a reply
                    // fixture has to look like a ticket alice@example.com belongs to,
                    // or resolution correctly refuses it and this exercises the
                    // new-ticket path instead.
                    user: { email: 'alice@example.com' },
                    account: null,
                    messages: [{ author: 'Alice Smith <alice@example.com>' }],
                });
                mockTicketUpdate.mockResolvedValue({});

                const payload = fullPayload({
                    MailboxHash: 'TKT-RESOLVED',
                    MessageID: 'retried-reply@postmark.example',
                    TextBody: 'Still broken.',
                });

                const first = await POST(postmarkRequest(payload));
                const second = await POST(postmarkRequest(payload));

                // Both are 2xx: a non-2xx would keep Postmark retrying a
                // delivery we have already fully processed.
                expect(first.status).toBe(200);
                expect(second.status).toBe(200);
                expect(await first.json()).toEqual({
                    status: 'message_appended',
                    ticketId: 'TKT-RESOLVED',
                });
                expect(await second.json()).toEqual({
                    status: 'message_appended',
                    ticketId: 'TKT-RESOLVED',
                    duplicate: true,
                });

                // The customer's words appear on the ticket once...
                expect(mockMessageCreate).toHaveBeenCalledTimes(1);
                expect(mockMessageCreate).toHaveBeenCalledWith(
                    expect.objectContaining({
                        data: expect.objectContaining({
                            ticketId: 'resolved-ticket',
                            content: 'Still broken.',
                            sourceMessageId: 'retried-reply@postmark.example',
                        }),
                    }),
                );
                // ...and the resolved ticket is dragged back into the queue once,
                // not once per retry.
                expect(mockTicketUpdate).toHaveBeenCalledTimes(1);
                expect(mockTicketCreate).not.toHaveBeenCalled();
                expect(mockCreateJob).not.toHaveBeenCalled();
                expect(mockJobCreate).not.toHaveBeenCalled();
            });

            it('is idempotent on the header reply path too, not just MailboxHash', async () => {
                withMessageStore();
                ticketsBySourceId({
                    'root-msg@postmark.example': ticket({
                        id: 'ticket-root',
                        displayId: 'TKT-ROOT0001',
                        status: 'CLOSED',
                    }),
                });
                mockTicketUpdate.mockResolvedValue({});

                const payload = fullPayload({
                    MessageID: 'retried-reply@postmark.example',
                    Headers: headers('<root-msg@postmark.example>'),
                });

                await POST(postmarkRequest(payload));
                const second = await POST(postmarkRequest(payload));

                expect(second.status).toBe(200);
                expect(await second.json()).toMatchObject({ duplicate: true });
                expect(mockMessageCreate).toHaveBeenCalledTimes(1);
                expect(mockTicketUpdate).toHaveBeenCalledTimes(1);
            });

            // The pre-read cannot cover two deliveries in flight together; the
            // unique index is the authority there and P2002 has to be read as
            // "already appended", not as an error worth a 500 (which Postmark
            // would retry forever).
            it('treats a P2002 from a concurrent delivery as already-appended, without reopening', async () => {
                mockTicketFindUnique.mockResolvedValue({
                    id: 'resolved-ticket',
                    displayId: 'TKT-RESOLVED',
                    status: 'RESOLVED',
                    // Since the MailboxHash path became participant-gated, a reply
                    // fixture has to look like a ticket alice@example.com belongs to,
                    // or resolution correctly refuses it and this exercises the
                    // new-ticket path instead.
                    user: { email: 'alice@example.com' },
                    account: null,
                    messages: [{ author: 'Alice Smith <alice@example.com>' }],
                });
                mockMessageCreate.mockRejectedValue(
                    Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
                );
                mockTicketUpdate.mockResolvedValue({});

                const res = await POST(
                    postmarkRequest(
                        fullPayload({
                            MailboxHash: 'TKT-RESOLVED',
                            MessageID: 'raced-reply@postmark.example',
                        }),
                    ),
                );

                expect(res.status).toBe(200);
                expect(await res.json()).toEqual({
                    status: 'message_appended',
                    ticketId: 'TKT-RESOLVED',
                    duplicate: true,
                });
                expect(mockTicketUpdate).not.toHaveBeenCalled();
            });

            // The mirror-image gap: if the message committed and the reopen did
            // not, the retry would short-circuit on the stored message and the
            // reply would never reach a human. One transaction closes it.
            it('writes the message and the reopen in the same transaction', async () => {
                // Separate spies for the transaction client, so "ran inside the
                // transaction" means it used `tx` — not merely that it happened
                // during the callback, which a plain `prisma.*` call would also
                // satisfy while still committing on its own.
                const txMessageCreate = vi.fn().mockResolvedValue({ id: 'msg-1' });
                const txTicketUpdate = vi.fn().mockResolvedValue({});
                const order: string[] = [];
                mockTransaction.mockImplementation(
                    async (callback: (tx: unknown) => Promise<unknown>) =>
                        callback({
                            ticket: {
                                create: mockTicketCreate,
                                update: (...args: unknown[]) => {
                                    order.push('ticket.update');
                                    return txTicketUpdate(...args);
                                },
                            },
                            message: {
                                create: (...args: unknown[]) => {
                                    order.push('message.create');
                                    return txMessageCreate(...args);
                                },
                            },
                            job: { create: mockJobCreate },
                        }),
                );
                mockTicketFindUnique.mockResolvedValue({
                    id: 'resolved-ticket',
                    displayId: 'TKT-RESOLVED',
                    status: 'RESOLVED',
                    // Since the MailboxHash path became participant-gated, a reply
                    // fixture has to look like a ticket alice@example.com belongs to,
                    // or resolution correctly refuses it and this exercises the
                    // new-ticket path instead.
                    user: { email: 'alice@example.com' },
                    account: null,
                    messages: [{ author: 'Alice Smith <alice@example.com>' }],
                });

                await POST(
                    postmarkRequest(
                        fullPayload({
                            MailboxHash: 'TKT-RESOLVED',
                            MessageID: 'atomic-reply@postmark.example',
                        }),
                    ),
                );

                expect(order).toEqual(['message.create', 'ticket.update']);
                expect(mockTransaction).toHaveBeenCalledTimes(1);
                expect(txMessageCreate).toHaveBeenCalledTimes(1);
                expect(txTicketUpdate).toHaveBeenCalledTimes(1);
                // Neither effect escaped to the non-transactional client.
                expect(mockMessageCreate).not.toHaveBeenCalled();
                expect(mockTicketUpdate).not.toHaveBeenCalled();
            });

            // The dedup key must be the indexed column, not a jsonb path scan —
            // and the opening message has to carry it as well, or the ticket's
            // first message is the one row a retry cannot recognize.
            it('looks the duplicate up by the indexed column, and stamps it on the opening message too', async () => {
                mockTicketFindUnique.mockResolvedValue({
                    id: 'live-ticket',
                    displayId: 'TKT-LIVE0001',
                    status: 'OPEN',
                    // Since the MailboxHash path became participant-gated, a reply
                    // fixture has to look like a ticket alice@example.com belongs to,
                    // or resolution correctly refuses it and this exercises the
                    // new-ticket path instead.
                    user: { email: 'alice@example.com' },
                    account: null,
                    messages: [{ author: 'Alice Smith <alice@example.com>' }],
                });
                mockMessageCreate.mockResolvedValue({ id: 'msg-1' });

                await POST(
                    postmarkRequest(
                        fullPayload({
                            MailboxHash: 'TKT-LIVE0001',
                            MessageID: 'reply-msg@postmark.example',
                        }),
                    ),
                );

                expect(mockMessageFindFirst).toHaveBeenCalledWith(
                    expect.objectContaining({
                        where: {
                            ticketId: 'live-ticket',
                            sourceMessageId: 'reply-msg@postmark.example',
                        },
                    }),
                );

                vi.clearAllMocks();
                mockTicketFindUnique.mockResolvedValue(null);
                mockTicketFindFirst.mockResolvedValue(null);
                mockTicketFindMany.mockResolvedValue([]);
                mockMessageFindMany.mockResolvedValue([]);
                mockTicketCreate.mockResolvedValue({
                    id: 'new-ticket',
                    displayId: 'TKT-TESTID01',
                });
                mockTransaction.mockImplementation(
                    async (callback: (tx: unknown) => Promise<unknown>) =>
                        callback({
                            ticket: { create: mockTicketCreate, update: mockTicketUpdate },
                            message: { create: mockMessageCreate },
                            job: { create: mockJobCreate },
                        }),
                );

                await POST(postmarkRequest(fullPayload({ MessageID: 'new-msg@postmark.example' })));

                expect(mockTicketCreate).toHaveBeenCalledWith(
                    expect.objectContaining({
                        data: expect.objectContaining({
                            messages: {
                                create: expect.objectContaining({
                                    sourceMessageId: 'new-msg@postmark.example',
                                }),
                            },
                        }),
                    }),
                );
            });
        });

        it('files an orphaned reply without enqueueing an AI response', async () => {
            mockTicketFindUnique.mockResolvedValue(null);
            mockTicketCreate.mockResolvedValue({
                id: 'new-ticket',
                displayId: 'TKT-TESTID01',
            });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        MailboxHash: 'TKT-NOTEXIST',
                    }),
                ),
            );

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.status).toBe('ticket_created');
            expect(mockTicketCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        description: 'I have a question about my invoice.',
                        messages: expect.objectContaining({
                            create: expect.objectContaining({
                                content: 'I have a question about my invoice.',
                                type: 'USER',
                            }),
                        }),
                    }),
                }),
            );
            expect(mockCreateJob).not.toHaveBeenCalled();
        });

        // ── Reply detection via RFC 5322 threading headers ──────────────────
        //
        // MailboxHash only survives when the customer's client preserves the
        // plus-address. The normal case is a reply to a plain From address, which
        // carries In-Reply-To / References and nothing else. Those replies used to
        // fall through to the new-ticket branch and got a second AI answer for a
        // conversation already in progress.

        /** Build a Postmark Headers array for a reply. */
        function headers(inReplyTo?: string, references?: string) {
            const list = [
                { Name: 'Date', Value: 'Mon, 3 Feb 2025 10:00:00 +0000' },
                { Name: 'Subject', Value: 'Re: Need help with billing' },
            ];
            if (inReplyTo !== undefined) list.push({ Name: 'In-Reply-To', Value: inReplyTo });
            if (references !== undefined) list.push({ Name: 'References', Value: references });
            return list;
        }

        /**
         * A resolvable ticket whose participant set already contains the default
         * payload sender (`alice@example.com`, recorded as the author of the
         * opening message). Header resolution is authorization-gated, so every
         * legitimate-reply fixture has to look like a real conversation.
         */
        function ticket(
            // `source` is only set by the cross-channel cases; it stands in for the
            // row's own column so `ticketsByDisplayId` can apply the query filter.
            fields: { id: string; displayId: string; status: string; source?: string },
            participants: {
                messages?: Array<{ author: string | null }>;
                user?: { email: string | null } | null;
                account?: { domain: string | null } | null;
            } = {},
        ) {
            return {
                ...fields,
                user: participants.user ?? null,
                account: participants.account ?? null,
                messages: participants.messages ?? [
                    { author: 'Alice Smith <alice@example.com>' },
                    { author: 'Outpost AI' },
                ],
            };
        }

        /**
         * Answer the reply-resolution ticket lookup (`sourceId: { in: [...] }`)
         * from a map, while leaving the MessageID idempotency lookup
         * (`sourceId: '<string>'`, a `findFirst`) returning null.
         */
        function ticketsBySourceId(map: Record<string, unknown>) {
            mockTicketFindMany.mockImplementation(async (args: unknown) => {
                const where = (args as { where?: { sourceId?: { in?: string[] } } }).where;
                const ids = where?.sourceId?.in;
                if (!Array.isArray(ids)) return [];
                // Insertion order into `map` stands in for `orderBy createdAt asc`.
                return Object.entries(map)
                    .filter(([id]) => ids.includes(id))
                    .map(([, value]) => value);
            });
        }

        it('appends a reply whose In-Reply-To matches a ticket sourceId, with no AI job', async () => {
            ticketsBySourceId({
                'root-msg@postmark.example': ticket({
                    id: 'ticket-root',
                    displayId: 'TKT-ROOT0001',
                    status: 'OPEN',
                }),
            });
            mockMessageCreate.mockResolvedValue({ id: 'msg-appended' });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        MessageID: 'reply-msg@postmark.example',
                        Subject: 'Re: Need help with billing',
                        TextBody: 'Any update on this?',
                        Headers: headers('<root-msg@postmark.example>'),
                    }),
                ),
            );

            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({
                status: 'message_appended',
                ticketId: 'TKT-ROOT0001',
            });
            expect(mockMessageCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        ticketId: 'ticket-root',
                        content: 'Any update on this?',
                        // Every appended message records its inbound Message-ID so a
                        // later reply can resolve to this mid-thread message.
                        attachments: expect.objectContaining({
                            postmarkMessageId: 'reply-msg@postmark.example',
                        }),
                    }),
                }),
            );
            // The whole point: no second ticket, no second answer.
            expect(mockTicketCreate).not.toHaveBeenCalled();
            // One transaction — the append's own (message + conditional reopen).
            // Not the ticket-creating one: no ticket was created.
            expect(mockTransaction).toHaveBeenCalledTimes(1);
            expect(mockJobCreate).not.toHaveBeenCalled();
            expect(mockCreateJob).not.toHaveBeenCalled();
        });

        it('resolves a reply through the References chain when In-Reply-To names an outbound ID we never stored', async () => {
            // Outbound Message-IDs are not persisted (postResponse is unimplemented),
            // so a reply to our own message names an ID no row holds. References
            // still carries the customer's opening Message-ID.
            ticketsBySourceId({
                'root-msg@postmark.example': ticket({
                    id: 'ticket-root',
                    displayId: 'TKT-ROOT0001',
                    status: 'WAITING_ON_CUSTOMER',
                }),
            });
            mockMessageCreate.mockResolvedValue({ id: 'msg-appended' });
            mockTicketUpdate.mockResolvedValue({});

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        MessageID: 'reply-msg@postmark.example',
                        Headers: headers(
                            '<outbound-never-stored@outpost.dev>',
                            '<root-msg@postmark.example>\r\n\t<outbound-never-stored@outpost.dev>',
                        ),
                    }),
                ),
            );

            expect(await res.json()).toMatchObject({
                status: 'message_appended',
                ticketId: 'TKT-ROOT0001',
            });
            // Dormant ticket reopens so a human sees the reply.
            expect(mockTicketUpdate).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 'ticket-root' },
                    data: expect.objectContaining({ status: 'OPEN' }),
                }),
            );
            expect(mockJobCreate).not.toHaveBeenCalled();
        });

        it('resolves a reply whose root ID sits in a LATER References header line', async () => {
            // Some clients split a long References chain over several header
            // lines. Reading only the first line dropped the segment holding the
            // thread root, and the reply opened a brand-new ticket instead.
            ticketsBySourceId({
                'root-msg@postmark.example': ticket({
                    id: 'ticket-root',
                    displayId: 'TKT-ROOT0001',
                    status: 'OPEN',
                }),
            });
            mockMessageCreate.mockResolvedValue({ id: 'msg-appended' });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        MessageID: 'reply-msg@postmark.example',
                        Subject: 'Re: Need help with billing',
                        TextBody: 'Still waiting.',
                        Headers: [
                            { Name: 'Date', Value: 'Mon, 3 Feb 2025 10:00:00 +0000' },
                            {
                                Name: 'References',
                                Value: '<other-a@x> <other-b@x>',
                            },
                            {
                                Name: 'References',
                                Value: '<root-msg@postmark.example>\r\n\t<other-c@x>',
                            },
                        ],
                    }),
                ),
            );

            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({
                status: 'message_appended',
                ticketId: 'TKT-ROOT0001',
            });
            expect(mockTicketCreate).not.toHaveBeenCalled();
            expect(mockJobCreate).not.toHaveBeenCalled();
        });

        it('resolves a reply that matches a mid-thread Message.attachments.postmarkMessageId', async () => {
            ticketsBySourceId({});
            mockMessageFindMany.mockResolvedValue([
                {
                    ticket: ticket({
                        id: 'ticket-mid',
                        displayId: 'TKT-MID00001',
                        status: 'OPEN',
                    }),
                },
            ]);
            mockMessageCreate.mockResolvedValue({ id: 'msg-appended' });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        MessageID: 'reply-msg@postmark.example',
                        Headers: headers('<mid-thread@postmark.example>'),
                    }),
                ),
            );

            expect(await res.json()).toMatchObject({
                status: 'message_appended',
                ticketId: 'TKT-MID00001',
            });
            expect(mockMessageFindMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        OR: [
                            {
                                attachments: {
                                    path: ['postmarkMessageId'],
                                    equals: 'mid-thread@postmark.example',
                                },
                            },
                        ],
                    }),
                }),
            );
            expect(mockTicketCreate).not.toHaveBeenCalled();
            expect(mockJobCreate).not.toHaveBeenCalled();
        });

        it('files a reply whose headers resolve to nothing as a ticket with no AI job', async () => {
            ticketsBySourceId({});
            mockTicketCreate.mockResolvedValue({
                id: 'ticket-orphan-header',
                displayId: 'TKT-TESTID01',
            });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        MessageID: 'reply-msg@postmark.example',
                        TextBody: 'Following up on the thread from last year.',
                        Headers: headers('<long-deleted@postmark.example>'),
                    }),
                ),
            );

            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ status: 'ticket_created' });
            // Kept for a human...
            expect(mockTicketCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        description: 'Following up on the thread from last year.',
                    }),
                }),
            );
            // ...but never answered.
            expect(mockJobCreate).not.toHaveBeenCalled();
            expect(mockCreateJob).not.toHaveBeenCalled();
        });

        // ── Header reply path is authorization-gated ────────────────────────
        //
        // In-Reply-To / References come from the sender, and a Message-ID is
        // KNOWN to every thread participant — including anyone ever CC'd. Header
        // matching alone therefore let an outsider append to, and reopen, someone
        // else's ticket. The sender must already be a participant.

        it('does NOT append a non-participant who names a valid ticket Message-ID, and preserves their mail instead', async () => {
            ticketsBySourceId({
                'root-msg@postmark.example': ticket(
                    { id: 'ticket-victim', displayId: 'TKT-VICTIM01', status: 'RESOLVED' },
                    {
                        user: { email: 'alice@example.com' },
                        account: { domain: 'example.com' },
                        messages: [
                            { author: 'Alice Smith <alice@example.com>' },
                            { author: 'Outpost AI' },
                        ],
                    },
                ),
            });
            mockTicketCreate.mockResolvedValue({
                id: 'ticket-outsider',
                displayId: 'TKT-TESTID01',
            });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        // A CC on the thread: holds the Message-ID, is not a participant.
                        From: 'Eve Observer <eve@evil.test>',
                        FromName: 'Eve Observer',
                        MessageID: 'outsider-msg@postmark.example',
                        Subject: 'Re: Need help with billing',
                        TextBody: 'Please wire the payment to this account instead.',
                        Headers: headers('<root-msg@postmark.example>'),
                    }),
                ),
            );

            expect(res.status).toBe(200);
            // Not appended to the victim's ticket...
            expect(mockMessageCreate).not.toHaveBeenCalled();
            // ...and the dormant victim ticket is NOT reopened.
            expect(mockTicketUpdate).not.toHaveBeenCalled();

            // ...but the mail is not dropped either: it is filed as its own
            // ticket down the orphaned-reply path so a human still sees it.
            expect(await res.json()).toMatchObject({ status: 'ticket_created' });
            expect(mockTicketCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        description: 'Please wire the payment to this account instead.',
                        sourceId: 'outsider-msg@postmark.example',
                        messages: expect.objectContaining({
                            create: expect.objectContaining({
                                content: 'Please wire the payment to this account instead.',
                                author: 'Eve Observer <eve@evil.test>',
                            }),
                        }),
                    }),
                }),
            );
            // Being a reply, it never earns an AI response.
            expect(mockJobCreate).not.toHaveBeenCalled();
            expect(mockCreateJob).not.toHaveBeenCalled();
        });

        it('does NOT append a non-participant who names a valid mid-thread Message-ID', async () => {
            ticketsBySourceId({});
            mockMessageFindMany.mockResolvedValue([
                {
                    ticket: ticket(
                        { id: 'ticket-victim', displayId: 'TKT-VICTIM01', status: 'CLOSED' },
                        { messages: [{ author: 'Alice Smith <alice@example.com>' }] },
                    ),
                },
            ]);
            mockTicketCreate.mockResolvedValue({ id: 'ticket-outsider', displayId: 'TKT-TESTID01' });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        From: 'Eve Observer <eve@evil.test>',
                        MessageID: 'outsider-msg@postmark.example',
                        Headers: headers('<mid-thread@postmark.example>'),
                    }),
                ),
            );

            expect(await res.json()).toMatchObject({ status: 'ticket_created' });
            expect(mockMessageCreate).not.toHaveBeenCalled();
            expect(mockTicketUpdate).not.toHaveBeenCalled();
            expect(mockJobCreate).not.toHaveBeenCalled();
        });

        it('appends a reply from a second address at the ticket account domain', async () => {
            ticketsBySourceId({
                'root-msg@postmark.example': ticket(
                    { id: 'ticket-root', displayId: 'TKT-ROOT0001', status: 'OPEN' },
                    {
                        account: { domain: 'example.com' },
                        messages: [{ author: 'Alice Smith <alice@example.com>' }],
                    },
                ),
            });
            mockMessageCreate.mockResolvedValue({ id: 'msg-appended' });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        From: 'Bob Jones <bob@example.com>',
                        MessageID: 'colleague-msg@postmark.example',
                        Headers: headers('<root-msg@postmark.example>'),
                    }),
                ),
            );

            expect(await res.json()).toMatchObject({
                status: 'message_appended',
                ticketId: 'TKT-ROOT0001',
            });
            expect(mockTicketCreate).not.toHaveBeenCalled();
        });

        it('lands on the sender\'s own ticket when the chain also names someone else\'s older ticket', async () => {
            ticketsBySourceId({
                // Oldest first — a plain "take the oldest row" resolution would
                // pick the victim's ticket and then refuse the whole reply.
                'victim-root@postmark.example': ticket(
                    { id: 'ticket-victim', displayId: 'TKT-VICTIM01', status: 'OPEN' },
                    { messages: [{ author: 'Carol <carol@other.test>' }] },
                ),
                'own-root@postmark.example': ticket({
                    id: 'ticket-own',
                    displayId: 'TKT-OWN00001',
                    status: 'OPEN',
                }),
            });
            mockMessageCreate.mockResolvedValue({ id: 'msg-appended' });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        MessageID: 'reply-msg@postmark.example',
                        Headers: headers(
                            '<own-root@postmark.example>',
                            '<victim-root@postmark.example> <own-root@postmark.example>',
                        ),
                    }),
                ),
            );

            expect(await res.json()).toMatchObject({
                status: 'message_appended',
                ticketId: 'TKT-OWN00001',
            });
        });

        // ── MailboxHash is not a capability token (issue #189) ───────────────
        //
        // `generateTicketId()` is short (8 chars) and the Discord/Slack
        // bots posted "Ticket TKT-XXXXXXXX created" into public threads. Display
        // IDs are therefore harvestable, so the plus-address path is gated the
        // same way the header path is: EMAIL-sourced ticket, participating sender.

        it("appends a participant's plus-addressed reply, including from a plus-alias of their address", async () => {
            ticketsByDisplayId({
                'TKT-HASH0001': ticket(
                    { id: 'hash-ticket', displayId: 'TKT-HASH0001', status: 'RESOLVED' },
                    { account: { domain: 'example.com' } },
                ),
            });
            mockMessageCreate.mockResolvedValue({ id: 'msg-appended' });
            mockTicketUpdate.mockResolvedValue({});

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        // A different local part at the ticket's account domain —
                        // a colleague or second address, which the shared
                        // participant rule admits via Account.domain.
                        From: 'Alice Smith <alice+support@example.com>',
                        MailboxHash: 'TKT-HASH0001',
                    }),
                ),
            );

            expect(await res.json()).toMatchObject({
                status: 'message_appended',
                ticketId: 'TKT-HASH0001',
            });
            expect(mockTicketUpdate).toHaveBeenCalled();
            expect(mockTicketCreate).not.toHaveBeenCalled();
        });

        it('does not let a stranger append to an EMAIL ticket by naming its displayId, and still preserves their mail', async () => {
            ticketsByDisplayId({
                'TKT-HASH0001': ticket({
                    id: 'hash-ticket',
                    displayId: 'TKT-HASH0001',
                    status: 'RESOLVED',
                }),
            });
            mockTicketCreate.mockResolvedValue({
                id: 'ticket-orphan-stranger',
                displayId: 'TKT-TESTID01',
            });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        From: 'Mallory <mallory@attacker.test>',
                        MessageID: 'stranger-msg@postmark.example',
                        MailboxHash: 'TKT-HASH0001',
                    }),
                ),
            );

            // Nothing touches the victim's ticket: no append, no reopen.
            expect(mockMessageCreate).not.toHaveBeenCalled();
            expect(mockTicketUpdate).not.toHaveBeenCalled();

            // But the mail is not dropped — it falls through to the orphan path,
            // filed for a human with no AI response spent on it.
            expect(await res.json()).toMatchObject({
                status: 'ticket_created',
                ticketId: 'TKT-TESTID01',
            });
            expect(mockTicketCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        messages: expect.objectContaining({
                            create: expect.objectContaining({
                                content: 'I have a question about my invoice.',
                            }),
                        }),
                    }),
                }),
            );
            expect(mockJobCreate).not.toHaveBeenCalled();
        });

        it('does not let an inbound mail append to a DISCORD ticket that shares the named displayId', async () => {
            ticketsByDisplayId({
                // Same participant set as a legitimate email ticket — only the
                // source differs, so the source scope is the only thing that can
                // stop this append.
                'TKT-DISCORD1': ticket({
                    id: 'discord-ticket',
                    displayId: 'TKT-DISCORD1',
                    status: 'RESOLVED',
                    source: 'DISCORD',
                }),
            });
            mockTicketCreate.mockResolvedValue({
                id: 'ticket-orphan-discord',
                displayId: 'TKT-TESTID01',
            });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        MessageID: 'cross-channel@postmark.example',
                        MailboxHash: 'TKT-DISCORD1',
                    }),
                ),
            );

            expect(mockTicketFindUnique).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { displayId: 'TKT-DISCORD1', source: 'EMAIL' },
                }),
            );
            expect(mockMessageCreate).not.toHaveBeenCalled();
            expect(mockTicketUpdate).not.toHaveBeenCalled();
            expect(await res.json()).toMatchObject({ status: 'ticket_created' });
            expect(mockJobCreate).not.toHaveBeenCalled();
        });

        it('still answers a genuinely new email that carries headers but no threading headers', async () => {
            mockTicketCreate.mockResolvedValue({ id: 'ticket-new', displayId: 'TKT-TESTID01' });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        Headers: [
                            { Name: 'Date', Value: 'Mon, 3 Feb 2025 10:00:00 +0000' },
                            { Name: 'Subject', Value: 'Need help with billing' },
                            { Name: 'Message-ID', Value: '<msg-001@postmark.example>' },
                        ],
                    }),
                ),
            );

            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ status: 'ticket_created' });
            // The fix must not blanket-mute email: a new ticket still gets its one job.
            expect(mockJobCreate).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    type: 'AI_RESPONSE',
                    payload: { ticketId: 'ticket-new', source: 'web' },
                }),
            });
            // No threading headers means no header lookups at all.
            expect(mockMessageFindMany).not.toHaveBeenCalled();
            expect(mockTicketFindMany).not.toHaveBeenCalled();
        });

        it('treats an empty References header as not-a-reply', async () => {
            mockTicketCreate.mockResolvedValue({ id: 'ticket-new', displayId: 'TKT-TESTID01' });

            await POST(postmarkRequest(fullPayload({ Headers: headers(undefined, '   ') })));

            expect(mockJobCreate).toHaveBeenCalledTimes(1);
        });

        it('keeps MailboxHash as the primary reply path, without header lookups', async () => {
            ticketsByDisplayId({
                'TKT-HASH0001': ticket({
                    id: 'hash-ticket',
                    displayId: 'TKT-HASH0001',
                    status: 'OPEN',
                }),
            });
            mockMessageCreate.mockResolvedValue({ id: 'msg-appended' });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        MailboxHash: 'TKT-HASH0001',
                        Headers: headers('<root-msg@postmark.example>'),
                    }),
                ),
            );

            expect(await res.json()).toMatchObject({ ticketId: 'TKT-HASH0001' });
            expect(mockTicketFindFirst).not.toHaveBeenCalled();
            expect(mockTicketFindMany).not.toHaveBeenCalled();
            expect(mockMessageFindMany).not.toHaveBeenCalled();
        });

        // A mail can legitimately carry both a plus-address and threading
        // headers. The hash used to sit in an `if`/`else` with the header path, so
        // a hash naming a ticket that no longer resolves — deleted, non-EMAIL, or
        // not this sender's — skipped header matching entirely and orphaned a
        // reply that the headers could have placed correctly.
        it('falls back to header matching when the MailboxHash names no ticket', async () => {
            ticketsByDisplayId({});
            ticketsBySourceId({
                'root-msg@postmark.example': ticket({
                    id: 'ticket-root',
                    displayId: 'TKT-ROOT0001',
                    status: 'OPEN',
                }),
            });
            mockMessageCreate.mockResolvedValue({ id: 'msg-appended' });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        MessageID: 'reply-msg@postmark.example',
                        MailboxHash: 'TKT-NOTEXIST',
                        Headers: headers('<root-msg@postmark.example>'),
                    }),
                ),
            );

            expect(await res.json()).toEqual({
                status: 'message_appended',
                ticketId: 'TKT-ROOT0001',
            });
            expect(mockMessageCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ ticketId: 'ticket-root' }),
                }),
            );
            expect(mockTicketCreate).not.toHaveBeenCalled();
            expect(mockJobCreate).not.toHaveBeenCalled();
        });

        it('falls back to header matching when the MailboxHash names a ticket the sender may not touch', async () => {
            ticketsByDisplayId({
                // Someone else's ticket, harvested display ID.
                'TKT-VICTIM01': ticket(
                    { id: 'victim-ticket', displayId: 'TKT-VICTIM01', status: 'RESOLVED' },
                    { messages: [{ author: 'Victim <victim@other.test>' }] },
                ),
            });
            ticketsBySourceId({
                'root-msg@postmark.example': ticket({
                    id: 'ticket-root',
                    displayId: 'TKT-ROOT0001',
                    status: 'OPEN',
                }),
            });
            mockMessageCreate.mockResolvedValue({ id: 'msg-appended' });

            const res = await POST(
                postmarkRequest(
                    fullPayload({
                        MessageID: 'reply-msg@postmark.example',
                        MailboxHash: 'TKT-VICTIM01',
                        Headers: headers('<root-msg@postmark.example>'),
                    }),
                ),
            );

            // The sender's own ticket, never the one the hash named.
            expect(await res.json()).toMatchObject({
                status: 'message_appended',
                ticketId: 'TKT-ROOT0001',
            });
            expect(mockMessageCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ ticketId: 'ticket-root' }),
                }),
            );
        });

        it('files an unresolvable MailboxHash reply when headers cannot place it either', async () => {
            ticketsByDisplayId({});
            mockTicketCreate.mockResolvedValue({
                id: 'ticket-orphan-hash',
                displayId: 'TKT-TESTID01',
            });

            await POST(
                postmarkRequest(
                    fullPayload({
                        MailboxHash: 'TKT-NOTEXIST',
                        Headers: headers('<root-msg@postmark.example>'),
                    }),
                ),
            );

            // Header matching was attempted (that is the fix) and found nothing,
            // so the mail is still preserved without an AI response.
            expect(mockTicketFindMany).toHaveBeenCalled();
            expect(mockTicketCreate).toHaveBeenCalled();
            expect(mockJobCreate).not.toHaveBeenCalled();
        });

        it('handles attachments in the payload', async () => {
            mockTicketCreate.mockResolvedValue({
                id: 'ticket-attach',
                displayId: 'TKT-TESTID01',
            });

            await POST(
                postmarkRequest(
                    fullPayload({
                        Attachments: [
                            {
                                Name: 'screenshot.png',
                                Content: 'base64data...',
                                ContentType: 'image/png',
                                ContentLength: 12345,
                            },
                        ],
                    }),
                ),
            );

            expect(mockTicketCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        messages: expect.objectContaining({
                            create: expect.objectContaining({
                                attachments: expect.objectContaining({
                                    files: [
                                        expect.objectContaining({
                                            name: 'screenshot.png',
                                            contentType: 'image/png',
                                            size: 12345,
                                        }),
                                    ],
                                }),
                            }),
                        }),
                    }),
                }),
            );
        });

        it('rejects invalid JSON', async () => {
            const req = new Request('http://localhost:3000/api/webhooks/postmark', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: 'not-json',
            });

            const res = await POST(req);
            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toBe('Invalid JSON');
        });

        it('rejects payload missing From', async () => {
            const res = await POST(postmarkRequest({ Subject: 'Test', From: '' }));
            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toBe('Missing required fields');
        });

        it('rejects payload missing Subject', async () => {
            const res = await POST(
                postmarkRequest({ From: 'alice@test.com', Subject: '' }),
            );
            expect(res.status).toBe(400);
        });

        it('rejects a new-email payload without the MessageID required for idempotency', async () => {
            const res = await POST(
                postmarkRequest(fullPayload({ MessageID: '' })),
            );

            expect(res.status).toBe(400);
            expect(mockTransaction).not.toHaveBeenCalled();
        });

        it('returns 500 on database error', async () => {
            mockTicketCreate.mockRejectedValue(new Error('DB connection failed'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            const res = await POST(postmarkRequest(fullPayload()));
            expect(res.status).toBe(500);

            const body = await res.json();
            expect(body.error).toContain('Internal error');

            consoleSpy.mockRestore();
        });
    });
});
