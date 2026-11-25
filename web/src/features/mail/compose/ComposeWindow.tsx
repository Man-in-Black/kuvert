/**
 * Eigenes Browserfenster zum Verfassen (/window/compose?id=…).
 * Übernimmt die Startdaten vom Hauptfenster und schließt sich, sobald die
 * Nachricht gesendet, verworfen oder als Entwurf geschlossen wurde.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { PenLine, Send } from 'lucide-react';
import { Button } from '@/components/ui';
import { Composer } from './Composer';
import { lingerMs } from './send';
import { getComposers, openComposer, useComposers } from './store';
import { readWindowInit, rememberWindowGeometry } from './window';

export function ComposeWindowPage() {
  const composers = useComposers();
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'closed'>('loading');

  useEffect(() => {
    // StrictMode ruft Effekte doppelt auf – nur einmal übernehmen
    if (getComposers().length) return setState('ready');
    const init = readWindowInit();
    if (!init) return setState('missing');
    openComposer(init);
    setState('ready');
  }, []);

  // Größe und Position für das nächste Popup merken
  useEffect(() => {
    let t: number | undefined;
    const onResize = () => {
      window.clearTimeout(t);
      t = window.setTimeout(rememberWindowGeometry, 300);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('pagehide', rememberWindowGeometry);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pagehide', rememberWindowGeometry);
    };
  }, []);

  // Alles erledigt → Fenster schließen (bei eigenem „Rückgängig“-Toast erst danach)
  useEffect(() => {
    if (state !== 'ready' || composers.length) return;
    const t = window.setTimeout(() => {
      window.close();
      setState('closed');
    }, lingerMs());
    return () => window.clearTimeout(t);
  }, [state, composers.length]);

  const active = composers[composers.length - 1];
  if (active)
    return (
      <>
        {composers.map((c) => (
          <Composer key={c.key} entry={{ ...c, minimized: c.key !== active.key }} variant="window" />
        ))}
      </>
    );

  if (state === 'loading') return null;

  if (state === 'missing')
    return (
      <Notice icon={<PenLine />} title="Nachricht konnte nicht geladen werden">
        Das Fenster wurde nicht aus Kuvert heraus geöffnet oder das Hauptfenster ist nicht mehr verfügbar.
      </Notice>
    );

  return (
    <Notice icon={<Send />} title={state === 'closed' ? 'Erledigt' : 'Nachricht wird gesendet …'}>
      {state === 'closed' ? 'Dieses Fenster kann geschlossen werden.' : 'Dieses Fenster schließt sich automatisch.'}
    </Notice>
  );
}

function Notice({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-soft text-primary [&_svg]:h-6 [&_svg]:w-6">{icon}</div>
      <div className="text-sm font-semibold">{title}</div>
      <p className="max-w-sm text-sm text-muted">{children}</p>
      <div className="flex gap-2">
        <Button onClick={() => window.close()}>Fenster schließen</Button>
        <Button variant="ghost" onClick={() => window.location.assign('/')}>
          Kuvert öffnen
        </Button>
      </div>
    </div>
  );
}
