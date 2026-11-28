# Kuvert ✉️

**Selbst gehosteter, modularer Web-Client für E-Mail, Kalender, Kontakte, Aufgaben und Dateien** –
für Microsoft 365, Google Workspace/Gmail, IMAP/SMTP, CalDAV/CardDAV und Nextcloud.
Mit gemeinsamem Posteingang, überlagerten Kalendern, S/MIME, Teams/Meet-Meetings,
lokalem KI-Assistenten (Ollama), Push-Benachrichtigungen, Mehrbenutzer- und Admin-Bereich,
Zwei-Faktor-Anmeldung, REST-API mit Webhooks, Team-Chat mit Audio-/Videoanrufen sowie mailcow-, Mail-Archiver-, Paperless-ngx- und 3CX-Anbindung.
Läuft als ein Docker-Container.

---

## Funktionen

| Bereich | Umfang |
|---|---|
| **Microsoft 365** (Graph API) | Mail inkl. **freigegebener Postfächer** (lesen & senden als), Kalender, Kontakte + Firmenverzeichnis, Aufgaben (To Do), OneDrive, Teams-Besprechungen, Abwesenheitsnotiz |
| **Google** | Gmail (Labels als Ordner), Kalender + Google Meet, Kontakte (People API, Verzeichnis), Google Tasks, Google Drive, Abwesenheitsnotiz |
| **IMAP / SMTP** | Beliebige Anbieter, IMAP IDLE (Push), Sent-Ablage, Aliasse, Autokonfiguration (Thunderbird-ISPDB) |
| **CalDAV / CardDAV** | Kalender (inkl. Serienterminen), Aufgaben (VTODO), Adressbücher – z. B. Radicale, Baïkal, SOGo, mailbox.org |
| **Nextcloud / WebDAV** | Kalender, Kontakte, Aufgaben und Dateien inkl. Freigabelinks |
| **Mehrere Konten** | Gemeinsamer Posteingang (kontoübergreifend sortiert), Suche im Ordner, im ganzen Konto (alle Unterordner) oder kontoübergreifend, Farben pro Konto |
| **Konversationsansicht** | Nachrichten nach Unterhaltung gruppiert (Thread-ID von Microsoft/Gmail, bei IMAP über Message-ID/In-Reply-To und Betreff), Leseansicht mit allen Nachrichten des Threads – *Einstellungen → Allgemein*; Doppelklick öffnet eine Nachricht oder Unterhaltung (auch eine einzelne Nachricht einer aufgeklappten Unterhaltung) in einem **eigenen Fenster** |
| **Aufgaben** | Microsoft To Do, Google Tasks, CalDAV (VTODO) und **Kuvert-eigene Aufgabenlisten** (in der Kuvert-Datenbank, auch ohne passendes Konto; Listen anlegen, umbenennen, löschen) in einer Ansicht, „Fällig & überfällig“ über alle Listen; aus jeder Mail per Klick eine **Aufgabe** (mit Verweis zurück auf die Mail) oder einen **Termin** anlegen – auf Wunsch als Besprechung mit Absender oder allen Beteiligten |
| **Kalender** | Überlagert *oder* nebeneinander (getrennte Spalten), Drag & Drop, Serien, Teilnehmer, Zu-/Absagen, Online-Meeting per Klick; zusätzlich als **Kalender-Leiste** rechts (Agenda der nächsten 7 Tage), anpinnbar neben Mail & Co. |
| **Editor** | TipTap-WYSIWYG: Schriftarten, Farben, Tabellen, Bilder (inline/cid), Links, Vorlagen, Nur-Text-Modus |
| **Signaturen** | **HTML** (im Editor bearbeitbar) und **RAW** (Quelltext wird byte-genau angehängt) – pro Konto/Absender, Standard für Neu/Antwort |
| **S/MIME** | Signieren, Verschlüsseln, Prüfen, Entschlüsseln; .p12/.pfx-Import; Empfängerzertifikate werden automatisch gesammelt |
| **KI (Ollama)** | Umschreiben, formeller/freundlicher, kürzen/erweitern, Rechtschreibung, Übersetzen, Betreff vorschlagen, Zusammenfassen, Antwort vorschlagen, freie Anweisung – alles lokal; Zusammenfassen, Antwort und Aufgaben auch für ganze Unterhaltungen; **KI-Chat** für freie Fragen – global (auf Wunsch mit Postfach-Suche und Quellen), zu einer Mail oder zu einem ganzen Verlauf |
| **KI-Triage** | Neue Mails automatisch nach **Priorität** (hoch/normal/niedrig) und **Kategorie** einordnen: Etikett in der Liste, Filter „Wichtig“, nach Priorität sortieren/filtern, Begründung in der Leseansicht, Korrektur per Klick, als erledigt markieren, eigene Kategorien und Regeln, Webhook `mail.triage` – *Einstellungen → KI-Triage* |
| **Cloud-Anhänge** | Aus OneDrive / Google Drive / Nextcloud anhängen oder als Freigabelink einfügen; Mail-Anhänge in der Cloud speichern |
| **Benachrichtigungen** | Echtzeit (SSE), Desktop-Benachrichtigungen, Web Push (auch bei geschlossenem Tab), Terminerinnerungen |
| **Mehrbenutzer & Admin** | Benutzerverwaltung (anlegen, sperren, Rollen, Passwort-Reset mit Änderungspflicht, 2FA zurücksetzen, überall abmelden), Richtlinien (2FA-Pflicht, Registrierung, Sitzungsdauer, erlaubte Kontotypen, max. Konten), Audit-Log, System-Übersicht |
| **Profil & Sicherheit** | Profilbild und Stammdaten, Passwort, **2FA per TOTP** (Authenticator-App) mit Wiederherstellungscodes, aktive Sitzungen/Geräte verwalten, Datenexport |
| **API** | REST-API für alle Funktionen, persönliche **API-Tokens** mit Scopes (read/write/admin), interaktive Doku (OpenAPI/Swagger) unter `/api/docs`, **Webhooks** mit HMAC-Signatur (z. B. für n8n, Node-RED) |
| **mailcow** | Admin: Postfächer, Domains, Aliasse, Quarantäne, Provisionierung (Postfach + Kuvert-Konto in einem Schritt). Benutzer: Kontingent, Wegwerf-Adressen, App-Passwörter, Quarantäne, Passwort ändern. Kontotyp „mailcow“ richtet IMAP/SMTP + SOGo-Kalender/Kontakte automatisch ein |
| **Team-Chat** | Direktnachrichten und Gruppen zwischen Kuvert-Benutzern in Echtzeit (SSE): WYSIWYG-Eingabe mit Markdown-Kürzeln, @-Erwähnungen (Personen, @all), Dateien & Bilder, Antworten, Reaktionen, Bearbeiten/Löschen, Lesebestätigungen, „schreibt …“, Online-Status, Suche, Stummschalten/Anheften, Web Push, Webhook `chat.message`; zusätzlich **Mattermost, Nextcloud Talk und Microsoft Teams** in derselben Oberfläche |
| **Anrufe** | Audio- und Videoanrufe im Team-Chat (direkt und in Gruppen) über einen selbst gehosteten LiveKit-Server: **Bildschirmfreigabe**, gemeinsames **Whiteboard** (Excalidraw, als Bild in den Chat stellbar), Klingeln mit Annehmen/Ablehnen, Web Push, verpasste Anrufe mit „Zurückrufen“, Anruf-Karte mit Dauer im Verlauf, verkleinerbares Anruf-Fenster, Hintergrund weichzeichnen oder ersetzen, für alle beenden; weitere Personen dazuholen, **Gäste ohne Konto** per Link mit Wartebereich, **Meeting-Links im Kalender** |
| **Mail-Archiver** | Archiv durchsuchen (Volltext, Zeitraum, Konto, Ordner), Mails lesen, Anhänge/.eml laden, aus dem Archiv weiterleiten oder antworten – per persönlichem API-Schlüssel |
| **Paperless-ngx** | Eigener Bereich zum Durchsuchen, Ansehen und Versenden per Mail; im Editor Dokumente per Volltext, Korrespondent, Typ und Tag suchen und **anhängen** (Archiv-PDF oder Original) oder als **Freigabelink** mit Ablaufdatum einfügen; Mail-Anhänge per Klick **an Paperless übergeben** (Titel, Korrespondent, Dokumenttyp, Tags optional) – per persönlichem API-Token |
| **3CX** | Click-to-Call über die eigene Nebenstelle (3CX V20): Klick auf eine Telefonnummer startet den Anruf; eingehende Anrufe in Echtzeit mit Namen aus den Kontakten, verpasste mit „Zurückrufen“; Bereich **Telefon** mit Wahlfeld, laufendem Gespräch (Auflegen), eigenem Status, Anrufliste, 3CX-Telefonbuch und Kollegen mit Status; Zuordnung der Nebenstellen durch den Admin – auch automatisch per E-Mail-Adresse |
| **Zeiterfassung** | Timer mit Start/Stopp – auch mehrere gleichzeitig, laufende Timer links im Menü sichtbar (links als Bereich **Zeiterfassung**, rechts als Panel in der Seitenleiste), Aufrunden auf 15 Minuten (einstellbar), Projektsuche auch nach Kunden, Zeiten nachtragen und bearbeiten (Dauer direkt, ±15 min, Zeitleiste), Wochen-/Monats-/Jahresansicht mit Tagessummen, gemeinsame Kunden → Projekte → Tätigkeiten mit Stundensätzen, Schlagworte, Auswertung mit Beträgen und CSV-Export; **Import aus Kimai 2** (API-Token oder API-Passwort, wiederholbar ohne Dubletten) |
| **Oberfläche** | Modernes, responsives Design (Desktop, Tablet, Smartphone mit eigener Mobil-Navigation), Hell/Dunkel/System, Befehlspalette (Strg/⌘+K), einklappbare Seitenleiste, installierbar als PWA oder als [Desktop-App](#desktop-app) |
| **Suche** | Lokaler Volltext-Index (Meilisearch) über alle Konten: Treffer in wenigen Millisekunden, Suche beim Tippen, tippfehlertolerant, Hervorhebung, Suchbefehle (`from:`, `to:`, `has:attachment`, `is:unread`, `in:sent`, `after:`/`before:` …), Mail-Treffer direkt in der Befehlspalette |
| **Komfort** | Senden rückgängig machen, später senden, Entwürfe automatisch speichern, Tastaturkürzel, Dunkelmodus, PWA, Tracking-Schutz (externe Inhalte blockiert), Vorlagen/Textbausteine, Mehrbenutzer, mailto:-Links öffnen den Kuvert-Editor (auch als Standard-Mailprogramm im Browser festlegbar) |

---

## Schnellstart (Docker)

Fertige Images für **amd64 und arm64** liegen in der GitHub Container Registry
(`ghcr.io/man-in-black/kuvert`) – ein eigener Build ist nicht nötig:

```bash
cp .env.example .env          # PUBLIC_URL und MEILI_MASTER_KEY eintragen
docker compose up -d
```

Aktualisieren: `docker compose pull && docker compose up -d`.
Bestimmte Version statt `latest`: `KUVERT_VERSION=1.0.0` in der `.env`.

Selbst aus dem Quellcode bauen:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

`MEILI_MASTER_KEY` schützt den mitgelieferten Suchindex (erzeugen z. B. mit `openssl rand -hex 32`).

Dann `http://localhost:8080` öffnen – der erste Benutzer wird Administrator.

Mit lokalem KI-Modell:

```bash
docker compose --profile ai up -d
docker compose exec ollama ollama pull llama3.1:8b
```

Alle Daten (SQLite-Datenbank, verschlüsselte Zugangsdaten, Uploads) liegen im Volume `kuvert-data` (`/data`).
**Backup** = dieses Volume sichern. Ohne gesetztes `APP_SECRET` wird der Schlüssel in `/data/app-secret.key`
erzeugt – geht er verloren, sind gespeicherte Zugangsdaten nicht mehr lesbar.

### Hinter einem Reverse Proxy (empfohlen, HTTPS)

HTTPS ist Voraussetzung für Web Push, sichere Cookies und die meisten OAuth-Registrierungen.
`PUBLIC_URL` muss der externen Adresse entsprechen. Für Echtzeit-Ereignisse (SSE) darf der
Proxy nicht puffern – Beispiel nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;              # wichtig für /api/events (SSE) und KI-Streaming
    proxy_http_version 1.1;           # WebSockets für Anrufe (/api/meet/lk)
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 1h;
    client_max_body_size 50m;
}
```

`$connection_upgrade` braucht im `http`-Block: `map $http_upgrade $connection_upgrade { default upgrade; '' close; }`.

Caddy: `kuvert.example.com { reverse_proxy 127.0.0.1:8080 { flush_interval -1 } }` (WebSockets ohne weitere Angaben)

---

## Konten einrichten

> **Zugangsdaten in der Oberfläche:** Microsoft-/Google-App und KI-Backend lassen sich als Administrator unter
> **Admin → Dienste & Anmeldung** eintragen – inklusive Redirect-URI zum Kopieren, Einrichtungsanleitung und
> KI-Verbindungstest. Werte aus der `.env` gelten als Vorgabe, in der Oberfläche gesetzte Werte überschreiben sie
> sofort (ohne Neustart) und lassen sich jederzeit wieder auf die `.env` zurücksetzen. Geheimnisse werden
> verschlüsselt gespeichert und nie wieder angezeigt.

### Microsoft 365 (Azure / Entra ID)

**Automatisch (empfohlen):** *Admin → Dienste & Anmeldung → Microsoft 365 → Automatisch einrichten*.
Microsoft-365-Administrator (E-Mail) angeben, den angezeigten Code auf `microsoft.com/devicelogin` eingeben und
mit dem Admin-Konto anmelden (MFA wird unterstützt; Microsoft fragt dabei im Namen von „Microsoft Graph Command
Line Tools“ nach der Berechtigung, Apps zu verwalten). Kuvert legt dann selbst an bzw. aktualisiert:
App-Registrierung mit Redirect-URI, alle unten genannten Graph-Berechtigungen, Unternehmensanwendung,
Administratorzustimmung für die Organisation und einen geheimen Clientschlüssel (24 Monate) – und trägt Client-ID,
Geheimnis und Tenant ein. Das Admin-Token wird nur für diesen Vorgang im Arbeitsspeicher gehalten. Benötigt wird die
Rolle *Globaler Administrator* (oder *Anwendungsadministrator* + *Administrator für privilegierte Rollen*).
Erneut ausführen erneuert den Clientschlüssel (der alte wird entfernt). Voraussetzung: `PUBLIC_URL` mit HTTPS
(oder `localhost`).

**Manuell:**

1. **Entra ID → App-Registrierungen → Neue Registrierung**
   - Kontotypen: je nach Bedarf (Single-Tenant → `MS_TENANT=<Tenant-ID>`, Multi-Tenant → `organizations` bzw. `common`)
   - Umleitungs-URI (Plattform **Web**): `https://<PUBLIC_URL>/api/oauth/callback`
2. **Zertifikate & Geheimnisse** → neuer geheimer Clientschlüssel → `MS_CLIENT_SECRET`, Anwendungs-ID → `MS_CLIENT_ID`
   (oder beides unter *Admin → Dienste & Anmeldung* eintragen)
3. **API-Berechtigungen → Microsoft Graph → Delegiert**:
   `openid profile email offline_access User.Read User.ReadBasic.All People.Read Mail.ReadWrite Mail.Send Mail.ReadWrite.Shared Mail.Send.Shared MailboxSettings.ReadWrite Calendars.ReadWrite Calendars.ReadWrite.Shared Contacts.ReadWrite Tasks.ReadWrite Files.ReadWrite.All OnlineMeetings.ReadWrite`
   (optional für Teams-Chats im Kuvert-Chat: `Chat.ReadWrite`)
   → ggf. **Administratorzustimmung erteilen**.
4. In Kuvert: *Einstellungen → Konten → Konto hinzufügen → Microsoft 365*.

**Freigegebene Postfächer:** In den Kontoeinstellungen die SMTP-Adressen der Shared Mailboxes eintragen.
Voraussetzung in Exchange: *Vollzugriff* (lesen) und *Senden als* bzw. *Senden im Auftrag* (senden) für den Benutzer.
Die Postfächer erscheinen dann als eigene Ordnerbäume und als Absender-Identitäten.

**Teams:** Termine mit „Online-Meeting“ werden als Teams-Besprechung angelegt; im Editor fügt
„Online-Meeting“ einen Teams-Link direkt in die Mail ein.

### Google Workspace / Gmail

1. [Google Cloud Console](https://console.cloud.google.com/) → Projekt anlegen
2. **APIs aktivieren:** Gmail API, Google Calendar API, People API, Google Tasks API, Google Drive API, Google Meet REST API
3. **OAuth-Zustimmungsbildschirm** konfigurieren (intern für Workspace, sonst Testnutzer eintragen)
4. **Anmeldedaten → OAuth-Client-ID → Webanwendung**, autorisierte Weiterleitungs-URI:
   `https://<PUBLIC_URL>/api/oauth/callback` → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
   (oder unter *Admin → Dienste & Anmeldung* eintragen)

> Hinweis: Der volle Gmail-Scope (`https://mail.google.com/`) ist ein „eingeschränkter“ Scope. Für
> interne Workspace-Apps oder Testnutzer ist das unproblematisch; eine öffentliche Veröffentlichung
> erfordert Googles Sicherheitsprüfung.

### IMAP / SMTP

*Konto hinzufügen → IMAP / SMTP*. „Automatisch ermitteln“ schlägt Server anhand der E-Mail-Adresse vor.
Bei Anbietern mit 2FA (Gmail, iCloud, Outlook.com …) ein **App-Passwort** verwenden.
„Gesendete in ‚Gesendet‘ ablegen“ deaktivieren, falls der Server das selbst tut.

### CalDAV / CardDAV, Nextcloud, WebDAV

- **CalDAV/CardDAV:** Server-URL (Discovery über `/.well-known/caldav` bzw. Basis-URL), Benutzer, Passwort.
- **Nextcloud:** nur Server-URL + Benutzer + **App-Passwort** (Nextcloud → Einstellungen → Sicherheit).
  Kalender, Kontakte, Aufgaben und Dateien (inkl. Freigabelinks) werden automatisch eingebunden.

---

## S/MIME

*Einstellungen → S/MIME*: eigenes Zertifikat als `.p12`/`.pfx` (oder PEM mit Schlüssel) hochladen.
Der private Schlüssel wird verschlüsselt in der Datenbank gespeichert. Im Editor lassen sich
**Signieren** und **Verschlüsseln** pro Nachricht einschalten. Eingehende signierte Mails werden geprüft
und die Zertifikate der Absender automatisch gespeichert – damit kann man ihnen anschließend
verschlüsselt antworten.

Vertrauensbasis für die Prüfung:
- System-CA-Bundle (`SMIME_CA_FILE`, Standard `/etc/ssl/certs/ca-certificates.crt` – enthält nur TLS-Wurzeln)
- Mozilla-Wurzeln mit E-Mail-Vertrauensbit (`server/assets/smime-roots.pem`, z. B. Sectigo, HARICA,
  D-Trust, Telekom, GlobalSign Secure Mail); aktualisieren mit `npm run update-smime-roots --workspace server`
- die Wurzelzertifikate aus der Kette der eigenen hochgeladenen `.p12`/`.pfx`
- optional eine eigene PEM-Datei mit weiteren CAs, z. B. einer Firmen-CA: `SMIME_EXTRA_CA_FILE`

Ist die Signatur intakt, das Zertifikat aber nicht vertrauenswürdig, erscheint ein gelber Hinweis
mit Grund und ausstellender CA statt „Signatur ungültig". Funktioniert über alle Kontotypen hinweg
(Graph/Gmail/IMAP senden dann die fertige MIME-Nachricht).

## KI-Assistent

Standardmäßig wird Ollama unter `AI_BASE_URL` angesprochen (`http://ollama:11434` im Compose-Profil `ai`).
Ebenso möglich: jede **OpenAI-kompatible API** (LM Studio, vLLM, LocalAI …) mit `AI_BACKEND=openai`.
Das Modell lässt sich pro Benutzer in *Einstellungen → KI-Assistent* wählen. Mails verlassen dabei
nie die eigene Infrastruktur (sofern das LLM lokal läuft).

Empfehlungen: `llama3.1:8b`, `qwen2.5:7b`, `mistral-nemo` (gutes Deutsch), mit GPU auch größere Modelle.

### KI-Chat

Seitenpanel rechts (nicht modal – Liste und Mail bleiben bedienbar), geöffnet über **KI-Chat** in der
Seitenleiste, die Befehlspalette (Strg+K → „KI-Chat“) oder mobil über „Mehr“. Wie die **Kalender-Leiste** lässt
es sich über die Pinnadel **anpinnen**: Dann sitzt es neben dem Inhalt, und Liste und Lesefenster rücken zur Seite,
statt verdeckt zu werden; die Breite lässt sich am linken Rand ziehen (beides merkt sich der Browser):

- **Global:** freie Fragen an das Modell. Mit **Postfach durchsuchen** (Standard) formuliert die KI zu jeder
  Frage eine Suchanfrage (inkl. `from:`, `after:` …), durchsucht den Suchindex bzw. live die Konten, liest die
  besten Treffer und antwortet mit Quellenangaben `[1]`, `[2]` – ein Klick öffnet die Mail.
- **Zu einer Mail / Unterhaltung:** KI-Menü (✨) in der Leseansicht bzw. Konversationsansicht →
  „Im KI-Chat fragen …“. Die Mail bzw. der ganze Verlauf ist dann Kontext aller Fragen; Antworten lassen sich
  direkt **als Antwort** öffnen.
- Modell pro Chat umschaltbar.
- **Gespeicherte Chats:** Jeder Chat wird automatisch pro Benutzer auf dem Server gespeichert (SQLite, Tabelle
  `ai_chats`). Über das Verlaufs-Symbol im Panel lassen sich frühere Chats durchsuchen, öffnen, umbenennen und
  löschen; ein Chat zu einer Mail bzw. Unterhaltung wird beim erneuten Öffnen wieder aufgenommen.
  Aufbewahrung in *Einstellungen → KI-Assistent* (7/30/90 Tage, 1 Jahr, unbegrenzt; Standard 90 Tage nach der
  letzten Nachricht) – die Chats enthalten zitierte Mailinhalte.
- API: `POST /api/ai/chat` mit `{ messages, context?, searchMailbox?, model? }`, Antwort als NDJSON-Stream
  (`status`, `sources`, `delta`, `error`, `done`). Gespeicherte Chats: `GET/DELETE /api/ai/chats`,
  `GET/PUT/PATCH/DELETE /api/ai/chats/:id`, `GET /api/ai/chats/by-key?key=…`.

### KI-Triage

*Einstellungen → KI-Triage* (pro Benutzer, standardmäßig aus): Jede neue Mail im Posteingang wird im
Hintergrund vom Sprachmodell eingeordnet – **Priorität** hoch/normal/niedrig und eine **Kategorie**
(Vorgabe: Aktion erforderlich, Antwort erwartet, Termin, Rechnung & Finanzen, Info, Benachrichtigung,
Newsletter, Werbung, Persönlich, Sonstiges – frei änderbar). Dazu lassen sich eigene Regeln
(„Mails von @kunde.de sind immer hoch“), ein eigenes (kleines, schnelles) Modell und ausgenommene
Konten festlegen. Die Automatik ordnet nur **neu eingehende** Mails ein; beim Einschalten werden
zusätzlich die 30 neuesten Mails je Konto eingeordnet. Ältere Mails: „Posteingang jetzt einordnen“
in den Einstellungen, in der Nachrichtenliste über das Sortier-Symbol („Nicht eingeordnete einordnen“)
oder per Mehrfachauswahl → „Mit KI einordnen“.

- **Liste:** Etikett mit Kategorie; Pfeil nach oben/rot = hoch, Pfeil nach unten/grau = niedrig, Haken =
  erledigt. Filter **Wichtig** zeigt offene Mails mit hoher Priorität. Über das Sortier-Symbol oben rechts
  in der Liste: **nach Priorität sortieren** und nach Hoch/Normal/Niedrig/Erledigt/ohne Einordnung
  filtern (auch per URL, `?sort=priority&prio=high`). Filter und Sortierung arbeiten auf den geladenen
  Nachrichten (Filter: die neuesten 300 der Ansicht).
- **Leseansicht:** Priorität, Kategorie und Begründung über dem Inhalt. Über *Ändern* bzw. das
  Etikett-Symbol: **mit KI neu einordnen**, **als erledigt markieren**, Priorität/Kategorie von Hand
  überschreiben oder die Einordnung entfernen. Von Hand gesetzte Werte überschreibt die Automatik nicht.
- **Unterhaltungen:** Das Etikett zeigt die höchste noch offene Priorität. Steht nach einer Mail eine
  eigene Antwort im Verlauf (auch aus „Gesendet“ nachgeladen) oder ist sie als beantwortet markiert,
  gilt sie als erledigt. Die Aktionsleiste der Unterhaltung ordnet alle eingehenden Nachrichten auf
  einmal neu ein oder überschreibt sie; dazu kommen die **KI-Tools für den ganzen Verlauf**
  (zusammenfassen, Antwort auf die letzte Nachricht vorschlagen, Aufgaben & Termine erkennen).
- Ergebnisse kommen per Echtzeit-Ereignis `mail.triage` in den Browser – und als gleichnamiger
  **Webhook**, z. B. um wichtige Mails in n8n weiterzuverarbeiten.
- Einordnungen liegen in der Kuvert-Datenbank (nicht beim Mail-Anbieter) und werden nach
  `AI_TRIAGE_RETENTION_DAYS` (Standard 180) gelöscht. Es läuft standardmäßig eine Einordnung
  gleichzeitig (`AI_TRIAGE_CONCURRENCY`), damit ein lokales Modell nicht überlastet wird.
- **Speicher:** Bei Ollama wird das Modell nach jeder eingeordneten Mail wieder entladen (`keep_alive: 0`)
  und belegt danach weder RAM noch VRAM. Dafür wird es für jede Mail neu geladen, größere Stapel
  dauern also länger.
- **Wiederholungen:** Lässt sich das Modell nicht laden oder ist der KI-Server nicht erreichbar, wird
  die Mail bis zu 4-mal versucht. Dazwischen pausiert die Warteschlange 15 s, 1 min und 3 min.
  Die Einstellungsseite zeigt den Fehler und den nächsten Versuch. Was danach noch scheitert (auch
  unbrauchbare Antworten des Modells), steht dort als **fehlgeschlagen** mit Betreff, Absender und
  Fehler – per *Wiederholen* gesammelt neu einreihen oder *Verwerfen*. Die Liste übersteht einen Neustart.
- **Stoppen:** Solange eingeordnet wird, bricht *Stoppen* in den Einstellungen alle wartenden und
  laufenden Einordnungen des Benutzers ab und entlädt das Modell. Neue Mails werden danach weiter
  eingeordnet, solange die Automatik eingeschaltet ist.
- Mit `AI_BACKEND=openai` und einem **externen** Anbieter gehen Absender, Betreff und Anfang jeder
  neuen Mail an diesen Dienst – die Einstellungsseite weist darauf hin.

## Benutzer, Admin-Bereich & 2FA

- Der erste Benutzer wird Administrator. Weitere Benutzer legt der Admin im **Admin-Bereich** an
  (optional mit Pflicht zur Passwortänderung bei der ersten Anmeldung) oder man erlaubt die Selbstregistrierung.
- **2FA:** *Einstellungen → Sicherheit* → QR-Code mit einer Authenticator-App scannen (Aegis, Google/Microsoft
  Authenticator, 1Password, Bitwarden …). Wiederherstellungscodes sicher aufbewahren. Per Richtlinie kann 2FA für
  alle verpflichtend gemacht werden – Benutzer ohne 2FA werden dann nach dem Login durch die Einrichtung geführt.
- **Audit-Log:** Anmeldungen (auch fehlgeschlagene), 2FA-Änderungen, Admin-Aktionen, Tokens und Konten werden
  protokolliert (Aufbewahrung 365 Tage).
- **Module:** Unter *Admin → Module* lassen sich Module ein- und ausschalten (z. B. Chat, Anrufe, KI-Triage, 3CX).
  Die Änderung wirkt nach einem Neustart – im Docker-Container direkt per Knopf „Jetzt neu starten“
  (die Restart-Richtlinie startet Kuvert wieder). Per `KUVERT_MODULES`/`KUVERT_DISABLED_MODULES` festgelegte
  Module sind dort nicht schaltbar.

## REST-API & Webhooks

```bash
# Token erstellen: Einstellungen → API & Webhooks
curl -H "Authorization: Bearer kvt_…" https://kuvert.example.com/api/accounts
curl -H "Authorization: Bearer kvt_…" "https://kuvert.example.com/api/mail/unified?limit=20"
```

- Scopes: `read` (GET), `write` (ändernde Aufrufe, z. B. Mail senden), `admin` (`/api/admin/*`, nur für Admins).
- Vollständige, interaktive Dokumentation: **`/api/docs`** (OpenAPI 3, JSON unter `/api/docs/json`).
- **Webhooks** senden Ereignisse (`mail.new`, `calendar.reminder`, `send.status` …) als JSON-POST.
  Prüfung der Echtheit: `X-Kuvert-Signature: sha256=<HMAC-SHA256(secret, body)>`.

## mailcow, Mail-Archiver & Paperless

Details zur Einrichtung: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

- **mailcow:** Im Admin-Bereich die mailcow-Instanz mit einem **Read-Write-API-Key** hinterlegen
  (in mailcow: *Konfiguration → Zugang → API*, Kuvert-IP freischalten).
- **Mail-Archiver:** API im Archiver aktivieren (`Api__Enabled=true`), Basis-URL im Admin-Bereich setzen,
  jeder Benutzer hinterlegt seinen persönlichen API-Schlüssel unter *Einstellungen → Mail-Archiv*.
- **Paperless-ngx:** Basis-URL unter *Admin → Paperless* setzen (oder `PAPERLESS_URL`), jeder Benutzer hinterlegt
  seinen API-Token aus Paperless (*Mein Profil → API-Auth-Token*) unter *Einstellungen → Paperless*.

## Team-Chat

Unter **Chat** schreiben sich alle Benutzer einer Kuvert-Instanz direkt oder in Gruppen – ohne externen Dienst.
Nachrichten werden als Markdown gespeichert; die Eingabe ist ein WYSIWYG-Editor, der Kürzel wie `**fett**`,
`_kursiv_`, `` `Code` ``, `> Zitat`, `- Liste` oder ```` ``` ```` beim Tippen umsetzt (alternativ über die Formatleiste).
Dateien und Bilder lassen sich anhängen, einfügen oder ablegen; sie liegen unter `/data/chat-files` und sind nur für
Mitglieder der Unterhaltung abrufbar. Gruppen-Admins können Mitglieder verwalten und Nachrichten moderieren.
**Erwähnungen:** Ein `@` im Eingabefeld schlägt die Mitglieder der Unterhaltung vor (im Kuvert-Chat mit dem
E-Mail-Namen, z. B. `@max.mustermann`), in Gruppen zusätzlich `@all` (Mattermost auch `@channel`/`@here`;
Teams-Chats nur einzelne Personen). Erwähnungen werden im Verlauf hervorgehoben und melden sich auch in
stummgeschalteten Unterhaltungen.
Benachrichtigungen (Hinweis, Desktop, Ton, Web Push) stellt jeder unter *Einstellungen → Chat* ein; eine
Desktop-Benachrichtigung kommt auch, wenn Kuvert zwar sichtbar, aber nicht das aktive Fenster ist. Ungelesene
Nachrichten zählt ein Badge an **Chat**, ungelesene Mails im Sammel-Posteingang eines an **Mail**.
Abschalten für die ganze Instanz: `KUVERT_DISABLED_MODULES=chat`.

**Mattermost, Nextcloud Talk & Teams:** Zusätzlich kann jeder Benutzer unter *Einstellungen → Chat → Verbundene Dienste*
seine Mattermost- bzw. Talk-Konten sowie die Teams-Chats eines Microsoft-365-Kontos anbinden. Deren Direktnachrichten, Gruppen und Kanäle erscheinen in derselben
Chat-Liste (mit Kennzeichnung und Filter) und lassen sich dort lesen und beantworten – inkl. Antworten, Reaktionen,
Bearbeiten/Löschen, Dateien, Suche und neuer Unterhaltungen. Details: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md#mattermost-nextcloud-talk--teams-im-chat).
Nur die Anbindungen abschalten: `CHAT_BRIDGES=false`.

### Anrufe (Audio, Video, Bildschirm, Whiteboard)

In Kuvert-Unterhaltungen starten die Knöpfe 📞/🎥 im Kopf einen Anruf; die anderen Mitglieder klingeln (mit Web Push)
und nehmen per Klick an. Im Anruf: Mikrofon/Kamera samt Geräteauswahl, **Bildschirm freigeben**, gemeinsames
**Whiteboard** (Excalidraw – alle zeichnen gleichzeitig, Mauszeiger der anderen sichtbar, „In den Chat“ stellt die
Zeichnung als Bild in die Unterhaltung) und Verkleinern, um Kuvert währenddessen weiter zu benutzen.
**Hintergrund** (Zauberstab-Knopf): weichzeichnen (leicht/stark), mitgelieferte Hintergründe oder ein eigenes Bild – die
Erkennung (MediaPipe) läuft nur im Browser, Modell und WASM liefert Kuvert selbst aus. Wer den Anruf gestartet hat (bei
Meetings auch, wer es angelegt hat), kann ihn über das Auflegen-Menü **für alle beenden** – auch Gäste werden getrennt.
Direktanrufe enden nach 45 s ohne Antwort; wer nicht dabei war, sieht „Verpasster Anruf“ mit „Zurückrufen“.

**Personen und Gäste einladen** (Knopf 👤+ im Anruf):

- *Person hinzufügen* holt weitere Kuvert-Benutzer in den laufenden Anruf – auch aus einer Direktnachricht, ohne dass
  sie Mitglied der Unterhaltung werden. Sie klingeln wie bei einem Anruf.
- *Gast-Link* für Personen ohne Kuvert-Konto: Der Gast öffnet `https://<kuvert>/join/…` im Browser, gibt seinen Namen ein
  und klopft an. Wer aus Kuvert im Anruf ist, sieht „… möchte beitreten“ und lässt zu oder lehnt ab. Gäste haben Ton,
  Video, Bildschirmfreigabe und Whiteboard, aber keinen Zugriff auf Chat oder Kuvert und lassen sich jederzeit entfernen.
  Der Link gilt bis zum Ende des Anrufs und lässt sich vorher widerrufen.
- **Kalender:** Im Termin-Editor legt „Kuvert-Anruf hinzufügen“ ein Meeting mit festem Link an und trägt ihn in
  Beschreibung (und Ort) ein – so bekommen ihn auch externe Eingeladene. Angemeldete treten über den Link direkt bei,
  Gäste klopfen an und warten, bis jemand aus Kuvert im Meeting ist und sie hereinlässt.
- **Spontanmeeting** (im Chat über „Neu“ bzw. als Aktion in Seitenleiste und Befehlspalette): legt ohne Termin ein
  Meeting mit eigenem Link an, tritt sofort bei und öffnet „Personen“ zum Dazuholen bzw. Kopieren des Gast-Links.
  Spontane Meetings verfallen nach 7 Tagen von selbst.
- Gäste lassen sich unter *Admin → Anrufe* abschalten. Die Links bauen auf `PUBLIC_URL` auf – die Variable muss die
  externe Adresse enthalten.

Audio und Video laufen über einen eigenen **LiveKit-Server** (Open Source, SFU – auch für größere Gruppen):

```bash
# .env: LIVEKIT_URL=http://livekit:7880, LIVEKIT_API_KEY=kuvert, LIVEKIT_API_SECRET=$(openssl rand -hex 32)
docker compose --profile meet up -d
```

Die Signalisierung reicht Kuvert unter `wss://<kuvert>/api/meet/lk` an LiveKit durch – LiveKit braucht also keine
eigene Domain und kein Zertifikat, der Reverse Proxy muss aber **WebSockets** weiterleiten (nginx:
`proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade;`).
Für die Medien müssen **TCP 7881 und UDP 7882** von außen erreichbar sein. Alternativ lässt sich unter
*Admin → Anrufe* eine eigene LiveKit-Adresse für Browser eintragen. Dort auch: Verbindungstest, Bildschirmfreigabe und
Whiteboard an/aus. Anrufe gibt es nur in Kuvert-Unterhaltungen; Mattermost/Talk/Teams telefonieren weiter im Dienst.

## Suche

Kuvert liest alle Mail-Konten im Hintergrund in einen lokalen **Meilisearch**-Index ein (läuft im
Docker-Stack mit). Das passiert in zwei Stufen: Zuerst werden Kopfdaten übernommen – ein Postfach ist
damit nach Sekunden durchsuchbar –, danach werden Nachrichtentexte und Anhangnamen nachgeladen
(bei IMAP gebündelt). Neue Mails, Verschieben, Löschen und Flags werden laufend übernommen; alle
12 Stunden findet ein Abgleich statt (auch für Änderungen aus anderen Mailprogrammen).

- Kontoübergreifende Suche **beim Tippen**, Treffer typischerweise in 1–10 ms, sortiert nach Relevanz
  (Betreff/Absender vor Text) und Datum
- Suchbefehle: `from:anna` `to:bob@firma.de` `subject:rechnung` `has:attachment` `is:unread` `is:flagged`
  `in:sent` `after:2026-01-01` `before:31.12.2025` `"exakte phrase"`
- Strg/⌘+K zeigt passende Mails direkt in der Befehlspalette
- Konten, die (noch) nicht indiziert sind, werden weiterhin live beim Anbieter durchsucht
- Verschlüsselte S/MIME-Inhalte werden bewusst nicht im Klartext indiziert
- Steuerung: *Admin → Dienste & Anmeldung → Suchindex* (URL, Zeitraum, Volltext ja/nein, Neuaufbau),
  Benutzer sehen den Fortschritt unter *Einstellungen → Suche* und können Konten ausschließen

## Benachrichtigungen

- Offene Tabs erhalten neue Mails und Terminerinnerungen in Echtzeit (Server-Sent Events) und zeigen
  Desktop-Benachrichtigungen.
- **Web Push** (*Einstellungen → Benachrichtigungen*, pro Gerät) benachrichtigt auch bei geschlossenem Tab
  bzw. geschlossener App – auf Android z. B. in der Benachrichtigungsleiste. Jedes abonnierte Gerät
  bekommt den Push, auch wenn Kuvert anderswo offen ist; angezeigt wird er nur, wenn auf dem Gerät
  gerade kein Kuvert-Fenster sichtbar ist. Erfordert HTTPS und ausgehenden Zugriff des Servers auf die
  Push-Dienste der Browser (Chrome: `fcm.googleapis.com`, Firefox: `*.push.services.mozilla.com`).
  VAPID-Schlüssel werden automatisch erzeugt.
- IMAP-Konten nutzen IDLE (sofort), andere Konten werden im Intervall `POLL_INTERVAL` abgefragt.

## Desktop-App

[Kuvert Desktop](https://github.com/Man-in-Black/kuvert-desktop) ist eine schlanke Hülle (Electron) um die
Kuvert-Oberfläche für Linux, Windows und macOS: eigenes Fenster, Symbol im Infobereich mit Hinweis auf neue
Nachrichten, Autostart und mailto:-Links aus dem System. Links auf andere Seiten öffnen im Standardbrowser des
Systems – Chromium-Browser nehmen dafür das zuletzt aktive Profil, anders als eine installierte PWA, die immer
ihr eigenes Profil verwendet. Die App lädt die Oberfläche vom Server; neue Kuvert-Funktionen brauchen also kein
App-Update. Web Push entfällt dort, Benachrichtigungen kommen, solange die App läuft.

---

## Architektur

```
┌──────────── Browser (React, Vite, TipTap, FullCalendar) ────────────┐
│ Web-Module: mail · calendar · contacts · tasks · files · archive    │
│   settings · profile · admin · ai · triage · smime · meetings        │
│   notifications · mailcow · chat                                     │
└──────────────── REST /api · SSE /api/events · Web Push ─────────────┘
┌──────────────────────── Server (Node 24, Fastify) ──────────────────┐
│ Kern: Auth/Sessions · Konten · Mail-Service (Undo/Später) · Hooks    │
│       gemeinsamer Posteingang · aggregierte Kalender/Kontakte/…      │
│ Server-Module ─┬─ microsoft (Graph)   ─┬─ google (Gmail/…)           │
│                ├─ imap (IMAP/SMTP)     ├─ dav (CalDAV/CardDAV/NC)    │
│                ├─ smime (OpenSSL)      ├─ ai (Ollama/OpenAI-kompat.) │
│                ├─ notifications (Polling/IDLE, Web Push, Reminder)   │
│                ├─ mailcow (API + IMAP/SOGo)                          │
│                ├─ mailarchiver (Archiv-Suche)                        │
│                ├─ search (Meilisearch-Volltextindex)                 │
│                ├─ chat (Team-Chat, Dateien unter /data/chat-files)   │
│                └─ triage (KI-Priorität/Kategorie für neue Mails)     │
│ Kern: Benutzer/Rollen · 2FA (TOTP) · API-Tokens · Webhooks · Audit   │
│ SQLite (verschlüsselte Secrets, AES-256-GCM)                         │
└──────────────────────────────────────────────────────────────────────┘
```

```
shared/   gemeinsame TypeScript-Typen (API-Verträge)
server/   Fastify-Backend   – src/core (Kern), src/routes, src/modules/<modul>
web/      React-Frontend    – src/features/<modul>, src/components, src/lib
docs/     MODULES.md – eigene Module/Provider entwickeln
```

Jeder Anbieter implementiert nur die Provider-Interfaces (`server/src/core/providers.ts`);
gemeinsamer Posteingang, Suche, Benachrichtigungen, S/MIME usw. funktionieren damit automatisch.
**Eigene Erweiterungen: siehe [docs/MODULES.md](docs/MODULES.md).**

### Sicherheit

- Zugangsdaten/Tokens/S/MIME-Schlüssel AES-256-GCM-verschlüsselt (Schlüssel aus `APP_SECRET`)
- Passwörter mit scrypt, Sitzungen als signierte HttpOnly-Cookies (SameSite=Lax), CSRF-Header-Pflicht
- 2FA per TOTP mit Replay-Schutz, gehashte Wiederherstellungscodes; API-Tokens nur als SHA-256-Hash gespeichert
- Token-Zugriffe können weder Passwort/2FA noch Tokens verwalten (nur per Browser-Sitzung)
- Mail-HTML wird mit DOMPurify bereinigt und in einem Sandbox-iframe ohne Skripte mit eigener CSP angezeigt;
  externe Bilder/Tracking-Pixel standardmäßig blockiert
- Anhänge werden nur für unkritische Typen inline ausgeliefert (`nosniff`, CSP-Sandbox)
- Login-Rate-Limit, OAuth mit PKCE und State

---

## Entwicklung

Voraussetzung: Node.js ≥ 22.12

```bash
npm install
npm run dev:server   # API auf :8080 (tsx watch)
npm run dev:web      # Vite auf :5173 mit Proxy auf :8080
npm run typecheck
npm run build        # web/dist + server/dist
```

Für OAuth in der Entwicklung `PUBLIC_URL=http://localhost:8080` setzen und die Redirect-URI
`http://localhost:8080/api/oauth/callback` registrieren (der Callback läuft über den API-Server).

---

## Konfiguration

Alle Variablen mit Erklärung: [`.env.example`](.env.example). Die wichtigsten:

| Variable | Bedeutung |
|---|---|
| `PUBLIC_URL` | Externe URL (OAuth-Redirects, sichere Cookies) |
| `APP_SECRET` | Schlüssel für Sitzungen & Verschlüsselung (sonst automatisch erzeugt) |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_TENANT` | Microsoft 365 (Vorgabe, auch im Admin-Bereich einstellbar) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google (Vorgabe, auch im Admin-Bereich einstellbar) |
| `GOOGLE_PLACES_API_KEY` | Optional: Ortssuche im Termin-Dialog über die Google Places API (New), auch im Admin-Bereich einstellbar |
| `AI_BACKEND` / `AI_BASE_URL` / `AI_MODEL` | KI-Assistent (Vorgabe, auch im Admin-Bereich einstellbar) |
| `AI_TRIAGE_CONCURRENCY` / `AI_TRIAGE_RETENTION_DAYS` | KI-Triage: gleichzeitige Einordnungen (Standard 1), Aufbewahrung in Tagen (Standard 180) |
| `KUVERT_MODULES` / `KUVERT_DISABLED_MODULES` | Module ein-/ausschalten (haben Vorrang vor *Admin → Module*) |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Anrufe im Chat über LiveKit (Vorgabe, auch unter *Admin → Anrufe*); `LIVEKIT_PUBLIC_URL` optional |
| `CHAT_BRIDGES` | `false` schaltet die Anbindung von Mattermost/Nextcloud Talk/Teams im Chat ab |
| `ALLOW_REGISTRATION` | Selbstregistrierung erlauben |

---

## Ideen für weitere Module

Dank Modul-System gut nachrüstbar:

- **Regeln/Filter** serverseitig (Hook `newMail`), z. B. automatisch verschieben/markieren
- **Snooze / Wiedervorlage** und **Erinnern, wenn keine Antwort kommt**
- **Labels/Kategorien** in der UI
- **PGP/OpenPGP** analog zum S/MIME-Modul (Hooks `rawSend` / `messageView`)
- **JMAP**-Provider (Fastmail, Stalwart), **Exchange EWS** für On-Premises
- **Einladungen (ICS) direkt aus der Mail annehmen** für IMAP-Konten
- Aufgaben/Termine aus Mails automatisch extrahieren (analog zur KI-Triage)
- **OIDC/SSO-Login** für Kuvert selbst, **Passkeys/WebAuthn** als zweiter Faktor
- **Volltextsuche-Index** (lokaler Cache), Offline-Modus
- **Freigaben** von Kalendern/Postfächern zwischen Kuvert-Benutzern
