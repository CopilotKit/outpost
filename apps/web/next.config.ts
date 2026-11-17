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
            {
                // Defense in depth for the reset page: the token is in the fragment, which
                // never reaches Referer, but nothing on this page should leak a referrer.
                // Must come AFTER the global entry: for the same header key, the later
                // matching entry wins. No Cache-Control here: Next overwrites it for pages.
                source: '/reset-password',
                headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
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
                // postmark and nodemailer are NOT here: sendEmail (transpiled from
                // @copilotkit/outpost) loads them in this server bundle. Nulling postmark
                // made every Postmark send fail (outpost#253); nulling nodemailer made every
                // SMTP send fail (outpost#206). nodemailer is a dependency of @copilotkit/outpost.
            ];
            for (const pkg of nullPkgs) {
                config.resolve.alias[pkg] = false;
            }
        }
        return config;
    },
};

export default nextConfig;
