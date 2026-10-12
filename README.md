# Threadline Bluesky Edit & PDS Status

Diese Browser-Erweiterung zeigt bearbeitete Bluesky-Posts von mu.social an und macht die aktuelle Bluesky-Verbindung einschließlich des verwendeten PDS sichtbar.

Projekt: <https://github.com/marsrakete/ThreadlineBskyEditDetector>

Datenschutzerklärung: [PRIVACY.md](PRIVACY.md)

## Installation in Chrome und Edge

1. Die ZIP-Datei herunterladen und entpacken.
2. `chrome://extensions` beziehungsweise `edge://extensions` öffnen.
3. Den Entwicklermodus aktivieren.
4. „Entpackte Erweiterung laden“ wählen.
5. Den entpackten Ordner `bsky-edit-detector-extension` auswählen.

Nach einem Update der Erweiterung muss sie auf der Erweiterungsseite neu geladen und der offene Bluesky-Tab aktualisiert werden.

## Was die Erweiterung macht

- Sie erkennt bei Posts, deren öffentliche Daten die Felder `originalText` und `updatedAt` enthalten, dass sie bearbeitet wurden. Die ursprüngliche und die aktuelle Fassung lassen sich vergleichen.
- Unten rechts befindet sich die auf- und zuklappbare Anzeige „Threadline · Verbindung“. Sie zeigt den Netzwerkstatus des Browsers, das gewählte Konto, Handle und DID sowie den gespeicherten PDS und Anmeldedienst.
- Die Anzeige informiert über den letzten Abruf der öffentlichen Bluesky-API und über den allgemeinen Status von [status.bsky.app](https://status.bsky.app/).
- Sie prüft den gespeicherten PDS direkt über den festen Endpunkt `/xrpc/_health`. Angezeigt werden Erreichbarkeit, Antwortzeit, Serverversion und gegebenenfalls ein HTTP-, Netzwerk- oder Timeout-Fehler.
- Eine sichtbare, geöffnete Anzeige ruft Status- und PDS-Informationen höchstens einmal pro Minute erneut ab.

Die Erweiterung unterstützt Postseiten im Format `/profile/<Handle>/post/<Post-ID>` auf folgenden Weboberflächen:

- `bsky.app`
- `mu.social` und deren Subdomains
- `blacksky.app` und deren Subdomains
- `portal.eurosky.tech`
- `eurosky.social` und deren Subdomains

Die Postdaten werden über `public.api.bsky.app` abgerufen. Ein Post kann deshalb nur erkannt werden, wenn diese öffentliche API ihn bereitstellt.

## Grenzen der Statusanzeige

Eine erfolgreiche PDS-Prüfung bestätigt nur, dass der Health-Endpunkt erreichbar ist. Sie bestätigt weder eine gültige Anmeldung noch die vollständige Verfügbarkeit aller PDS-Funktionen.

`status.bsky.app` liefert einen allgemeinen Dienstestatus. Ein eigener PDS wird dort nur angezeigt, wenn er eindeutig einem Eintrag zugeordnet werden kann. Fehlt ein solcher Eintrag, steht dort „PDS nicht einzeln gelistet“; der allgemeine Status ist dann kein Nachweis für die Erreichbarkeit des eigenen PDS.

Die Konto- und PDS-Anzeige liest die vorhandenen lokalen Bluesky-Sitzungsdaten (`BSKY_STORAGE`). Dieses interne Speicherformat kann sich ändern. Die gefundenen Werte zeigen eine gespeicherte Sitzung, keine bestätigte aktive Anmeldung.

`eurosky.app` ist nicht enthalten, weil keine bestätigte Zuordnung zur Eurosky-Weboberfläche oder zu einem Eurosky-PDS vorliegt.

## Datenschutz und PDS-Berechtigungen

Die Erweiterung zeigt, überträgt und speichert keine Zugangstokens. Sie schreibt keine Bluesky-Sitzungsdaten. Abfragen an die öffentliche API, `status.bsky.app` und den Health-Endpunkt eines PDS enthalten keine Cookies, Tokens oder Kontodaten. Statusantworten werden nur vorübergehend im Arbeitsspeicher gehalten.

PDS unter `*.host.bsky.network`, `*.mu.social`, `*.blacksky.app` und `*.eurosky.social` können direkt geprüft werden. Für einen anderen öffentlichen HTTPS-PDS öffnet „PDS-Prüfung freigeben“ eine Browserseite, auf der genau dieser Server freigegeben werden kann. Diese Freigabe kann jederzeit in den Erweiterungseinstellungen entfernt werden.

## Build und Download

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-extension.ps1
```

Das Build-Skript prüft die Erweiterungs-Skripte und erzeugt anschließend ein installierbares ZIP unter `downloads/threadline-bsky-edit-detector-v<Version>.zip`. Die Version stammt aus der `manifest.json`.

Die ZIP-Dateien werden nicht in Git aufgenommen. Nach einem erfolgreichen Build ersetzt das Skript ein ZIP derselben Versionsnummer, löscht ältere Erweiterungs-ZIPs und behält neuere Versionen.
