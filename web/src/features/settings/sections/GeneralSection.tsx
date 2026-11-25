import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, X } from 'lucide-react';
import type { UserSettings } from '@kuvert/shared';
import { errorMessage } from '@/lib/api';
import { useSettings, useUpdateSettings } from '@/lib/queries';
import { Button, Input, Select, Switch, Tabs } from '@/components/ui';
import { Card, SavedIndicator, SectionHeader, SettingRow } from '../ui';

const MARK_READ_HINTS: Record<UserSettings['markReadMode'], string> = {
  delay: 'Wenn eine Nachricht im Lesebereich angezeigt wird',
  leave: 'Erst wenn eine andere Nachricht geöffnet oder die Ansicht geschlossen wird',
  manual: 'Nur über „Als gelesen markieren" bzw. die Taste U',
};

/** Sekunden-Eingabe, die erst beim Verlassen bzw. mit Enter speichert */
function DelayInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = draft.trim() === '' ? NaN : Math.round(Number(draft.replace(',', '.')));
    const v = Number.isFinite(n) ? Math.min(Math.max(n, 0), 600) : value;
    setDraft(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      <span>nach</span>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={600}
        step={1}
        className="w-20 text-right"
        value={draft}
        aria-label="Verzögerung in Sekunden"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      <span>{draft.trim() === '1' ? 'Sekunde' : 'Sekunden'}</span>
      {draft.trim() === '0' && <span className="text-xs">(sofort)</span>}
    </label>
  );
}

export function GeneralSection() {
  const { settings } = useSettings();
  const update = useUpdateSettings();
  const [saved, setSaved] = useState(0);
  const [newTrusted, setNewTrusted] = useState('');

  const set = (patch: Partial<UserSettings>) =>
    update.mutate(patch, {
      onSuccess: () => setSaved((n) => n + 1),
      onError: (err) => toast.error(errorMessage(err)),
    });

  // Alte Einstellung: negative Verzögerung bedeutete „nie"
  const readMode: UserSettings['markReadMode'] = settings.markReadDelaySec < 0 ? 'manual' : (settings.markReadMode ?? 'delay');

  const addTrusted = () => {
    const v = newTrusted.trim().toLowerCase();
    if (!v) return;
    if (!settings.trustedSenders.includes(v)) set({ trustedSenders: [...settings.trustedSenders, v] });
    setNewTrusted('');
  };

  return (
    <div className="space-y-5">
      <SectionHeader title="Allgemein" description="Darstellung und Verhalten von Kuvert. Änderungen werden sofort gespeichert." actions={<SavedIndicator trigger={saved} />} />

      <Card title="Darstellung">
        <SettingRow label="Farbschema">
          <Tabs
            value={settings.theme}
            onChange={(v) => set({ theme: v })}
            tabs={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Hell' },
              { value: 'dark', label: 'Dunkel' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Sprache" hint="Die Oberfläche ist derzeit auf Deutsch optimiert.">
          <Select value={settings.language} onChange={(e) => set({ language: e.target.value as UserSettings['language'] })}>
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </Select>
        </SettingRow>
        <SettingRow label="Dichte">
          <Tabs
            value={settings.density}
            onChange={(v) => set({ density: v })}
            tabs={[
              { value: 'comfortable', label: 'Komfortabel' },
              { value: 'compact', label: 'Kompakt' },
            ]}
          />
        </SettingRow>
      </Card>

      <Card title="E-Mail">
        <SettingRow label="Lesebereich">
          <Select value={settings.readingPane} onChange={(e) => set({ readingPane: e.target.value as UserSettings['readingPane'] })}>
            <option value="right">Rechts</option>
            <option value="bottom">Unten</option>
            <option value="off">Aus (Vollbild)</option>
          </Select>
        </SettingRow>
        <SettingRow label="Als gelesen markieren" hint={MARK_READ_HINTS[readMode]}>
          <div className="space-y-2">
            <Select
              value={readMode}
              onChange={(e) => {
                const mode = e.target.value as UserSettings['markReadMode'];
                set({ markReadMode: mode, ...(settings.markReadDelaySec < 0 ? { markReadDelaySec: 0 } : {}) });
              }}
            >
              <option value="delay">Beim Anzeigen</option>
              <option value="leave">Beim Wechsel zur nächsten Nachricht</option>
              <option value="manual">Nie automatisch</option>
            </Select>
            {readMode === 'delay' && <DelayInput value={Math.max(0, settings.markReadDelaySec)} onCommit={(v) => set({ markReadDelaySec: v })} />}
          </div>
        </SettingRow>
        <SettingRow label="Konversationsansicht" hint="Nachrichten nach Unterhaltung gruppieren">
          <Switch checked={settings.threading} onChange={(v) => set({ threading: v })} />
        </SettingRow>
        <SettingRow label="Senden rückgängig machen" hint="Verzögerung, in der der Versand noch abgebrochen werden kann">
          <Select value={String(settings.undoSendSeconds)} onChange={(e) => set({ undoSendSeconds: Number(e.target.value) })}>
            <option value="0">Aus</option>
            <option value="5">5 Sekunden</option>
            <option value="10">10 Sekunden</option>
            <option value="20">20 Sekunden</option>
            <option value="30">30 Sekunden</option>
          </Select>
        </SettingRow>
        <SettingRow label="Standardformat beim Verfassen">
          <Tabs
            value={settings.composeFormat}
            onChange={(v) => set({ composeFormat: v })}
            tabs={[
              { value: 'html', label: 'HTML' },
              { value: 'text', label: 'Nur Text' },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Verfassen-Fenster"
          hint="Neue Nachrichten und Antworten im Hauptfenster (verschiebbar) oder in einem eigenen Browserfenster öffnen"
        >
          <Tabs
            value={settings.composeWindow}
            onChange={(v) => set({ composeWindow: v })}
            tabs={[
              { value: 'inline', label: 'Im Hauptfenster' },
              { value: 'popup', label: 'Eigenes Fenster' },
            ]}
          />
        </SettingRow>
      </Card>

      <Card title="Datenschutz" description="Externe Bilder werden häufig zum Nachverfolgen des Öffnens (Tracking-Pixel) verwendet.">
        <SettingRow label="Externe Inhalte blockieren" hint="Bilder und Inhalte von fremden Servern erst nach Bestätigung laden">
          <Switch checked={settings.blockRemoteContent} onChange={(v) => set({ blockRemoteContent: v })} />
        </SettingRow>
        <div className="pt-3">
          <div className="mb-2 text-sm font-medium">Vertrauenswürdige Absender</div>
          <p className="mb-2 text-xs text-muted">Für diese Adressen oder Domains (z. B. „firma.de") werden externe Inhalte immer geladen.</p>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {settings.trustedSenders.length === 0 && <span className="text-xs text-muted">Keine Einträge.</span>}
            {settings.trustedSenders.map((s) => (
              <span key={s} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 py-0.5 pl-2.5 pr-1 text-xs">
                {s}
                <button
                  type="button"
                  aria-label="Entfernen"
                  className="rounded-full p-0.5 text-muted hover:bg-hover hover:text-fg"
                  onClick={() => set({ trustedSenders: settings.trustedSenders.filter((x) => x !== s) })}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex max-w-md gap-2">
            <Input
              value={newTrusted}
              placeholder="name@firma.de oder firma.de"
              onChange={(e) => setNewTrusted(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTrusted();
                }
              }}
            />
            <Button icon={<Plus className="h-4 w-4" />} onClick={addTrusted}>
              Hinzufügen
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Kalender">
        <SettingRow label="Mehrere Kalender" hint="Überlagert in einer Ansicht oder nebeneinander">
          <Tabs
            value={settings.calendarMode}
            onChange={(v) => set({ calendarMode: v })}
            tabs={[
              { value: 'overlay', label: 'Überlagert' },
              { value: 'split', label: 'Nebeneinander' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Standardansicht">
          <Select value={settings.calendarView} onChange={(e) => set({ calendarView: e.target.value as UserSettings['calendarView'] })}>
            <option value="timeGridDay">Tag</option>
            <option value="timeGridWeek">Woche</option>
            <option value="dayGridMonth">Monat</option>
            <option value="listWeek">Liste</option>
          </Select>
        </SettingRow>
        <SettingRow label="Woche beginnt am">
          <Select value={String(settings.weekStartsOn)} onChange={(e) => set({ weekStartsOn: Number(e.target.value) as 0 | 1 })}>
            <option value="1">Montag</option>
            <option value="0">Sonntag</option>
          </Select>
        </SettingRow>
      </Card>
    </div>
  );
}
