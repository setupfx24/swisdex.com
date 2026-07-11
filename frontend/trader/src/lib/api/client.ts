const DEFAULT_SERVER_API = 'http://127.0.0.1:8000/api/v1';

/** Base URL for REST calls.
 *  Browser: direct to gateway (NEXT_PUBLIC_GATEWAY_URL) if set, otherwise same-origin proxy.
 *  Server:  INTERNAL_API_URL (Docker hostname) → NEXT_PUBLIC_API_URL → fallback localhost.
 */
export function getApiBase(): string {
  if (typeof window !== 'undefined') {
    // Direct gateway call (fast — skips Next.js proxy hop).
    // Set NEXT_PUBLIC_GATEWAY_URL in .env.local for local dev,
    // or leave unset in production (falls back to same-origin proxy for HTTPS).
    const direct = process.env.NEXT_PUBLIC_GATEWAY_URL;
    if (direct) return `${direct.replace(/\/$/, '')}/api/v1`;
    return '/api/v1';
  }
  return (
    process.env.INTERNAL_API_URL?.trim()?.replace(/\/$/, '') ||
    process.env.NEXT_PUBLIC_API_URL?.trim()?.replace(/\/$/, '') ||
    DEFAULT_SERVER_API
  );
}

/** Default client timeout (avoid endless spinners if API is down). */
const REQUEST_TIMEOUT_MS = 60_000;

export class ApiRequestCancelledError extends Error {
  constructor() {
    super('Request cancelled');
    this.name = 'ApiRequestCancelledError';
  }
}

export type ApiRequestOptions = { timeoutMs?: number; signal?: AbortSignal };

class ApiClient {
  /** In-memory Bearer override (rare; cookies are primary for the trader web app). */
  private token: string | null = null;

  setToken(token: string) {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  clearToken() {
    this.token = null;
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem('token');
        localStorage.removeItem('swisdex-auth');
      } catch {
        /* ignore */
      }
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
    options?: ApiRequestOptions,
    _retry429: number = 0,
  ): Promise<T> {
    const API_BASE = getApiBase();
    let url: string;
    if (API_BASE.startsWith('http')) {
      const base = new URL(API_BASE);
      base.pathname = base.pathname.replace(/\/$/, '') + path;
      if (params) {
        Object.entries(params).forEach(([k, v]) => base.searchParams.set(k, v));
      }
      url = base.toString();
    } else {
      const u = new URL(`${API_BASE}${path}`, window.location.origin);
      if (params) {
        Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
      }
      url = u.toString();
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    let externalAbort = false;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const ext = options?.signal;
    const onExternalAbort = () => {
      externalAbort = true;
      clearTimeout(timer);
      controller.abort();
    };
    if (ext) {
      if (ext.aborted) {
        clearTimeout(timer);
        throw new ApiRequestCancelledError();
      }
      ext.addEventListener('abort', onExternalAbort);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        credentials: 'include',
      });
    } catch (e: unknown) {
      if (ext) ext.removeEventListener('abort', onExternalAbort);
      clearTimeout(timer);
      if (externalAbort) throw new ApiRequestCancelledError();
      const aborted = e instanceof Error && e.name === 'AbortError';
      throw new Error(
        aborted
          ? 'Request timed out — start the API gateway (port 8000): docker compose up -d'
          : e instanceof Error
            ? e.message === 'Failed to fetch'
              ? 'Cannot reach API — start gateway on port 8000, then refresh.'
              : e.message
            : 'Network error',
      );
    }
    if (ext) ext.removeEventListener('abort', onExternalAbort);
    clearTimeout(timer);

    // Retry on 429 with exponential backoff (max 3 attempts) so transient
    // rate-limit bursts don't kill the page.
    if (res.status === 429 && _retry429 < 3 && method.toUpperCase() === 'GET') {
      const retryAfterHdr = res.headers.get('Retry-After');
      const retryAfterSec = retryAfterHdr ? parseFloat(retryAfterHdr) : NaN;
      const delay = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(5000, retryAfterSec * 1000)
        : Math.min(4000, 400 * Math.pow(2, _retry429));
      await new Promise((r) => setTimeout(r, delay));
      return this.request<T>(method, path, body, params, options, _retry429 + 1);
    }

    if (res.status === 401) {
      this.clearToken();
      const error = await res.json().catch(() => ({}));
      const detail = (error as { detail?: unknown }).detail;
      const msg =
        typeof detail === 'string'
          ? detail
          : Array.isArray(detail)
            ? detail.map((d: { msg?: string }) => d.msg || JSON.stringify(d)).join(', ')
            : 'Session expired or invalid. Please sign in again.';
      const err = new Error(msg);
      (err as any).status = 401;
      throw err;
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({ detail: 'Request failed' }));
      const detail = error.detail;
      // detail can be a plain string, a FastAPI validation array, or a
      // structured object like {code: "email_unverified", message: "Please
      // confirm your email…"} — surface the object's message instead of a
      // bare "HTTP 403", and keep the code on the error for callers.
      const structured =
        detail && typeof detail === 'object' && !Array.isArray(detail)
          ? (detail as { code?: string; message?: string })
          : null;
      const msg =
        typeof detail === 'string'
          ? detail
          : Array.isArray(detail)
            ? detail.map((d: { msg?: string }) => d.msg || JSON.stringify(d)).join(', ')
            : structured?.message || `HTTP ${res.status}`;
      const err = new Error(msg || `HTTP ${res.status}`);
      (err as any).status = res.status;
      if (structured?.code) (err as any).code = structured.code;
      throw err;
    }

    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text);
  }

  get<T>(path: string, params?: Record<string, string>, options?: ApiRequestOptions) {
    return this.request<T>('GET', path, undefined, params, options);
  }

  post<T>(path: string, body?: unknown, options?: ApiRequestOptions) {
    return this.request<T>('POST', path, body, undefined, options);
  }

  put<T>(path: string, body?: unknown, options?: ApiRequestOptions) {
    return this.request<T>('PUT', path, body, undefined, options);
  }

  patch<T>(path: string, body?: unknown, options?: ApiRequestOptions) {
    return this.request<T>('PATCH', path, body, undefined, options);
  }

  delete<T>(path: string, options?: ApiRequestOptions) {
    return this.request<T>('DELETE', path, undefined, undefined, options);
  }
}

export const api = new ApiClient();
export default api;
