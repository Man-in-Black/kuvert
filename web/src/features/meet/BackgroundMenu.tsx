/**
 * Auswahl des Kamera-Hintergrunds im Anruf: kein Effekt, weichzeichnen (leicht/stark), mitgelieferte
 * Hintergründe oder ein eigenes Bild. Die Auswahl merkt sich der Browser und wendet sie beim nächsten
 * Einschalten der Kamera wieder an.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { toast } from 'sonner';
import { Ban, ImagePlus, Loader2, WandSparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BACKGROUNDS, backgroundUrl, customBackground, savedEffect, selectEffect, setCustomBackground, type EffectId } from './effects';

export function BackgroundMenu() {
  const room = useRoomContext();
  const { isCameraEnabled } = useLocalParticipant();
  const [open, setOpen] = useState(false);
  const [effect, setEffect] = useState<EffectId>(savedEffect);
  const [busy, setBusy] = useState<EffectId | null>(null);
  const [custom, setCustom] = useState<string | null>(customBackground);
  const box = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Schließen bei Klick daneben bzw. Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Vorschaubilder erst beim ersten Öffnen zeichnen
  const thumbs = useMemo(() => (open ? Object.fromEntries(BACKGROUNDS.map((b) => [b.id, backgroundUrl(b.id)])) : null), [open]);

  const choose = async (id: EffectId) => {
    if (busy) return;
    setBusy(id);
    try {
      await selectEffect(room, id);
      setEffect(id);
    } catch (err) {
      toast.error('Hintergrund lässt sich nicht anwenden', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    try {
      setCustom(await setCustomBackground(file));
      await choose('custom');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const tile = (id: EffectId, label: string, content: ReactNode) => (
    <button
      key={id}
      type="button"
      onClick={() => void choose(id)}
      title={label}
      aria-label={label}
      aria-pressed={effect === id}
      className={cn(
        'group relative flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-white/5 ring-2 transition',
        effect === id ? 'ring-primary' : 'ring-transparent hover:ring-white/30',
      )}
    >
      {content}
      <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[10px] leading-tight text-white">{label}</span>
      {busy === id && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/50">
          <Loader2 className="h-5 w-5 animate-spin" />
        </span>
      )}
    </button>
  );

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Hintergrund"
        aria-label="Hintergrund"
        aria-expanded={open}
        className={cn(
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors',
          effect !== 'none' ? 'bg-primary hover:brightness-110' : 'bg-white/10 hover:bg-white/20',
        )}
      >
        <WandSparkles className="h-5 w-5" />
      </button>

      {open && (
        <div className="absolute bottom-full left-1/2 z-30 mb-3 w-[min(360px,calc(100vw-1.5rem))] -translate-x-1/2 rounded-xl bg-[#181b21] p-3 text-sm shadow-2xl ring-1 ring-white/10">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold">Hintergrund</span>
            {!isCameraEnabled && <span className="text-xs text-white/50">greift, sobald die Kamera an ist</span>}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {tile('none', 'Kein Effekt', <Ban className="h-5 w-5 text-white/70" />)}
            {tile(
              'blur-light',
              'Leicht unscharf',
              <span className="h-full w-full bg-[linear-gradient(135deg,#6b7280,#9ca3af)] blur-[2px]" />,
            )}
            {tile('blur', 'Unscharf', <span className="h-full w-full bg-[linear-gradient(135deg,#6b7280,#9ca3af)] blur-[5px]" />)}
            {BACKGROUNDS.map((b) =>
              tile(`bg:${b.id}`, b.label, thumbs ? <img src={thumbs[b.id]} alt="" className="h-full w-full object-cover" /> : null),
            )}
            {custom ? (
              tile('custom', 'Eigenes Bild', <img src={custom} alt="" className="h-full w-full object-cover" />)
            ) : (
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="flex aspect-video flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/25 text-xs text-white/70 hover:border-white/50 hover:text-white"
              >
                <ImagePlus className="h-5 w-5" />
                Eigenes Bild
              </button>
            )}
          </div>
          {custom && (
            <button type="button" onClick={() => fileInput.current?.click()} className="mt-2 text-xs text-white/60 hover:text-white">
              Anderes eigenes Bild wählen …
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <p className="mt-2 text-xs text-white/50">Die Erkennung läuft nur in deinem Browser – es wird kein Bild hochgeladen.</p>
        </div>
      )}
    </div>
  );
}
