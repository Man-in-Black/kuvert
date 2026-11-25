/**
 * Fängt Renderfehler ab, damit nicht die ganze Oberfläche verschwindet (sonst bleibt nur
 * der dunkle Hintergrund stehen). Zeigt die Fehlermeldung an, damit sie gemeldet werden kann.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Bereich für die Meldung, z. B. "Unterhaltung" */
  label?: string;
  /** Ganze Seite statt eines Bereichs (Wurzel der App) */
  fullPage?: boolean;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[Kuvert] Fehler beim Anzeigen${this.props.label ? ` (${this.props.label})` : ''}:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const details = [`${error.name}: ${error.message}`, error.stack?.split('\n').slice(1, 8).join('\n')].filter(Boolean).join('\n');
    return (
      <div className={this.props.fullPage ? 'flex min-h-screen items-center justify-center bg-bg p-6 text-fg' : 'flex h-full items-center justify-center p-6 text-fg'}>
        <div className="flex max-w-lg flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-danger/10 text-danger">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <div className="text-sm font-semibold">{this.props.label ? `${this.props.label} konnte nicht angezeigt werden` : 'Etwas ist schiefgelaufen'}</div>
          <pre className="max-h-48 w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 px-3 py-2 text-left font-mono text-[11.5px] text-muted ring-1 ring-border">{details}</pre>
          <div className="flex gap-2">
            <button type="button" onClick={() => this.setState({ error: null })} className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-hover">
              Erneut versuchen
            </button>
            <button type="button" onClick={() => window.location.reload()} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-fg hover:opacity-90">
              Neu laden
            </button>
          </div>
        </div>
      </div>
    );
  }
}
