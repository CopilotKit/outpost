import { createServer, type Server } from 'node:http';

const startedAt = Date.now();

/**
 * Lightweight HTTP health-check server for the Slack bot.
 * Railway (and other orchestrators) hit this to know the worker is alive.
 */
export function startHealthServer(port: number = 3002): Server {
    const server = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    status: 'ok',
                    service: 'slack-bot',
                    uptime: Math.floor((Date.now() - startedAt) / 1000),
                }),
            );
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(port, () => {
        console.log(`[Slack Bot] Health check listening on port ${port}`);
    });

    return server;
}
