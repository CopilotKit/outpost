import { execFileSync } from 'node:child_process';
import { composeArgs } from './support';

export default async function globalTeardown(): Promise<void> {
    if (process.env.E2E_KEEP === '1') return;
    execFileSync('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], {
        stdio: 'inherit',
    });
}
