import { Fragment } from 'react';
import { HIGHLIGHT_END, HIGHLIGHT_START } from '@kuvert/shared';

/**
 * Zeigt Text mit Treffer-Markierungen aus dem Suchindex an. Die Marker sind
 * Unicode-Private-Use-Zeichen – es wird kein HTML interpretiert (kein XSS-Risiko).
 */
export function Highlighted({ text, className }: { text: string; className?: string }) {
  const parts = text.split(HIGHLIGHT_START);
  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (i === 0) return <Fragment key={i}>{part.replaceAll(HIGHLIGHT_END, '')}</Fragment>;
        const end = part.indexOf(HIGHLIGHT_END);
        if (end < 0) return <Fragment key={i}>{part}</Fragment>;
        return (
          <Fragment key={i}>
            <mark className="rounded-[3px] bg-warning/25 px-0.5 text-inherit dark:bg-warning/30">{part.slice(0, end)}</mark>
            {part.slice(end + 1).replaceAll(HIGHLIGHT_END, '')}
          </Fragment>
        );
      })}
    </span>
  );
}
