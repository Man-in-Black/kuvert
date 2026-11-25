/** Hilfsfunktionen zur Anzeige von Sprachmodellen (Ollama liefert Größe, Parameter, Quantisierung). */
import type { AiModelInfo } from '@kuvert/shared';
import { formatSize } from '@/lib/utils';

/** "llama3.1:8b — 8.0B · Q4_K_M · 4.9 GB" */
export function modelLabel(m: AiModelInfo): string {
  const details = [m.parameterSize, m.quantization, m.sizeBytes ? formatSize(m.sizeBytes) : undefined].filter(Boolean);
  return details.length ? `${m.name} — ${details.join(' · ')}` : m.name;
}

/** Modelle nach Familie gruppieren (für <optgroup>); ohne Familie → eine Gruppe */
export function groupModels(models: AiModelInfo[]): { family: string | null; models: AiModelInfo[] }[] {
  const families = new Map<string | null, AiModelInfo[]>();
  for (const m of models) {
    const key = m.family ?? null;
    families.set(key, [...(families.get(key) ?? []), m]);
  }
  if (families.size <= 1) return [{ family: null, models }];
  return [...families.entries()].sort(([a], [b]) => (a ?? '').localeCompare(b ?? '')).map(([family, list]) => ({ family, models: list }));
}
