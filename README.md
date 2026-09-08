# Threadline Bluesky Edit & PDS Status

Erkennt bearbeitete Bluesky-Posts von mu.social und zeigt Bearbeitungsdetails, Verbindungsinformationen sowie den direkten PDS-Status.

Projekt: <https://github.com/marsrakete/ThreadlineBskyEditDetector>

Privacy policy: [PRIVACY.md](PRIVACY.md)

Installation in Chrome/Edge:

- ZIP-Datei herunterladen
- ZIP entpacken
- Im Browser die URL chrome://extensions öffnen
- Entwicklermodus aktivieren
- „Entpackte Erweiterung laden“
- Den entpackten Ordner bsky-edit-detector-extension auswählen

## Build und Download

`powershell -ExecutionPolicy Bypass -File scripts/build-extension.ps1` prüft alle Erweiterungs-Skripte und erstellt danach ein installierbares ZIP unter `downloads/threadline-bsky-edit-detector-v<Version>.zip`. Die Version stammt aus der `manifest.json`.

Der Download-Ordner bleibt im Projekt erhalten; die erzeugten ZIP-Dateien werden nicht in Git aufgenommen. Nach einem erfolgreichen Build wird das ZIP mit derselben Versionsnummer ersetzt und alle älteren Erweiterungs-ZIPs werden gelöscht. Neuere ZIP-Versionen bleiben erhalten.

Version 0.3.0: Auf bsky.app gibt es unten rechts die zunächst zugeklappte Anzeige „Threadline · Verbindung“. Sie lässt sich auch per Tastatur öffnen und zeigt:

- Netzwerkstatus laut Browser, ausgewähltes Bluesky-Konto und DID.
- Gespeicherten PDS (`pdsUrl`) sowie den Anmeldedienst (`service`) separat. Der Anmeldedienst ist nicht zwingend der tatsächliche PDS; fehlt dessen Adresse, wird das ausdrücklich angezeigt.
- Den öffentlichen API-Endpunkt des Detectors sowie Ergebnis und Zeitpunkt der zuletzt abgeschlossenen Abfrage, einschließlich HTTP- und Netzwerkfehlern.

Die Kontoanzeige liest die vorhandene lokale Bluesky-Sitzung (`BSKY_STORAGE`) und aktualisiert sich geöffnet alle zwei Sekunden. Das interne Bluesky-Speicherformat kann sich ändern. Gespeicherte Kontodaten bestätigen keine gültige Anmeldung oder PDS-Erreichbarkeit. Es werden keine Tokens angezeigt, übertragen oder zusätzlich gespeichert. Die Erweiterung schreibt keine Sitzungsdaten. Der Aufklappzustand wird nicht dauerhaft gespeichert.

Version 0.4.0 ergänzt den öffentlichen Status von [status.bsky.app](https://status.bsky.app/). Beim Öffnen und danach höchstens einmal pro Minute bei sichtbarem Panel werden `summary.json` und `v3/components.json` über den Erweiterungs-Service-Worker abgerufen. Die neue Hostberechtigung gilt ausschließlich für `https://status.bsky.app/*`. Es werden weder Cookies noch Konto-/PDS-Daten an die Statusseite gesendet; die Serverzuordnung erfolgt lokal. Ergebnisse und Fehlversuche werden für eine Minute im Arbeitsspeicher des Workers zwischengespeichert, nicht dauerhaft gespeichert.

Ein PDS wird nur bei einem eindeutigen, vollständigen Hosttreffer im Komponentennamen oder einer als Adresse angegebenen Beschreibung zugeordnet. Die beim Einbau geprüfte Statusschnittstelle listet allgemeine Dienste, aber keine einzelnen PDS. Dann erscheint „PDS nicht einzeln gelistet“; der Gesamtstatus wird separat angezeigt und gilt nicht als Nachweis, dass der eigene PDS erreichbar ist. Fehlende PDS-Adressen, unbekannte Statuswerte und Abruffehler werden ausdrücklich angezeigt. Der Zeitpunkt bezeichnet den lokalen Abruf, keine direkte Servermessung. Kontowechsel werden gegen die bereits abgerufenen Komponenten neu zugeordnet.

Prüfung der Serverzuordnung und des Status-Workers: `node scripts/check-server-status.cjs`.

Version 0.5.0 ergänzt eine direkte Prüfung des gespeicherten PDS über `/xrpc/_health`. Bei geöffneter, sichtbarer Anzeige wird jeder PDS höchstens einmal pro Minute geprüft (10 Sekunden Timeout). Angezeigt werden Erreichbarkeit des Health-Endpunkts, Antwortzeit inklusive JSON-Antwort, Serverversion und Prüfzeitpunkt. HTTP-Fehler, Netzwerkfehler, Timeouts und ungültige Antworten werden getrennt ausgewiesen. Eine erfolgreiche Health-Antwort garantiert keine funktionierende Anmeldung oder vollständige Verfügbarkeit aller PDS-Funktionen. Fehlt die gespeicherte PDS-Adresse, findet keine Prüfung statt; der Anmeldedienst wird nicht ersatzweise geprüft.

Version 0.6.0 läuft auf `bsky.app`, `mu.social` und `blacksky.app` sowie deren Subdomains. Links im einheitlichen Pfad `/profile/<Handle>/post/<Post-ID>` werden auf allen drei Weboberflächen erkannt. Die direkte PDS-Prüfung kann die fest eingerichteten Server unter `*.host.bsky.network`, `*.mu.social` und `*.blacksky.app` erreichen; für andere PDS bleibt die gezielte Browserfreigabe erforderlich. Die Postdaten kommen weiterhin von `public.api.bsky.app`. Falls ein anderer Dienst dort nicht auffindbare Posts nutzt, kann die Erweiterung dessen Beiträge nicht erkennen, bis er über diesen öffentlichen Endpunkt verfügbar ist.

Die Erweiterung erhält zusätzlich Zugriff auf `https://*.host.bsky.network/*`. Bei anderen öffentlichen HTTPS-PDS öffnet „PDS-Prüfung freigeben“ eine Erweiterungsseite, auf der genau dieser Server über den Browser freigegeben werden kann. Die optionale HTTPS-Hostberechtigung erteilt keinen pauschalen Zugriff auf alle Websites. Eine erteilte Serverfreigabe wird vom Browser dauerhaft gespeichert und kann in den Erweiterungseinstellungen entzogen werden. An den PDS gehen keine Cookies, Tokens oder Kontoangaben; angefragt wird nur der feste Health-Pfad. Weiterleitungen werden nicht verfolgt. Ergebnisse liegen nur im Arbeitsspeicher. Alte Antworten werden bei Kontowechseln nicht auf den neuen PDS übertragen.

Prüfung des Health-Workers: `node scripts/check-pds-health.cjs`.

Nach einem Update die Erweiterung unter `chrome://extensions` bzw. `edge://extensions` neu laden und den Bluesky-Tab aktualisieren. Beim Laden des Quellordners den inneren Ordner mit `manifest.json` auswählen.
