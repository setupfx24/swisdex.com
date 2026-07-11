'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import AdminSidebar from './AdminSidebar';
import { useAuthStore } from '@/stores/authStore';
import { User, LogOut, Loader2 } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import AdminNotificationBell from '@/components/notifications/AdminNotificationBell';
import { useAuthRehydrated } from '@/hooks/useAuthRehydrated';

type Gate = 'boot' | 'ready' | 'redirect';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const admin = useAuthStore((s) => s.admin);
  const authRehydrated = useAuthRehydrated();
  const [mounted, setMounted] = useState(false);
  const [gate, setGate] = useState<Gate>('boot');
  const runId = useRef(0);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || !authRehydrated) {
      setGate('boot');
      return;
    }

    const id = ++runId.current;

    const finish = (next: Gate) => {
      if (runId.current !== id) return;
      setGate(next);
    };

    const run = async () => {
      // Cookie-only: probe /auth/me to see whether the swisdex_admin
      // cookie still grants access. No client-side token to inspect.
      if (useAuthStore.getState().admin) {
        finish('ready');
        return;
      }

      const ok = await Promise.race([
        useAuthStore.getState().refreshAdminProfile(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15000)),
      ]);

      if (runId.current !== id) return;

      if (!ok) {
        finish('redirect');
        router.replace('/login');
        return;
      }
      finish('ready');
    };

    void run();

    return () => {
      runId.current += 1;
    };
  }, [mounted, authRehydrated, admin, router]);

  if (!mounted || !authRehydrated || gate !== 'ready') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg-primary">
        <Loader2 size={24} className="animate-spin text-text-tertiary" />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-page">
      <AdminSidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar — glass effect */}
        <div className="flex items-center h-14 px-5 glass border-b border-border-primary/30">
          <div className="ml-auto flex items-center gap-3">
            <AdminNotificationBell />
            <ThemeToggle />
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-bg-primary/40 border border-border-primary/30">
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-accent/60 to-accent/20 flex items-center justify-center">
                <User size={12} className="text-white" />
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-semibold text-text-primary leading-tight">{admin?.full_name || 'Admin'}</span>
                <span className="text-[9px] text-accent font-medium leading-tight">{admin?.role || 'admin'}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => useAuthStore.getState().logout()}
              className="flex items-center gap-1.5 px-2.5 py-2 text-xs text-text-tertiary hover:text-sell transition-fast rounded-lg hover:bg-sell/10"
              title="Logout"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
        {/* Content area with page animation */}
        <div className="flex-1 min-w-0 overflow-auto animate-page-in">{children}</div>
      </div>
    </div>
  );
}
