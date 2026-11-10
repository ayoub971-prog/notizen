# Notizen

Schlichte Notizen-App als installierbare Web-App (PWA) für Android/Samsung (Chrome).
Ordner und Unterordner, schnelle Volltextsuche, Editor mit Tabellen, Checklisten,
Fotos, Sprachmemos, PDF-Erstellung, Teilen und Sicherung in einen sichtbaren Ordner.

**Alles bleibt auf dem Gerät.** Kein Konto, keine Cloud, keine KI, keine Kosten,
keine fremden Server. Die App lädt nichts aus dem Internet (ausser sich selbst).

Die Bedienung ist an bekannte Notiz-Apps angelehnt (Liste → Notiz, gelber Akzent),
Name, Symbol und Gestaltung sind aber eigenständig.

---

## Für Ayoub: So benutzt du die App

1. Seite in **Chrome** öffnen → Menü ⋮ → **«Zum Startbildschirm hinzufügen» / «App installieren»**.
   Erst danach erscheint «Notizen» auch im Android-**Teilen-Menü**.
2. **Ordner**: unten «Neuer Ordner». Beim Ordner auf «⋯» tippen: Umbenennen, Unterordner, Verschieben, Löschen.
3. **Neue Notiz**: Stift-Symbol unten rechts. Die erste Zeile ist der Titel.
4. Werkzeugleiste unten: **Aa** (Titel, Überschrift, Fett, Kursiv, Unterstrichen, Farben, Grösse, Listen),
   **Checkliste**, **Tabelle**, **Kamera/Galerie/Scan**, **Mikrofon** (Sprachmemo), **Büroklammer** (Datei), **Rückgängig**.
   In einer Tabelle erscheinen «+ Zeile», «+ Spalte», «− Zeile», «− Spalte».
5. **Einfügen/Teilen**: Bei jedem Einfügen (Text, Webseite, Bild, Datei) fragt die App:
   «Möchtest du den Inhalt als Original (bearbeitbar) oder als PDF speichern?»
6. **Senden**: Teilen-Symbol oben → «Als PDF senden», «Als Text senden», «.txt», oder «Drucken / als PDF sichern».
   Jeder Anhang hat eigene Knöpfe «Teilen» und «Herunterladen».
7. **Sicherung**: Schild-Symbol oben bei «Ordner» → «Ordner wählen …» (einmalig, z. B. *Dokumente → neuer Ordner «Notizen»*).
   Zusätzlich jederzeit «ZIP herunterladen» oder «ZIP teilen» (z. B. nach Google Drive).
8. Gelöschte Notizen liegen 30 Tage in «Zuletzt gelöscht».

---

## Datensicherheit – was wirklich passiert (ehrlich)

| Speicherort | Wofür | Sichtbar im Datei-Manager? | Übersteht App-Löschen? |
|---|---|---|---|
| IndexedDB im Browser | Hauptspeicher (schnell, offline) | nein | **nein** (wird mit den Website-Daten gelöscht) |
| **Gewählter Sicherungsordner** (z. B. Dokumente/Notizen) | automatische Kopie jeder Notiz als `.html` + `.txt` + Anhänge, Ordnerstruktur wie in der App | **ja** | **ja** |
| ZIP-Sicherung (Downloads / Google Drive) | vollständige Sicherung, auch zum Wiederherstellen | ja | ja |

**Automatische Ordner-Sicherung:** Chrome für Android unterstützt seit Version 132 (Januar 2025)
`showDirectoryPicker()` (File System Access API). Die App fragt **einmal** nach einem Ordner und schreibt danach
bei jeder Änderung (ca. 1,5 s nach dem Tippen) nur die geänderten Notizen neu. Umbenennen/Verschieben entfernt die alten
Dateien; endgültig gelöschte Notizen werden dort auch entfernt; Notizen im Papierkorb liegen im Unterordner «Zuletzt gelöscht».

Einschränkungen, die der Browser vorgibt:
- Chrome kann die Erlaubnis nach einem Neustart wieder entziehen. Dann zeigt die App oben
  «Ordner-Sicherung pausiert – Fortsetzen». **Ein Tippen** genügt; Änderungen sind in der Zwischenzeit
  sicher in der App gespeichert und werden danach nachgeschrieben.
- Android erlaubt keine Systemordner wie «Download» oder den Hauptspeicher direkt – bitte einen Unterordner wählen
  (z. B. *Dokumente/Notizen*).
- Falls der Browser `showDirectoryPicker` nicht kennt (ältere Chrome-Version, Firefox, Samsung Internet alt),
  sagt die App das klar und bietet nur die ZIP-Sicherung an. Dann erinnert ein Hinweis nach 7 Tagen ohne Sicherung.
- Die App fordert «dauerhaften Speicher» an (`navigator.storage.persist()`), damit Chrome die Daten nicht bei
  Speichermangel löscht. Bei installierten Apps gewährt Chrome das normalerweise.

**Wiederherstellen:** Sicherung → «Aus ZIP wiederherstellen». Vorhandene Notizen bleiben, gleiche Notizen werden
mit dem Stand der Sicherung überschrieben. (Aus dem Sicherungsordner kann man alles lesen, aber nicht automatisch
zurückspielen – dafür ist die ZIP-Sicherung da.)

### Recherche (Stand November 2026)
- Chrome 132 bringt die File System Access API auf Android: https://developer.chrome.com/blog/new-in-chrome-132
- MDN `showDirectoryPicker()` (Optionen `id`, `mode: "readwrite"`, `startIn`; braucht Benutzer-Tippen):
  https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker
- Unterstützung: Chrome Android 132, nicht Firefox/Safari:
  https://web-platform-dx.github.io/web-features-explorer/features/file-system-access/ · https://caniuse.com/native-filesystem-api
- Dauerhafte Ordner-Erlaubnis («Bei jedem Besuch erlauben», installierte Desktop-PWAs automatisch) ab Chrome 122;
  für Android ist das nicht ausdrücklich dokumentiert → App rechnet mit erneuter Abfrage:
  https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api
- Origin Private File System ist **nicht** im Datei-Manager sichtbar, daher nicht als Sicherung verwendet:
  https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
- Teilen-Menü-Ziel (Web Share Target, POST + Service Worker; Android schickt Links oft im Feld «text»):
  https://developer.chrome.com/docs/capabilities/web-apis/web-share-target
- Teilen von Dateien: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share
- Dauerhafter Speicher: https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist

---

## Was die Einfüge-Abfrage macht

| Inhalt | «Original (bearbeitbar)» | «Als PDF» |
|---|---|---|
| Text | bearbeitbarer Text, Links klickbar | PDF mit Text |
| Webseite (kopierter Inhalt) | bereinigtes HTML (Überschriften, Fett, Listen, Tabellen) | PDF mit Formatierung und Tabellen |
| Link (geteilt) | Link | PDF mit Titel + Link (die Webseite selbst wird **nicht** heruntergeladen – App ist offline) |
| Bild | Bild in der Notiz (max. 1600 px, JPEG) | PDF mit dem Bild, Vorschau in der Karte |
| .txt / .md | Text in der Notiz | PDF |
| .csv | bearbeitbare Tabelle | PDF mit Tabelle |
| PDF | Anhang | bleibt PDF |
| Word, Excel, Video, Audio … | Anhang (Original) | **nicht möglich** → klare Meldung, Original wird angehängt |

Eingefügtes HTML wird immer bereinigt: keine Skripte, keine Ereignis-Attribute, keine Formulare/iframes,
**externe Bilder werden nie geladen** (nur ein Link «[Bild]» bleibt), nur http(s)/mailto/tel-Links.
Text, der gerade in dieser App kopiert wurde, wird ohne Abfrage eingefügt (internes Kopieren ist kein Import).

## Suche
Sucht sofort in Titeln, Notiztext, Ordnernamen, Anhangsnamen und im **Text von Anhängen**, soweit lokal möglich:
PDFs, die die App selbst erzeugt hat (Quelltext wird mitgespeichert), Text- und CSV-Dateien.
Der Inhalt von **fremden PDFs** (z. B. eingescannte Rechnung) wird **nicht** durchsucht – nur ihr Dateiname.
Gross/klein, Akzente und ß/ss spielen keine Rolle («zurich» findet «Zürich»). 5000 Notizen: < 100 ms (Test).

## PDF
Eigener PDF-Generator (`js/pdf.js`, keine fremde Bibliothek): A4, Schrift Helvetica (in jedem PDF-Leser
eingebaut), Umlaute und « » – € … über WinAnsi-Kodierung, Überschriften, fett/kursiv/unterstrichen, Farben,
Listen und Checklisten, **Tabellen mit Linien** (Kopfzeile wird auf jeder Seite wiederholt), JPEG-Bilder,
Seitenzahlen. Zeichen ausserhalb von Westeuropa (z. B. Emojis, Arabisch, Chinesisch) erscheinen im PDF als «?».
Für perfekte Optik gibt es zusätzlich «Drucken / als PDF sichern» (Druckdialog von Chrome).

---

## Technik

- Reines HTML/CSS/JavaScript (ES-Module), **kein Build-Schritt, keine Abhängigkeiten, kein CDN**.
- Strenge Content-Security-Policy (`default-src 'self'`; Bilder/Audio nur `self`, `data:`, `blob:`).
- Offline per Service Worker (`sw.js`, Cache `notizen-v1`).

```
index.html            Oberfläche (3 Bereiche: Ordner, Notizen, Editor)
styles.css            Gestaltung inkl. Dunkelmodus und Druck
manifest.webmanifest  Installation + Teilen-Ziel (share_target)
sw.js                 Offline-Cache + Empfang geteilter Inhalte
js/app.js             Hauptprogramm: Ansichten, Speichern, Anhänge, Ordner, Sicherung
js/editor.js          Editor-Befehle (Format, Checkliste, Tabelle)
js/importer.js        Pflicht-Abfrage Original/PDF
js/share.js           Teilen, Herunterladen, Drucken
js/backup.js          Ordner-Sicherung + ZIP-Sicherung/Wiederherstellung
js/db.js              IndexedDB
js/search.js          Volltextsuche
js/tree.js            Ordnerlogik
js/blocks.js          HTML -> Blöcke (für PDF/Text)
js/pdf.js             PDF-Generator   (js/pdf-metrics.js: Zeichenbreiten, erzeugt mit tools/gen-metrics.py)
js/zip.js             ZIP schreiben/lesen
js/sanitize.js        HTML-Bereinigung (js/htmlparse.js: kleiner HTML-Parser)
js/sharetarget.js     Auswertung geteilter Inhalte, CSV
js/exportfmt.js       Dateinamen, lesbares HTML
js/media.js           Bilder verkleinern, Sprachaufnahme
js/ui.js              Dialoge, Hinweise
icons/                eigenes Symbol (SVG + PNG 192/512 + maskierbar; tools/gen-icons.py)
tests/                Unit-Tests (node) + Browser-Test (headless Chrome)
```

### Tests
```
node --test tests/*.test.mjs        # Unit-Tests: Suche, Bereinigung, PDF (inkl. pdftotext), ZIP, Ordner, Teilen
node tests/browser-smoke.mjs        # optional: echter Chrome (headless), Screenshots in /tmp/notizen-shots
python3 -m http.server 8080         # lokal starten, dann http://localhost:8080
```

### Neue Version veröffentlichen
1. Änderungen machen.
2. In `sw.js` `VERSION` erhöhen (z. B. `'2'`) und dort sowie in `index.html` / `manifest.webmanifest` `?v=1` → `?v=2`.
3. Alle Dateien gemeinsam hochladen (z. B. GitHub Pages). Die App lädt die neue Version beim nächsten Start.

### Hinweise für die Weiterentwicklung (z. B. mit Gemini oder ChatGPT)
- Datenmodell steht oben in `js/db.js`. Bei Schema-Änderungen `DB_VERSION` erhöhen und `onupgradeneeded` ergänzen.
- Neue Formatierungen: `editor.js` (Befehl), `sanitize.js` (erlauben!), `blocks.js` + `pdf.js` (PDF), `styles.css`.
- Alles, was eingefügt wird, muss durch `sanitizeHtml()` laufen.
- Nichts aus dem Internet nachladen – die CSP in `index.html` würde es ohnehin blockieren.

## Bekannte Grenzen
- Auf echtem Samsung-Gerät noch nicht getestet (nur Chrome headless mit simuliertem Handy, Test-Mikrofon).
- Ordner-Sicherung: Erlaubnis muss nach Browser-Neustart evtl. erneut bestätigt werden (ein Tippen).
- Text von fremden PDFs ist nicht durchsuchbar; Word/Excel können nicht in PDF umgewandelt werden.
- Sprachmemos werden als `.webm` (Opus) gespeichert; manche Apps (z. B. WhatsApp) spielen `.webm` evtl. nicht direkt ab.
- Einfügen über die Gboard-Zwischenablage-Leiste kann als normales Tippen ankommen – dann erscheint keine Abfrage.
  Über «Einfügen» im Text-Menü (langes Drücken) erscheint sie.
- «Rückgängig» deckt Text und Formatierung ab; Tabellen-Umbau und Anhänge sind teilweise nicht rückgängig zu machen.
- Sehr grosse Sicherungen (> 1–2 GB) können beim ZIP-Erstellen zu viel Arbeitsspeicher brauchen.

Lizenz: MIT (eigener Code). Zeichenbreiten der PDF-Standardschrift stammen aus den freien URW-Metriken (reine Zahlenwerte).
