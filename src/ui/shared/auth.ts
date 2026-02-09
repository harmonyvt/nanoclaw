import { useState, useEffect } from 'preact/hooks';
import { setAuthToken } from './api.js';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        ready(): void;
        expand(): void;
        setHeaderColor?(color: string): void;
        setBackgroundColor?(color: string): void;
      };
    };
  }
}

interface AuthState {
  authenticated: boolean;
  loading: boolean;
  token: string | null;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    authenticated: false,
    loading: true,
    token: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function authenticate() {
      // 1. Try Telegram WebApp
      const tg = window.Telegram?.WebApp;
      if (tg?.initData) {
        tg.ready();
        tg.expand();
        try {
          tg.setHeaderColor?.('#0b1219');
          tg.setBackgroundColor?.('#0b1219');
        } catch {
          // Not all Telegram clients support these methods
        }

        try {
          const res = await fetch(
            `/api/auth?initData=${encodeURIComponent(tg.initData)}`,
            { method: 'POST' },
          );
          if (res.ok) {
            const data = (await res.json()) as { token: string };
            if (!cancelled) {
              setAuthToken(data.token);
              setState({ authenticated: true, loading: false, token: data.token });
            }
            return;
          }
        } catch {
          // Fall through to URL param check
        }
      }

      // 2. Fallback: check URL search params for ?session=TOKEN or ?token=TOKEN
      const params = new URLSearchParams(window.location.search);
      const urlToken = params.get('session') || params.get('token');
      if (urlToken) {
        if (!cancelled) {
          setAuthToken(urlToken);
          setState({ authenticated: true, loading: false, token: urlToken });
        }
        return;
      }

      // 3. No auth available
      if (!cancelled) {
        setState({ authenticated: false, loading: false, token: null });
      }
    }

    authenticate();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
