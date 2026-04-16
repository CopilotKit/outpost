import { describe, it, expect, afterEach } from 'vitest';
import { startHealthServer } from '../health.js';
import type { Server } from 'node:http';

let server: Server;

afterEach(() => {
    if (server) {
        server.close();
    }
});

describe('startHealthServer', () => {
    it('responds with 200 on /health', async () => {
        server = startHealthServer(0); // port 0 = random available port
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Server did not bind');
        }

        const res = await fetch(`http://localhost:${address.port}/health`);
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body).toEqual(
            expect.objectContaining({
                status: 'ok',
                service: 'slack-bot',
            }),
        );
        expect(typeof body.uptime).toBe('number');
    });

    it('responds with 404 on unknown paths', async () => {
        server = startHealthServer(0);
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Server did not bind');
        }

        const res = await fetch(`http://localhost:${address.port}/unknown`);
        expect(res.status).toBe(404);
    });
});
