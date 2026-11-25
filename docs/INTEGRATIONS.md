# Integrationen: mailcow, Mail-Archiver, Mattermost, Nextcloud Talk & Teams

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
