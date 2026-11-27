# Module entwickeln

Kuvert ist auf beiden Seiten modular aufgebaut. Ein Feature besteht typischerweise aus
einem **Server-Modul** (Provider, API-Routen, Hooks) und einem **Web-Modul** (Navigation,
Seiten, Erweiterungen bestehender Bereiche). Beide werden jeweils in einer einzigen
Registry-Datei eingetragen.

```
server/src/modules/index.ts   ← Server-Module
web/src/modules/index.ts      ← Web-Module
```

---

## 1. Server-Modul

```ts
// server/src/modules/hello/index.ts
import { defineModule } from '../../core/module.js';

export default defineModule({
  id: 'hello',                     // Routen landen unter /api/hello/…
  name: 'Hallo-Welt',
  features: ['hello'],             // Feature-Flag fürs Frontend (AppInfo.features.hello)
  isEnabled: () => process.env.HELLO_ENABLED !== 'false',

  migrations: [{ id: 'hello-001', sql: 'CREATE TABLE hello (id TEXT PRIMARY KEY, msg TEXT)' }],

  routes(app, ctx) {
    // Login ist automatisch erforderlich, req.user ist gesetzt
    app.get('/greeting', async (req) => ({ text: `Hallo ${req.user.name}` }));
  },

  init(ctx) {
    // Hooks in den Kern einhängen, Hintergrundjobs starten …
    ctx.hooks.afterSend.push(({ userId, message }) => ctx.log.info({ userId, subject: message.subject }, 'gesendet'));
  },
});
```

Danach in `server/src/modules/index.ts` importieren und in `allModules` aufnehmen.
Abschalten per Umgebungsvariable: `KUVERT_DISABLED_MODULES=hello` – oder ohne Neubau unter *Admin → Module* (wirkt nach Neustart).

### Kontext (`ModuleContext`)

| Feld       | Zweck |
|------------|-------|
| `accounts` | Konten lesen/ändern, Provider holen (`accounts.require(userId, accountId, 'mail')`) |
| `mail`     | Versand-Service (Undo/Später senden, Empfänger-Historie) |
| `hooks`    | Erweiterungspunkte (siehe unten) |
| `bus`      | `bus.publish(userId, event)` → Echtzeit an den Browser (SSE); `bus.internal` für Modul-Ereignisse |
| `kv`       | Einfacher Key-Value-Speicher (Sync-Status, Caches) |
| `db`       | SQLite (better-sqlite3) für eigene Tabellen |
| `config`, `log`, `registry` | Konfiguration, Logger, geladene Module |

Admin-only Routen: `requireAdmin(req)` aus `server/src/routes/admin.ts`; sicherheitsrelevante
Vorgänge mit `audit.log('modul.aktion', { req, details })` protokollieren.

### Hooks

| Hook | Wann | Beispiel |
|------|------|----------|
| `messageView` | vor Anzeige einer Nachricht | S/MIME entschlüsseln/prüfen |
| `attachmentResolvers` | Anhänge mit modul-eigenen IDs | entschlüsselte S/MIME-Anhänge |
| `rawSend` | Versand als fertige MIME-Nachricht (geordnet) | S/MIME signieren (10) → verschlüsseln (20) |
| `afterSend` | nach erfolgreichem Versand | Statistik, CRM-Ablage |
| `newMail` | neue Nachrichten im Posteingang erkannt (nur einreihen, nicht blockieren!) | Regeln/Filter, KI-Triage |
| `messageList` | vor Auslieferung einer Nachrichtenliste (Ordner, gemeinsamer Posteingang, Suche) | KI-Triage hängt `triage` an |
| `taskSources` | zusätzliche Aufgabenquelle ohne Mailkonto (eigene Pseudo-Konto-ID, voller `TasksProvider`) | Kuvert-eigene Aufgaben (`localtasks`) |

### Neuen Kontotyp (Provider) hinzufügen

Ein Modul kann beliebig viele Kontotypen liefern. Jeder Kontotyp erzeugt pro Konto ein
`ProviderSet` mit optionalen Implementierungen der Interfaces aus
`server/src/core/providers.ts`:

`MailProvider`, `CalendarProvider`, `ContactsProvider`, `TasksProvider`,
`StorageProvider`, `MeetingsProvider`.

```ts
accountTypes: [{
  type: 'jmap',
  label: 'JMAP (Fastmail, Stalwart …)',
  capabilities: ['mail', 'contacts', 'calendar'],
  auth: 'form',
  fields: [
    { key: 'url', label: 'Session-URL', type: 'url', required: true },
    { key: 'token', label: 'API-Token', type: 'password', secret: true, required: true },
  ],
  async setup(values) {
    // Verbindung testen, dann Config (unverschlüsselt) und Secrets (verschlüsselt) trennen
    return { email: '…', name: '…', config: { url: values.url }, secrets: { token: values.token } };
  },
  createProviders(ctx) {
    return { mail: new JmapMailProvider(ctx) };
  },
}]
```

- **OAuth-Kontotypen** implementieren `oauth.getAuthorizeUrl()` / `oauth.handleCallback()`;
  der Kern kümmert sich um State, PKCE und den Callback `/api/oauth/callback`.
  Für Tokens gibt es `OAuthClient` + `createTokenManager` (`core/oauth.ts`).
- IDs (Ordner, Nachrichten, Kalender …) sind für den Kern **opak** – der Provider wählt das Format.
- Wirft ein Provider `AuthError`, wird das Konto automatisch als „neu verbinden“ markiert.
- `core/http.ts` (`apiJson`, `apiFetch`) übernimmt Retry bei 429/503 und Fehlerumwandlung.
- `core/mime.ts` bietet `buildMime()` / `parseRawMessage()` für MIME-basierte Provider.

Kern-Routen für Mail, Kalender, Kontakte, Aufgaben, Speicher und Meetings funktionieren
automatisch mit jedem neuen Provider – inklusive gemeinsamem Posteingang, überlagertem
Kalender, Adress-Autovervollständigung und Benachrichtigungen.

---

## 2. Web-Modul

```tsx
// web/src/features/hello/module.tsx
import { Hand } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { HelloPage } from './HelloPage';
import { HelloSettings } from './HelloSettings';
import { HelloComposerButton } from './HelloComposerButton';

const mod: WebModule = {
  id: 'hello',
  feature: 'hello',                         // nur aktiv, wenn der Server das Feature meldet
  nav: [{ path: 'hello', label: 'Hallo', icon: Hand, order: 60 }],
  routes: [{ path: 'hello/*', element: <HelloPage /> }],
  settings: [{ id: 'hello', label: 'Hallo', icon: Hand, order: 75, component: HelloSettings }],
  composerToolbar: [HelloComposerButton],   // Button in der Editor-Werkzeugleiste
};
export default mod;
```

### Erweiterungspunkte

| Punkt | Props | Beispiel |
|-------|-------|----------|
| `nav`, `routes` | – | eigene Bereiche; `nav[].useBadge` (React-Hook → Zahl) zeigt einen Zähler, z. B. ungelesene Chats; `nav[].Status` (Komponente, `variant` `rail`/`dot`/`icon`) zeigt einen Zustand unter dem Eintrag bzw. am Symbol, z. B. laufende Timer |
| `settings` | – | Einstellungsseiten (jeder Benutzer) |
| `admin` | – | Seiten im Admin-Bereich (nur Administratoren) |
| `composerToolbar` | `ComposerExtensionProps` | KI-Assistent, Teams-Meeting |
| `composerOptions` | `ComposerExtensionProps` | zusätzliche Versandoptionen |
| `composerAttachSources` | `ComposerAttachSource` (Dialog mit `AttachSourceDialogProps`) | weitere Einträge im Menü „Anhängen“, z. B. „Aus Paperless …“: `attach()` hängt eine Datei mit Fortschrittsanzeige an, `insertLink()` fügt einen Link ein |
| `messageActions` | `MessageExtensionProps` | „Zusammenfassen“ |
| `messageBanners` | `MessageExtensionProps` | Hinweise über dem Inhalt |
| `attachmentActions` | `AttachmentExtensionProps` | Knöpfe an jedem Mail-Anhang, z. B. „An Paperless senden“ |
| `conversationActions` | `ConversationExtensionProps` | Aktionen für eine ganze Unterhaltung (KI-Zusammenfassung, Triage) |
| `services` | – | unsichtbare Dienste (Benachrichtigungen, Chat-Ereignisse) |
| `actions` | `ShellAction` | globale Aktionen ohne eigene Seite: Seitenleiste links, Befehlspalette, mobil im „Mehr“-Menü |
| `sidePanels` | `SidePanelDef` | Panel in der Seitenleiste rechts (Kalender, Kontakte, Chat, KI-Chat, Telefon): eingeklappt ein Symbol, aufgeklappt ein Reiter unten; öffnen per `openSidePanel(id)` aus `layout/side-panel-store.ts`. Befehlspalette und „Mehr“-Menü bekommen automatisch eine Aktion dazu; `Status` (Komponente) setzt eine Markierung ans Symbol, z. B. Play bei laufendem Timer |

`ComposerExtensionProps` bietet Zugriff auf den TipTap-Editor, den Entwurf und
Hilfsfunktionen (`insertHtml`, `getSelectedText`, `replaceContent` …), siehe
`web/src/features/mail/extension-types.ts`.

Weitere nützliche Bausteine:

- `openCompose({ to, subject, html, attachments })` aus `features/mail/compose-api.ts`
- `useServerEvent('mail.new', handler)` aus `lib/events.ts` (Echtzeit-Ereignisse)
- `useAccountsWith('storage')`, `useSettings()`, `useFeature('ai')` aus `lib/queries.ts`
- UI-Komponenten in `components/ui`, `AddressInput`, `RichEditor`, `StoragePickerDialog`
