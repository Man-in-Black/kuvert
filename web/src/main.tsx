import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { registerServiceWorker } from './features/notifications/push';
import { captureMailtoLaunch } from './features/mail/mailto';
import './styles.css';

// Aufruf als Programm für E-Mail-Links (/mail?mailto=…): vor dem Router übernehmen
captureMailtoLaunch();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary fullPage>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Service Worker früh registrieren: nötig für Benachrichtigungen auf Android (kein Notification-Konstruktor)
// und für die Installation als App. Er cacht nichts, sondern behandelt nur Push und Benachrichtigungsklicks.
void registerServiceWorker().catch(() => {
  /* z. B. kein HTTPS */
});
