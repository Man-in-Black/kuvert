/**
 * Kennzeichnet Hintergrundarbeit (Suchindex, Polling) über AsyncLocalStorage.
 * Anbieter-Clients können damit Anfragen der Oberfläche bevorzugen und Hintergrundabrufe
 * drosseln, ohne dass jede Provider-Methode dafür einen eigenen Parameter braucht.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<boolean>();

/** fn (und alles, was daraus asynchron folgt) als Hintergrundarbeit ausführen */
export function runInBackground<T>(fn: () => T): T {
  return store.run(true, fn);
}

export function isBackground(): boolean {
  return store.getStore() === true;
}
