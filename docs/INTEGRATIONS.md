# Integrationen: mailcow, Mail-Archiver, 3CX, Mattermost, Nextcloud Talk & Teams

## mailcow

Kuvert spricht die [mailcow](https://mailcow.email)-API an und bietet:

| Wer | Funktion |
|---|---|
| **Admin** (*Admin → mailcow*) | Instanz verbinden & testen, Serverstatus (Version, Container, Speicher), Postfächer anlegen/ändern/löschen inkl. Kontingent, Domains, Aliasse, Quarantäne, Sync-Jobs, Verknüpfungen Benutzer ↔ Postfach |
| **Admin** (*Postfach anlegen*) | Provisionierung in einem Schritt: Postfach in mailcow + Kuvert-Benutzer (neu oder vorhanden) + fertig eingerichtetes Konto |
| **Benutzer** (*Einstellungen → Mein Postfach*) | Kontingent, Aliasse, Wegwerf-Adressen (zeitlich begrenzte Aliasse), App-Passwörter, eigene Quarantäne, Postfach-Passwort ändern |
| **Kontotyp „mailcow“** | Ein Formular: E-Mail (IMAP 993/SSL, SMTP 587/STARTTLS) **und** Kalender, Aufgaben & Kontakte über SOGo |

### Einrichtung

1. In mailcow: **System → Konfiguration → Zugang → API**
   - Einen **Lese-/Schreib-Schlüssel** (read-write) erzeugen und aktivieren.
   - Unter *Erlaubte IPs* die IP-Adresse freigeben, mit der Kuvert auf mailcow zugreift
     (bei Docker: die ausgehende IP des Hosts).
2. In Kuvert: **Admin → mailcow → Instanz verbinden** – Adresse der mailcow-Oberfläche
   (z. B. `https://mail.example.com`) und API-Schlüssel eintragen. Der Schlüssel wird verschlüsselt gespeichert.

   Alternativ per Umgebung vorbelegen (wird beim ersten Start übernommen):

   ```env
   MAILCOW_URL=https://mail.example.com
   MAILCOW_API_KEY=XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX
   MAILCOW_NAME=Produktion
   ```

3. Der Hostname der Instanz wird für **IMAP/SMTP** und **SOGo** verwendet:
   - CalDAV/CardDAV: `https://<host>/SOGo/dav/` (Benutzername = E-Mail-Adresse)
   - Ist SOGo für ein Postfach deaktiviert, richtet Kuvert nur E-Mail ein.

### Self-Service & Sicherheit

- Ein Benutzer erhält Self-Service nur für **verknüpfte** Postfächer. Verknüpfungen entstehen
  - automatisch beim Einrichten eines `mailcow`- oder `imap`-Kontos auf dem Host einer bekannten Instanz
    (der erfolgreiche IMAP-Login beweist den Besitz),
  - bei der Provisionierung,
  - manuell durch den Admin (*Verknüpfungen*).
- Das Ändern des Postfach-Passworts erfordert das Kuvert-Passwort; die gespeicherten Zugangsdaten
  der eigenen Kuvert-Konten werden automatisch angepasst.
- App-Passwörter werden in Kuvert erzeugt und **nur einmal** angezeigt, nicht gespeichert.
- Alle Admin-Aktionen landen im Audit-Log.

## Mail-Archiver

Anbindung an [Mail-Archiver](https://github.com/s1t5/mail-archiver) über dessen **lesende REST-API**:
Archiv durchsuchen (Volltext, `subject:`/`from:`-Syntax, Zeitraum, Konto, Ordner, Richtung),
Nachrichten sicher anzeigen (bereinigtes HTML, externe Bilder blockiert), Anhänge laden,
als `.eml` herunterladen, **antworten** und **weiterleiten** (als `.eml`-Anhang) direkt aus Kuvert.

### Einrichtung

1. Im Mail-Archiver die API aktivieren (`appsettings.json` bzw. Umgebung):

   ```env
   Api__Enabled=true
   # optional
   Api__AllowAttachmentDownloads=true
   Api__AllowMessageDownloads=true
   Api__RateLimitPerMinute=120
   ```

2. In Kuvert: **Admin → Mail-Archiver** – Standard-Adresse eintragen (z. B. `https://archiv.example.com`)
   und „Archiv-Suche anbieten“ aktivieren. Alternativ `MAILARCHIVER_URL=…` setzen (aktiviert die Anbindung).
3. Jeder Benutzer erzeugt im Mail-Archiver einen **persönlichen API-Schlüssel** (`ma_…`) und hinterlegt ihn
   unter **Einstellungen → Mail-Archiv** (oder direkt auf der Seite *Archiv*). So gelten die
   Sichtbarkeitsregeln des Archivs – Administratoren des Archivs sehen alles, Benutzer nur ihre Konten.

Deep-Link für Suchen: `/archive?q=Rechnung&from=2026-01-01`

### Hinweise

- Die Schlüssel werden verschlüsselt gespeichert und nie an den Browser zurückgegeben.
- Überschreitet ein Benutzer das Anfragelimit des Archivs (HTTP 429), zeigt Kuvert einen Hinweis.
- Die Archiv-API ist rein lesend; Kuvert verändert keine archivierten Daten.

## 3CX (Click-to-Call)

Anbindung an die Telefonanlage **3CX V20** über die **Call Control API**: Ein Klick auf eine
Telefonnummer in Kuvert (Kontakte, Ansprechpartner) startet den Anruf über die eigene Nebenstelle.
Je nach Gerät klingelt zuerst das eigene Telefon bzw. die 3CX-App, nach dem Abheben wird gewählt;
Telefone mit direkter Anrufsteuerung (uaCSTA) wählen sofort. Ohne aktive Anbindung oder ohne
zugeordnete Nebenstelle bleiben Telefonnummern normale `tel:`-Links.

### Voraussetzungen

- 3CX V20 mit einer Lizenz **ab 8SC, Edition Enterprise bzw. AI** – nur dort gibt es die Call Control API.
- Kuvert muss die Anlage per HTTPS erreichen (gleiche Adresse wie die 3CX-Verwaltung).

### Einrichtung

1. In 3CX: **Integrationen → API → Hinzufügen**
   - **Client-ID** vergeben (z. B. `kuvert`) und **„3CX Call Control API Access“** aktivieren.
   - Unter den **zu überwachenden Nebenstellen** alle Nebenstellen eintragen, von denen aus Kuvert-Benutzer
     anrufen sollen – andere lehnt 3CX ab.
   - Optional für die automatische Zuordnung: **„3CX Configuration API Access“** mit einer Rolle, die Benutzer lesen darf.
   - Den angezeigten **API-Schlüssel** sichern – 3CX zeigt ihn nur einmal.
2. In Kuvert: **Admin → 3CX** – Adresse der Anlage, Client-ID und API-Schlüssel eintragen, aktivieren,
   „Verbindung testen“. Der Test zeigt die abrufbaren (überwachten) Nebenstellen.
3. Unter **Nebenstellen der Benutzer** jedem Benutzer seine Nebenstelle zuordnen – von Hand oder mit
   **„Per E-Mail zuordnen“** (gleiche E-Mail-Adresse in Kuvert und 3CX; bestehende Zuordnungen bleiben).
4. Benutzer wählen unter **Einstellungen → Telefonie** auf Wunsch ihr bevorzugtes Gerät
   (Tischtelefon, App, Webclient) und können einen Probeanruf starten.

### Bereich „Telefon“

Mit aktiver Anbindung gibt es in der Navigation den Bereich **Telefon**:

| Teil | Inhalt | Quelle in 3CX |
|---|---|---|
| **Wahlfeld** | Nummer oder Nebenstelle eintippen bzw. per Tastenfeld wählen, Enter startet den Anruf | Call Control API |
| **Laufendes Gespräch** | Gegenstelle und Zustand (klingelt, verbunden …) mit **Auflegen** – nur eigene Gespräche | Call Control API |
| **Mein Status** | Verfügbar, Abwesend, Nicht stören, Mittagspause, Dienstreise | Konfigurations-API |
| **Anrufliste** | Eigene Anrufe der letzten 14 Tage, nach Tagen gruppiert, Filter „Verpasste“, Rückruf per Klick | Konfigurations-API (Anrufbericht) |
| **Telefonbuch** | Firmen-Telefonbuch der Anlage durchsuchen (Name, Firma, Nummer), anrufen oder Mail schreiben | Konfigurations-API |
| **Kollegen** | Alle Nebenstellen mit Status, „telefoniert“ (bei überwachten Nebenstellen) und „abgemeldet“, Anruf auf Durchwahl oder Mobil | Konfigurations-API + Call Control |

Deep-Link: `/phone?number=+4930123456` füllt das Wahlfeld, `/phone?tab=contacts&q=Müller` sucht im Telefonbuch.

Für Status, Anrufliste, Telefonbuch und Kollegen braucht die API-Anwendung zusätzlich
**„3CX Configuration API Access“**. Die Anrufliste liest den Anrufbericht der Anlage – laut 3CX-Community
klappt das nur mit der Rolle **System-Eigentümer** (System Owner); mit „System-Administrator“ bleibt sie leer
oder liefert einen Fehler. Jeder Benutzer sieht nur die Anrufe seiner eigenen Nebenstelle; Benutzer,
die in 3CX „im Telefonbuch ausblenden“ haben, erscheinen nicht unter Kollegen. Fehlt die Freigabe,
zeigen die Reiter einen Hinweis, Wahlfeld und Auflegen funktionieren trotzdem.

Alternativ per Umgebung vorbelegen (aktiviert die Anbindung, bis im Admin-Bereich gespeichert wird):

```env
THREECX_URL=https://firma.3cx.de
THREECX_CLIENT_ID=kuvert
THREECX_API_KEY=…
```

### Hinweise

- Die Nebenstelle legt **nur der Admin** fest – Benutzer können nicht von fremden Apparaten aus anrufen.
- Nummern werden vor dem Wählen bereinigt: `+49 (0) 30 123-45` → `+493012345`. Versteht die Anlage
  kein führendes `+`, im Admin-Bereich einen Ersatz (z. B. `00`) eintragen.
- Strg/⌘/Umschalt-Klick auf eine Nummer öffnet weiterhin den normalen `tel:`-Link.
- Der API-Schlüssel wird verschlüsselt gespeichert und nie an den Browser zurückgegeben.

## Mattermost, Nextcloud Talk & Teams im Chat

Zusätzlich zum eingebauten Team-Chat kann jeder Benutzer externe Chat-Dienste anbinden. Deren Unterhaltungen
erscheinen in derselben Chat-Liste (Kennzeichnung „Mattermost“/„Talk“/„Teams“, Filter oben in der Liste) und werden dort
gelesen und beantwortet. Kuvert spricht dabei im Namen des Benutzers mit dem Dienst – es gelten dessen Rechte.

### Einrichtung

*Einstellungen → Chat → Verbundene Dienste*:

- **Mattermost:** Adresse plus **persönliches Zugriffstoken** (*Profil → Sicherheit → Persönliche Zugriffstoken*;
  muss in der Systemkonsole unter *Integrationen → Integrationsverwaltung* erlaubt sein) **oder** Benutzername und
  Passwort. Mit Passwort erneuert Kuvert die Sitzung bei Ablauf selbst; bei aktiver Zwei-Faktor-Anmeldung bitte ein
  Token verwenden.
- **Nextcloud Talk:** Nextcloud-Adresse, Benutzername und **App-Passwort** – oder mit einem Klick die Zugangsdaten
  eines bereits eingerichteten Nextcloud-Kontos übernehmen.
- **Microsoft Teams:** ein bereits eingerichtetes **Microsoft-365-Konto** wählen. Kuvert braucht dafür zusätzlich die
  delegierte Graph-Berechtigung **`Chat.ReadWrite`**. Fehlt sie, bietet der Dialog „Bei Microsoft zustimmen“ an
  (einmalige Anmeldung, danach wird die Verbindung automatisch eingerichtet). Angefragt wird sie nur für Konten,
  die Teams verbinden – bestehende Mail-Konten bleiben unberührt. Erlaubt die Organisation keine
  Benutzerzustimmung: *Admin → Dienste & Anmeldung → Microsoft „Automatisch einrichten“* erneut ausführen (die
  automatisch eingerichtete App enthält `Chat.ReadWrite` inkl. Administratorzustimmung) bzw. bei manueller
  App-Registrierung `Chat.ReadWrite` ergänzen und zustimmen. Nur Geschäfts-/Schulkonten, keine privaten Microsoft-Konten.

Zugangsdaten werden verschlüsselt gespeichert und nie an den Browser zurückgegeben.

### Funktionsumfang

| | Mattermost | Nextcloud Talk | Microsoft Teams |
|---|---|---|---|
| Direktnachrichten, Gruppen/Kanäle lesen & schreiben | ✓ | ✓ | Chats (1:1, Gruppen, Besprechungen) – keine Team-Kanäle |
| Antworten (Mattermost: als Thread-Antwort), Reaktionen | ✓ | ✓ | ✓ (Antwort als Zitat) |
| Bearbeiten / Löschen eigener Nachrichten | ✓ | ✓ (ab Nextcloud 28 bzw. je nach Talk-Version) | ✓ |
| Dateien senden und öffnen | ✓ | ✓ (Ablage im Talk-Ordner, Freigabe in die Unterhaltung) | nur öffnen (Anhänge, eingebettete Bilder) |
| Echtzeit | WebSocket | Abfrage alle 10 s (Browser offen) bzw. 60 s, geöffnete Unterhaltung per Long-Polling sofort | Abfrage alle 15 s (Browser offen) bzw. 60 s, geöffnete Unterhaltung alle 4 s |
| „schreibt …“ / Online-Status | ✓ / ✓ | – / Direktnachrichten | – / – |
| Lesebestätigungen | – | Direktnachrichten | – (Lesestand wird an Teams gemeldet) |
| Suche | ✓ | ✓ (Nextcloud-Suche) | ✓ (Microsoft Search) |
| Neue Unterhaltung | Direktnachricht, privater Kanal (im ersten Team) | Direktnachricht, Gruppe | Direktnachricht, Gruppenchat |

### Hinweise

- **Stummschalten und Anheften** gelten nur in Kuvert, der Dienst selbst bleibt unverändert.
- **Benachrichtigungen** (Hinweis, Desktop, Web Push) gibt es für Direktnachrichten immer, in Gruppen und Kanälen nur
  bei Erwähnung (`@Name`, `@all`/`@channel`/`@here`).
- Mitglieder, Namen und Beschreibungen werden im jeweiligen Dienst verwaltet; die Detailansicht zeigt sie an und
  verlinkt auf die Unterhaltung im Original.
- Mattermost-Reaktionen werden über Emoji-Namen abgebildet; eigene (Custom-)Emojis erscheinen als `:name:`.
- Teams liefert keine Ungelesen-Zähler: Beim Start zeigt Kuvert „1“ für ungelesene Chats, danach wird mitgezählt.
- Kuvert ruft die Dienste serverseitig auf – der Kuvert-Server muss Mattermost, Nextcloud bzw. Microsoft Graph erreichen können.
- Abschalten der Anbindungen für die ganze Instanz: `CHAT_BRIDGES=false`.
