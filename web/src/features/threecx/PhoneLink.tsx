/**
 * Telefonnummer als Link: mit aktiver 3CX-Anbindung startet ein Klick den Anruf über die eigene
 * Nebenstelle, sonst übernimmt das System den tel:-Link (z. B. 3CX-App, Softphone, Smartphone).
 * Rechtsklick/Kopieren funktioniert in beiden Fällen, weil href immer tel: ist.
 */
import type { MouseEvent, ReactNode } from 'react';
import { useClickToCall } from './api';

export function telHref(number: string): string {
  return `tel:${number.replace(/\(0\)/g, '').replace(/[^\d+*#]/g, '')}`;
}

export function PhoneLink({ number, children, className }: { number: string; children?: ReactNode; className?: string }) {
  const { ready, extension, call } = useClickToCall();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!ready || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    call(number);
  };
  return (
    <a href={telHref(number)} onClick={onClick} className={className} title={ready ? `Über 3CX anrufen (Nebenstelle ${extension})` : undefined}>
      {children ?? number}
    </a>
  );
}
