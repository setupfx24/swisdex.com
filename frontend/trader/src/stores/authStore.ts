'use client';

import { create } from 'zustand';
import api from '@/lib/api/client';
import { useNotificationStore } from '@/stores/notificationStore';

interface User {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  phone?: string | null;
  country?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  date_of_birth?: string | null;
  role: string;
  status: string;
  kyc_status: string;
  is_demo?: boolean;
  two_factor_enabled: boolean;
  theme: string;
  /** True when first_name, last_name, phone, country, and DOB are all set.
   * The ProfileCompleteGate modal blocks the app until this flips true. */
  profile_complete?: boolean;
  /** Linked SIWE wallet (lowercase 0x). Drives the LinkedWalletCard UI. */
  wallet_address?: string | null;
  /** Whether the user has each non-wallet sign-in method available. Used
   * to disable Unlink when wallet is the only credential. */
  has_password?: boolean;
  has_google?: boolean;
}

export interface WalletNonceResponse {
  nonce: string;
  issued_at: string;
  expires_at: string;
  domain: string;
  statement: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isInitialized: boolean;
  login: (email: string, password: string, totpCode?: string) => Promise<void>;
  demoLogin: () => Promise<void>;
  googleLogin: (idToken: string, referralCode?: string) => Promise<void>;
  forgotPassword: (email: string) => Promise<void>;
  register: (data: {
    email: string;
    password: string;
    first_name: string;
    last_name: string;
    phone?: string;
    referral_code?: string;
    /** Cloudflare Turnstile token — verified server-side. */
    cf_turnstile_token?: string;
  }) => Promise<void>;
  logout: () => void;
  loadUser: () => Promise<void>;
  refreshUser: () => Promise<void>;
  walletNonce: (
    address: string, chainId: number, scope?: 'login' | 'link',
  ) => Promise<WalletNonceResponse>;
  walletLogin: (
    message: string, signature: string, referralCode?: string,
  ) => Promise<void>;
  setInitialized: (val: boolean) => void;
}

/** Session is HttpOnly cookies + optional refresh; Zustand holds UI state only (no secrets). */
export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  token: null,
  isAuthenticated: false,
  isLoading: false,
  isInitialized: false,

  login: async (email, password, totpCode) => {
    set({ isLoading: true });
    try {
      await api.post<{ access_token: string; user_id: string; role: string }>('/auth/login', {
        email,
        password,
        totp_code: totpCode,
      });
      const user = await api.get<User>('/auth/me');
      set({ user, isAuthenticated: true, isLoading: false, token: null });
    } catch (e) {
      set({ isLoading: false });
      throw e;
    }
  },

  demoLogin: async () => {
    set({ isLoading: true });
    try {
      await api.post<{ access_token: string; user_id: string; role: string }>('/auth/demo-login', {});
      const user = await api.get<User>('/auth/me');
      set({ user, isAuthenticated: true, isLoading: false, token: null });
    } catch (e) {
      set({ isLoading: false });
      throw e;
    }
  },

  googleLogin: async (idToken, referralCode) => {
    set({ isLoading: true });
    try {
      await api.post<{ access_token: string; user_id: string; role: string }>('/auth/google', {
        id_token: idToken,
        referral_code: referralCode,
      });
      const user = await api.get<User>('/auth/me');
      set({ user, isAuthenticated: true, isLoading: false, token: null });
    } catch (e) {
      set({ isLoading: false });
      throw e;
    }
  },

  forgotPassword: async (email) => {
    await api.post<{ message: string }>('/auth/forgot-password', { email });
  },

  register: async (data) => {
    set({ isLoading: true });
    try {
      // Register no longer issues session cookies — the user must click the
      // verify link in their inbox to log in. Don't fetch /auth/me here
      // (would 401) and leave the store unauthenticated; the page handler
      // redirects to /auth/check-email after this resolves.
      await api.post<{ email: string; verification_sent: boolean }>('/auth/register', data);
      set({ isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      throw e;
    }
  },

  logout: () => {
    void (async () => {
      try {
        await api.post('/auth/logout', {});
      } catch {
        /* ignore — still clear client */
      }
      api.clearToken();
      useNotificationStore.getState().reset();
      // Reset the once-per-session KYC nudge so it pops again on the NEXT
      // login if the user still hasn't completed KYC (client 2026-06-23:
      // "tab tab aana chahiye" — every login until KYC is done).
      if (typeof window !== 'undefined') sessionStorage.removeItem('kyc_prompt_shown');
      set({ user: null, token: null, isAuthenticated: false });
    })();
  },

  loadUser: async () => {
    // Try /auth/me first; if 401, refresh token and retry once
    const fetchMe = () => api.get<User>('/auth/me');
    try {
      const user = await fetchMe();
      set({ user, isAuthenticated: true, isInitialized: true, token: null });
    } catch (e: any) {
      // Only try refresh if it was an auth error (401)
      const status = e?.status ?? e?.response?.status;
      if (status === 401 || status === 403) {
        try {
          await api.post('/auth/refresh', {});
          const user = await fetchMe();
          set({ user, isAuthenticated: true, isInitialized: true, token: null });
          return;
        } catch { /* fall through */ }
      }
      set({ user: null, isAuthenticated: false, isInitialized: true, token: null });
      api.clearToken();
    }
  },

  refreshUser: async () => {
    try {
      const user = await api.get<User>('/auth/me');
      set({ user, isAuthenticated: true });
    } catch {
      /* swallow — leave existing state untouched */
    }
  },

  walletNonce: async (address, chainId, scope = 'login') => {
    const path = scope === 'link' ? '/profile/wallet/link/nonce' : '/auth/wallet/nonce';
    return api.post<WalletNonceResponse>(path, { address, chain_id: chainId });
  },

  walletLogin: async (message, signature, referralCode) => {
    set({ isLoading: true });
    try {
      await api.post('/auth/wallet/verify', {
        message, signature, referral_code: referralCode,
      });
      const user = await api.get<User>('/auth/me');
      set({ user, isAuthenticated: true, isLoading: false, token: null });
    } catch (e) {
      set({ isLoading: false });
      throw e;
    }
  },

  setInitialized: (val) => set({ isInitialized: val }),
}));
