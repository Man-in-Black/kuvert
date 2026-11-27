/**
 * Gemeinsames Whiteboard im Anruf (Excalidraw). Zeichnet aus dem WhiteboardSync-Stand, schickt eigene
 * Änderungen und Mauszeiger an die anderen und kann die Zeichnung als Bild in den Chat stellen.
 * Wird erst geladen, wenn jemand das Whiteboard öffnet (Excalidraw ist groß).
 */
import { useEffect, useRef, useState } from 'react';
import { CaptureUpdateAction, Excalidraw, exportToBlob, reconcileElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, BinaryFiles, BinaryFileData, Collaborator, SocketId } from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import '@excalidraw/excalidraw/index.css';
import { toast } from 'sonner';
import { ImageUp, Loader2 } from 'lucide-react';
import { errorMessage, uploadFile } from '@/lib/api';
import { chatApi } from '@/features/chat/api';
import type { WbElement, WbFile, WhiteboardSync } from './whiteboard-sync';

// Schriften selbst ausliefern (siehe vite.config.ts) statt vom CDN laden
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}
window.EXCALIDRAW_ASSET_PATH = '/excalidraw/';

type RemoteElements = Parameters<typeof reconcileElements>[1];

const isDark = () => document.documentElement.classList.contains('dark');

export default function Whiteboard({ sync, conversationId, myName }: { sync: WhiteboardSync; conversationId: string | null; myName: string }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [exporting, setExporting] = useState(false);
  const [dark, setDark] = useState(isDark);
  const collaborators = useRef(new Map<SocketId, Collaborator>());
  // Vorhandener Stand als Startszene: excalidrawAPI meldet sich, bevor Excalidraw die Szene einrichtet –
  // ein updateScene direkt danach würde beim Einrichten wieder überschrieben
  const [initialData] = useState(() => ({
    elements: sync.sceneElements() as unknown as OrderedExcalidrawElement[],
    files: Object.fromEntries(sync.files) as unknown as BinaryFiles,
    scrollToContent: true,
  }));

  // Hell/Dunkel der App folgen
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(isDark()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  // Stand übernehmen, anderen Bescheid geben, Änderungen der anderen einspielen
  useEffect(() => {
    if (!api) return;
    // Was zwischen erstem Rendern und jetzt dazukam (den Stand davor bringt initialData mit)
    const files = [...sync.files.values()] as unknown as BinaryFileData[];
    if (files.length) api.addFiles(files);
    const current = reconcileElements(api.getSceneElementsIncludingDeleted(), sync.sceneElements() as unknown as RemoteElements, api.getAppState());
    api.updateScene({ elements: current, captureUpdate: CaptureUpdateAction.NEVER });
    sync.announceOpen(myName);

    const offScene = sync.onScene((els: WbElement[], newFiles: WbFile[]) => {
      if (newFiles.length) api.addFiles(newFiles as unknown as BinaryFileData[]);
      const merged = reconcileElements(api.getSceneElementsIncludingDeleted(), els as unknown as RemoteElements, api.getAppState());
      api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    });

    const offPointer = sync.onPointer((p) => {
      const id = p.identity as SocketId;
      if (Number.isNaN(p.x)) collaborators.current.delete(id);
      else collaborators.current.set(id, { username: p.name, pointer: { x: p.x, y: p.y, tool: 'pointer' }, button: p.button, id: p.identity });
      api.updateScene({ collaborators: new Map(collaborators.current) });
    });

    return () => {
      offScene();
      offPointer();
    };
  }, [api, sync, myName]);

  const sendToChat = async () => {
    if (!api || !conversationId) return;
    const elements = api.getSceneElements();
    if (!elements.length) {
      toast('Das Whiteboard ist noch leer.');
      return;
    }
    setExporting(true);
    try {
      const blob = await exportToBlob({
        elements,
        files: api.getFiles(),
        mimeType: 'image/png',
        appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false, viewBackgroundColor: '#ffffff' },
        exportPadding: 24,
      });
      const stamp = new Date().toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }).replace(/[/:]/g, '-');
      const up = await uploadFile(blob, `Whiteboard ${stamp}.png`);
      await chatApi.send(conversationId, '', { uploadIds: [up.id] });
      toast.success('Whiteboard als Bild in den Chat gestellt');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl bg-white" data-kuvert-whiteboard>
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        langCode="de-DE"
        theme={dark ? 'dark' : 'light'}
        isCollaborating
        onChange={(els, _state, files: BinaryFiles) => sync.local(els as unknown as WbElement[], files as unknown as Record<string, WbFile>)}
        onPointerUpdate={({ pointer, button }) => sync.pointer(pointer.x, pointer.y, button)}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false, saveAsImage: true, export: false } }}
        renderTopRightUI={() =>
          !conversationId ? null : (
          <button
            type="button"
            onClick={() => void sendToChat()}
            disabled={exporting}
            title="Als Bild in den Chat stellen"
            aria-label="Als Bild in den Chat stellen"
            className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#6965db] px-3 text-sm font-medium text-white shadow hover:opacity-90 disabled:opacity-60"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageUp className="h-4 w-4" />}
            <span className="hidden xl:inline">In den Chat</span>
          </button>
          )
        }
      />
    </div>
  );
}
