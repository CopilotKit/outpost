'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
    LayoutDashboard,
    Building2,
    Ticket,
    FileText,
    Bot,
    Megaphone,
    Mail,
    MessageSquare,
    Settings,
    HelpCircle,
    Mountain,
    ChevronLeft,
    ChevronRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { UserMenu } from '@/components/user-menu';
import { useSidebar } from '@/hooks/use-sidebar';

interface NavItem {
    name: string;
    href: string;
    icon: LucideIcon;
    badge?: string;
}

const navItems: NavItem[] = [
    { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    { name: 'Accounts', href: '/accounts', icon: Building2 },
    { name: 'Tickets', href: '/tickets', icon: Ticket },
    { name: 'Docs', href: '/docs', icon: FileText },
    { name: 'Agents', href: '/agents', icon: Bot },
    { name: 'Messages', href: '/messaging', icon: Mail, badge: 'New' },
    { name: 'Broadcasts', href: '/broadcasts', icon: Megaphone },
    { name: 'Ask AI', href: '/qa', icon: MessageSquare, badge: 'Beta' },
];

const bottomItems: NavItem[] = [
    { name: 'Settings', href: '/settings', icon: Settings },
    { name: 'Help', href: '/help', icon: HelpCircle },
];

export function Sidebar() {
    const pathname = usePathname();
    const { collapsed, toggle } = useSidebar();

    return (
        <aside
            data-testid="sidebar"
            className={cn(
                'hidden md:flex flex-col border-r border-sidebar-border bg-sidebar transition-all duration-200',
                collapsed ? 'w-sidebar-collapsed' : 'w-sidebar'
            )}
        >
            {/* Logo */}
            <div className="flex h-14 items-center border-b border-sidebar-border px-4">
                <Mountain className="h-6 w-6 shrink-0 text-primary" />
                {!collapsed && (
                    <span className="ml-3 text-lg font-bold text-foreground">
                        Outpost
                    </span>
                )}
            </div>

            {/* Main nav */}
            <nav className="flex-1 space-y-1 p-2">
                {navItems.map((item) => {
                    const isActive = pathname.startsWith(item.href);
                    const Icon = item.icon;
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            title={collapsed ? item.name : undefined}
                            className={cn(
                                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                                collapsed && 'justify-center px-0',
                                isActive
                                    ? 'bg-sidebar-active text-sidebar-active-foreground font-semibold'
                                    : 'text-sidebar-foreground hover:bg-sidebar-hover'
                            )}
                        >
                            <Icon className="h-5 w-5 shrink-0" />
                            {!collapsed && (
                                <span className="flex items-center gap-2">
                                    {item.name}
                                    {item.badge && (
                                        <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                            {item.badge}
                                        </span>
                                    )}
                                </span>
                            )}
                        </Link>
                    );
                })}
            </nav>

            {/* Bottom section */}
            <div className="border-t border-sidebar-border p-2">
                {bottomItems.map((item) => {
                    const Icon = item.icon;
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            title={collapsed ? item.name : undefined}
                            className={cn(
                                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-hover transition-colors',
                                collapsed && 'justify-center px-0'
                            )}
                        >
                            <Icon className="h-5 w-5 shrink-0" />
                            {!collapsed && <span>{item.name}</span>}
                        </Link>
                    );
                })}

                <UserMenu collapsed={collapsed} />

                {/* Toggle button */}
                <button
                    onClick={toggle}
                    data-testid="sidebar-toggle"
                    className={cn(
                        'mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-hover transition-colors',
                        collapsed && 'justify-center px-0'
                    )}
                >
                    {collapsed ? (
                        <ChevronRight className="h-5 w-5 shrink-0" />
                    ) : (
                        <>
                            <ChevronLeft className="h-5 w-5 shrink-0" />
                            <span>Collapse</span>
                        </>
                    )}
                </button>
            </div>
        </aside>
    );
}

/** Mobile bottom navigation bar */
export function MobileNav() {
    const pathname = usePathname();

    return (
        <nav
            data-testid="mobile-nav"
            className="fixed inset-x-0 bottom-0 z-50 flex md:hidden border-t border-sidebar-border bg-sidebar"
        >
            {navItems.map((item) => {
                const isActive = pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                    <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                            'flex flex-1 flex-col items-center gap-1 py-2 text-[10px]',
                            isActive
                                ? 'text-sidebar-active-foreground font-semibold'
                                : 'text-sidebar-foreground'
                        )}
                    >
                        <Icon className="h-5 w-5" />
                        <span>{item.name}</span>
                    </Link>
                );
            })}
        </nav>
    );
}
