import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    output: 'standalone',
    transpilePackages: ['@copilotkit/outpost'],
    async headers() {
        return [
            {
                source: '/(.*)',
                headers: [
                    { key: 'X-Content-Type-Options', value: 'nosniff' },
                    { key: 'X-Frame-Options', value: 'DENY' },
                    {
                        key: 'Strict-Transport-Security',
                        value: 'max-age=31536000; includeSubDomains',
                    },
                    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
                    { key: 'X-XSS-Protection', value: '1; mode=block' },
                    {
                        key: 'Permissions-Policy',
                        value: 'camera=(), microphone=(), geolocation=()',
                    },
                ],
            },
        ];
    },
    webpack: (config, { isServer }) => {
        if (isServer) {
            // Platform SDK packages are only used by bot services, not the web app,
            // but get pulled in transitively via the queue/shared barrel exports.
            // Replace with empty modules so webpack doesn't try to require them.
            const nullPkgs = [
                'discord.js',
                '@discordjs/rest',
                '@discordjs/ws',
                '@discordjs/collection',
                'zlib-sync',
                'bufferutil',
                'utf-8-validate',
                '@slack/web-api',
                '@slack/bolt',
                // nodemailer stays nulled: it is not installed, and the SMTP transport
                // only matters for self-hosted setups. postmark is NOT here: sendEmail
                // (transpiled from @copilotkit/outpost) loads it in this server bundle,
                // and nulling it made every Postmark send fail (outpost#253).
                'nodemailer',
            ];
            for (const pkg of nullPkgs) {
                config.resolve.alias[pkg] = false;
            }
        }
        return config;
    },
};

export default nextConfig;
