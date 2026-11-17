'use client';

import { SessionProvider } from 'next-auth/react';
import { SidebarProvider } from '@/hooks/use-sidebar';
import { SessionGuard } from '@/components/session-guard';

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <SessionProvider>
            <SessionGuard />
            <SidebarProvider>{children}</SidebarProvider>
        </SessionProvider>
    );
}
