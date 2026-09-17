import { afterEach, describe, expect, it, vi } from 'vitest';
import { PathfinderClient } from './pathfinder.js';

function mockServer(result: unknown) {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: {} }), {
            headers: { 'mcp-session-id': 'test-session' },
        }),
    );
    fetchMock.mockResolvedValueOnce(new Response(''));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result })));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('agent evidence retrieval', () => {
    it('sends the version filter to the actual MCP tool', async () => {
        const fetchMock = mockServer({ content: [{ type: 'text', text: '[]' }] });
        const client = new PathfinderClient('https://mcp.example.test');
        await client.searchEvidence('search-code', { query: 'subagents', version: 'v2' });
        expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
            params: { name: 'search-code', arguments: { query: 'subagents', version: 'v2' } },
        });
    });

    it('recognizes Pathfinder explicit no_results envelopes', async () => {
        mockServer({
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({ results: [], reason: 'no_results', domain: 'docs' }),
                },
            ],
        });
        await expect(
            new PathfinderClient('https://mcp.example.test').searchEvidence('search-docs', {
                query: 'tools',
            }),
        ).resolves.toEqual([]);
    });

    it('distinguishes an MCP tool error from no results', async () => {
        mockServer({ isError: true, content: [{ type: 'text', text: 'Index unavailable' }] });
        const client = new PathfinderClient('https://mcp.example.test');
        await expect(client.searchEvidence('search-docs', { query: 'tools' })).rejects.toThrow(
            'search-docs',
        );
    });

    it.each([{}, { content: [{ type: 'text', text: 'unparseable upstream output' }] }])(
        'rejects malformed evidence payloads instead of returning no results',
        async (payload) => {
            mockServer(payload);
            await expect(
                new PathfinderClient('https://mcp.example.test').searchEvidence('search-docs', {
                    query: 'tools',
                }),
            ).rejects.toThrow('malformed');
        },
    );

    it('stops connection setup when cancellation happens during initialize', async () => {
        const controller = new AbortController();
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockImplementationOnce(async () => {
                controller.abort(new Error('Run cancelled during initialize'));
                return new Response(JSON.stringify({ result: {} }), {
                    headers: { 'mcp-session-id': 'session' },
                });
            })
            .mockResolvedValue(new Response(''));
        vi.stubGlobal('fetch', fetchMock);
        const client = new PathfinderClient('https://mcp.example.test');
        await expect(
            client.searchEvidence('search-docs', { query: 'tools' }, controller.signal),
        ).rejects.toThrow('Run cancelled during initialize');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    });

    it('rejects a cancelled run before starting another network request', async () => {
        const fetchMock = mockServer({ content: [] });
        const client = new PathfinderClient('https://mcp.example.test');
        const controller = new AbortController();
        controller.abort(new Error('Run cancelled'));
        await expect(
            client.searchEvidence('search-docs', { query: 'tools' }, controller.signal),
        ).rejects.toThrow('Run cancelled');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
