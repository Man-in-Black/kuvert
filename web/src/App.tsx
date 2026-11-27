import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import '@fontsource-variable/inter';
import type { UserSettings } from '@kuvert/shared';
import { ApiError, setUnauthorizedHandler } from '@/lib/api';
import { connectEvents, disconnectEvents, installCrossWindowSync, installQueryInvalidation } from '@/lib/events';
import { qk, useAppInfo, useSettings } from '@/lib/queries';
import { useApplyTheme } from '@/lib/theme';
import { ModulesProvider } from '@/modules/context';
import { AppShell } from '@/layout/AppShell';
import { StandaloneWindow, WINDOW_PREFIX } from '@/layout/StandaloneWindow';
import { LoginPage } from '@/pages/Login';
import { ForcedPasswordPage, ForcedTwoFactorPage } from '@/pages/ForcedSteps';
import { BrandMark } from '@/pages/AuthLayout';

/** Gastseite für Einladungslinks (/join/<token>) – erst bei Bedarf laden */
const GuestJoinPage = lazy(() => import('@/features/meet/JoinPages'));
const joinToken = (pathname: string) => pathname.match(/^\/join\/([\w-]{16,64})\/?$/)?.[1] ?? null;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

const THEME_KEY = 'kuvert.theme';

function storedTheme(): UserSettings['theme'] {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthGate />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

/** Theme für Seiten ohne Anmeldung (zuletzt verwendetes Theme des Benutzers) */
function PublicTheme() {
  useApplyTheme(storedTheme(), 'comfortable');
  return null;
}

function AuthGate() {
  const qc = useQueryClient();
  const location = useLocation();
  const { data: app, isLoading, error } = useAppInfo();

  useEffect(() => {
    setUnauthorizedHandler(() => qc.invalidateQueries({ queryKey: qk.app }));
  }, [qc]);

  if (isLoading) {
    return (
      <>
        <PublicTheme />
        <div className="flex h-full flex-col items-center justify-center gap-4">
          <BrandMark className="h-12 w-12 animate-pulse" />
        </div>
      </>
    );
  }
  if (error || !app) {
    return (
      <>
        <PublicTheme />
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <BrandMark className="h-10 w-10 opacity-60" />
          <div className="font-medium">Server nicht erreichbar</div>
          <button className="text-sm text-primary hover:underline" onClick={() => qc.invalidateQueries({ queryKey: qk.app })}>
            Erneut versuchen
          </button>
        </div>
      </>
    );
  }
  // Einladungslink ohne Anmeldung: als Gast beitreten (Anmelden ist dort auch möglich)
  const guestToken = !app.setupRequired && !app.user ? joinToken(location.pathname) : null;
  if (guestToken) {
    return (
      <>
        <PublicTheme />
        <Suspense fallback={null}>
          <GuestJoinPage token={guestToken} />
        </Suspense>
      </>
    );
  }
  if (app.setupRequired || !app.user) {
    return (
      <>
        <PublicTheme />
        <LoginPage setup={app.setupRequired} allowRegistration={app.allowRegistration} />
      </>
    );
  }
  if (app.user.mustChangePassword) {
    return (
      <>
        <PublicTheme />
        <ForcedPasswordPage />
      </>
    );
  }
  if (app.user.mustSetup2fa) {
    return (
      <>
        <PublicTheme />
        <ForcedTwoFactorPage />
      </>
    );
  }
  return <LoggedIn />;
}

function LoggedIn() {
  const qc = useQueryClient();
  const { settings } = useSettings();
  useApplyTheme(settings.theme, settings.density);
  // Eigenständige Fenster (z. B. Verfassen-Popup): ohne Navigation und Live-Ereignisse
  const standalone = useLocation().pathname.startsWith(WINDOW_PREFIX);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, settings.theme);
    } catch {
      /* egal */
    }
  }, [settings.theme]);

  // Änderungen aus anderen Fenstern (z. B. Lesefenster) übernehmen – auch in eigenständigen Fenstern
  useEffect(() => installCrossWindowSync(qc), [qc]);

  useEffect(() => {
    if (standalone) return;
    connectEvents();
    const off = installQueryInvalidation(qc);
    return () => {
      off();
      disconnectEvents();
    };
  }, [qc, standalone]);

  return (
    <ModulesProvider>
      {standalone ? <StandaloneWindow /> : <AppShell />}
      <Toaster
        richColors
        closeButton
        position="bottom-right"
        theme={settings.theme === 'system' ? 'system' : settings.theme}
        toastOptions={{ className: 'rounded-xl! shadow-pop! font-sans!' }}
      />
    </ModulesProvider>
  );
}
