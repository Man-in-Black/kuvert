/**
 * Dienst-Komponente (immer gerendert): zeigt offene Verfassen-Fenster,
 * reagiert auf openCompose()-Aufrufe und Versand-Ereignisse vom Server
 * und stellt die Schnittstelle für Verfassen-Popups bereit.
 */
import { lazy, Suspense, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Maximize2, PenLine } from 'lucide-react';
import type { SendResult } from '@kuvert/shared';
import { useServerEvent } from '@/lib/events';
import { useSettings } from '@/lib/queries';
import { useIsMobile } from '@/lib/useIsMobile';
import { onComposeRequest, type ComposeInit } from '../compose-api';
import { mailtoFromClick, onMailtoLaunch, takePendingMailto } from '../mailto';
import { mailKeys } from '../api';
import { announceSend, pendingJobs, retryJob } from './send';
import { openComposer, setComposerMinimized, setComposerPreference, useComposerRect, useComposers, type ComposerAttachment } from './store';
import { takePendingInit } from './window';

const Composer = lazy(() => import('./Composer').then((m) => ({ default: m.Composer })));

let k = 0;

function composerFromInit(init: ComposeInit, inline?: boolean) {
  openComposer(
    {
      mode: 'new',
      accountId: init.accountId,
      message: { to: init.to ?? [], cc: init.cc ?? [], bcc: init.bcc ?? [], subject: init.subject ?? '', html: init.html ?? '<p></p>' },
      attachments: (init.attachments ?? []).map<ComposerAttachment>((a) => ({ ...a, key: `ext${Date.now()}-${k++}` })),
    },
    { inline },
  );
}

export function ComposerHost() {
  const composers = useComposers();
  const rect = useComposerRect();
  const floating = !!rect && !useIsMobile();
  const qc = useQueryClient();
  const { settings } = useSettings();

  useEffect(() => setComposerPreference(settings.composeWindow), [settings.composeWindow]);

  // Schnittstelle für Verfassen-Popups (window.opener.kuvertCompose)
  useEffect(() => {
    window.kuvertCompose = {
      take: takePendingInit,
      announce: (json) => {
        const { accountId, subject, res } = JSON.parse(json) as { accountId: string; subject: string; res: SendResult };
        announceSend(accountId, subject, res);
        void qc.invalidateQueries({ queryKey: mailKeys.all });
      },
      mailChanged: () => void qc.invalidateQueries({ queryKey: mailKeys.lists }),
    };
    return () => {
      delete window.kuvertCompose;
    };
  }, [qc]);

  useEffect(() => onComposeRequest((init) => composerFromInit(init)), []);

  // mailto:-Links aus dem Browser/Betriebssystem (Protokoll-Handler). Ohne
  // Benutzeraktion würde ein Popup blockiert – daher immer im Hauptfenster.
  useEffect(() => {
    const pending = takePendingMailto();
    if (pending) composerFromInit(pending, true);
    onMailtoLaunch((init) => composerFromInit(init, true));
  }, []);

  // mailto:-Links in der Oberfläche (Chat, KI-Antworten, Kontakte …) in Kuvert verfassen.
  // Mail-Inhalte im iframe fängt MailFrame selbst ab.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const init = mailtoFromClick(e);
      if (!init) return;
      e.preventDefault();
      composerFromInit(init);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  useServerEvent('send.status', (e) => {
    const job = pendingJobs.get(e.jobId);
    if (e.status === 'sent') {
      if (job) toast.success(`„${job.subject}“ gesendet`);
      pendingJobs.delete(e.jobId);
      void qc.invalidateQueries({ queryKey: mailKeys.all });
    } else if (e.status === 'failed') {
      toast.error(`Versand fehlgeschlagen: ${e.subject ?? job?.subject ?? ''}`, {
        description: e.error ?? undefined,
        duration: 15_000,
        action: { label: 'Erneut versuchen', onClick: () => void retryJob(e.jobId) },
      });
      void qc.invalidateQueries({ queryKey: mailKeys.scheduled });
    }
  });

  const minimized = composers.filter((c) => c.minimized);
  const hasOpen = composers.some((c) => !c.minimized);

  return (
    <>
      {composers.length > 0 && (
        <Suspense fallback={null}>
          {composers.map((c) => (
            <Composer key={c.key} entry={c} />
          ))}
        </Suspense>
      )}
      {minimized.length > 0 && (
        <div
          className="fixed bottom-0 z-30 flex max-w-[calc(100vw-5rem)] flex-row-reverse gap-2 overflow-x-auto"
          style={{ right: hasOpen && !floating ? 'calc(min(720px, 100vw - 2rem) + 2rem)' : '1rem' }}
        >
          {minimized.map((c) => (
            <div
              key={c.key}
              className="flex w-60 shrink-0 cursor-pointer items-center gap-2 rounded-t-lg border border-b-0 border-border bg-surface-2 px-3 py-2 text-sm shadow-lg hover:bg-hover"
              onClick={() => setComposerMinimized(c.key, false)}
            >
              <PenLine className="h-4 w-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              <Maximize2 className="h-3.5 w-3.5 text-muted" />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

