'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '@/lib/api';

/**
 * Shared admin permission hook (client 2026-06-20). Several action surfaces
 * (deposits approve/reject, fixed-return grant, …) were showing buttons the
 * employee had no permission for, because only the sidebar/users page gated by
 * /auth/me. This centralises that check: `can(perm)` is true for super_admin
 * ('*') or when the permission is in the employee's resolved set.
 *
 * Note: permissions are resolved at login, so a freshly-changed grant takes
 * effect on the next page load / re-login.
 */
export function usePermissions() {
  const [perms, setPerms] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    adminApi
      .get<{ permissions?: string[] }>('/auth/me')
      .then((m) => { if (!cancelled) setPerms(m?.permissions || []); })
      .catch(() => { if (!cancelled) setPerms([]); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const can = (perm?: string) => !perm || perms.includes('*') || perms.includes(perm);
  return { can, perms, loaded };
}
