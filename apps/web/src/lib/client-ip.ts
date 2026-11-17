/**
 * The client IP for rate-limit keys. Railway's edge sets X-Real-IP to the remote
 * address and outpost.copilotkit.ai has no CDN in front (spec §3). X-Forwarded-For is
 * deliberately not read: Railway does not document its positions. Missing header
 * (local dev) shares one 'unknown' bucket, which fails closed.
 */
export function clientIp(request: Request): string {
    return request.headers.get('x-real-ip')?.trim() || 'unknown';
}
