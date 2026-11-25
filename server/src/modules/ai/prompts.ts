/**
 * Prompt-Bausteine für die KI-Aktionen. Hier lassen sich Aktionen ergänzen
 * oder Formulierungen anpassen.
 */
import type { AiRequest } from '@kuvert/shared';
import type { ChatMessage } from './backends.js';

const BASE = [
  'Du bist ein präziser Schreibassistent für geschäftliche und private E-Mails.',
  'Antworte ausschließlich mit dem gewünschten Ergebnistext – ohne Einleitung, ohne Erklärungen, ohne Anführungszeichen um den Text.',
  'Erfinde keine Fakten, Namen, Termine oder Zusagen, die nicht im Text stehen.',
  'Behalte Anrede, Grußformel und Signaturen bei, sofern vorhanden, außer die Aufgabe verlangt etwas anderes.',
].join(' ');

const HTML_RULE =
  'Gib das Ergebnis als schlichtes HTML-Fragment zurück (nur <p>, <br>, <ul>, <ol>, <li>, <strong>, <em>, <a>). Kein <html>/<body>, kein Markdown, keine Codeblöcke.';
const TEXT_RULE = 'Gib reinen Text ohne Markdown-Formatierung zurück.';

function task(req: AiRequest, lang: string): string {
  const keepLang = `Antworte in der Sprache des Originaltexts (falls unklar: ${lang}).`;
  switch (req.action) {
    case 'rewrite':
      return `Formuliere den folgenden Text klarer, flüssiger und professioneller um. Inhalt und Bedeutung bleiben erhalten. ${keepLang}`;
    case 'formal':
      return `Formuliere den folgenden Text in einem höflichen, formellen Geschäftston (Sie-Form). ${keepLang}`;
    case 'friendly':
      return `Formuliere den folgenden Text freundlicher, wärmer und zugänglicher, aber weiterhin professionell. ${keepLang}`;
    case 'shorter':
      return `Kürze den folgenden Text deutlich (etwa auf die Hälfte), ohne wichtige Informationen zu verlieren. ${keepLang}`;
    case 'longer':
      return `Erweitere den folgenden Text um sinnvolle Details und eine bessere Struktur, ohne neue Fakten zu erfinden. ${keepLang}`;
    case 'fix':
      return `Korrigiere ausschließlich Rechtschreibung, Grammatik und Zeichensetzung des folgenden Texts. Ändere Stil und Inhalt nicht. ${keepLang}`;
    case 'translate':
      return `Übersetze den folgenden Text nach ${req.language || 'Englisch'}. Erhalte Ton und Formatierung.`;
    case 'summarize':
      return `Fasse die folgende E-Mail (bzw. den Verlauf) kompakt auf ${lang} zusammen: zuerst ein Satz Kernaussage, dann Stichpunkte mit wichtigen Fakten, Fristen und offenen Fragen, zuletzt "Zu tun:" mit konkreten Aufgaben für den Empfänger (falls vorhanden).`;
    case 'reply':
      return `Schreibe eine passende, höfliche Antwort auf die folgende E-Mail auf ${req.language || lang}.${req.instruction ? ` Berücksichtige dabei: ${req.instruction}.` : ''} Verwende eine passende Anrede und Grußformel, aber keine Signatur und keinen Platzhalternamen.`;
    case 'compose':
      return `Schreibe eine E-Mail auf ${req.language || lang} gemäß folgender Anweisung: ${req.instruction ?? ''}. Verwende eine passende Anrede und Grußformel, aber keine Signatur. Falls ein Text mitgegeben wird, nutze ihn als Grundlage/Entwurf.`;
    case 'subject':
      return `Schlage genau eine prägnante Betreffzeile (max. 70 Zeichen) für die folgende E-Mail vor. Gib nur die Betreffzeile zurück.`;
    case 'extract_tasks':
      return `Extrahiere aus der folgenden E-Mail alle konkreten Aufgaben, Termine und Fristen als Liste. Gib nichts zurück, wenn es keine gibt.`;
    case 'custom':
      return `${req.instruction ?? 'Überarbeite den Text.'} ${keepLang}`;
  }
}

export function buildMessages(req: AiRequest, defaultLanguage: string): ChatMessage[] {
  const plainOnly = req.action === 'subject';
  const format = plainOnly ? TEXT_RULE : req.html ? HTML_RULE : TEXT_RULE;
  const parts: string[] = [];
  if (req.context && req.context.trim()) parts.push(`Kontext (ursprüngliche E-Mail):\n"""\n${req.context.trim().slice(0, 12000)}\n"""`);
  if (req.text && req.text.trim()) parts.push(`Text:\n"""\n${req.text.trim().slice(0, 16000)}\n"""`);
  return [
    { role: 'system', content: `${BASE} ${format}` },
    { role: 'user', content: `${task(req, defaultLanguage)}\n\n${parts.join('\n\n')}`.trim() },
  ];
}

/**
 * Entfernt Markdown-Codezäune (```html … ```), die manche Modelle trotz
 * Anweisung ausgeben – funktioniert auf dem Stream.
 */
export function createFenceFilter() {
  let head = '';
  let started = false;
  let tail = '';
  return {
    push(chunk: string): string {
      if (!started) {
        head += chunk;
        if (head.length < 12 && !head.includes('\n')) return '';
        started = true;
        const stripped = head.replace(/^\s*```[a-zA-Z]*\s*\n?/, '');
        head = '';
        return this.hold(stripped);
      }
      return this.hold(chunk);
    },
    /** Die letzten Zeichen zurückhalten, um ein schließendes ``` zu erkennen */
    hold(text: string): string {
      const combined = tail + text;
      const keep = Math.min(combined.length, 4);
      tail = combined.slice(combined.length - keep);
      return combined.slice(0, combined.length - keep);
    },
    end(): string {
      const rest = (started ? '' : head) + tail;
      return rest.replace(/\n?```\s*$/, '');
    },
  };
}
