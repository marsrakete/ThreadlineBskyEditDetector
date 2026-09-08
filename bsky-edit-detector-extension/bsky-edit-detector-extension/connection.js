/** Initialisiert die Verbindungsanzeige ohne Parameter; liefert die API zur Abfragestatusanzeige. */
const BskyEditDetectorConnection = (() => {
  "use strict";

  const template = document.createElement("template");
  template.id = "bsky-edit-detector-connection-template";
  template.innerHTML = `
    <details class="bsky-edit-detector-connection">
      <summary>Threadline · Verbindung</summary>
      <div class="bsky-edit-detector-connection-body">
        <dl>
          <dt>Browser-Netzwerk</dt><dd data-info="network"></dd>
          <dt>Bluesky-Konto</dt><dd data-info="account"></dd>
          <dt>DID</dt><dd data-info="did"></dd>
          <dt>PDS (gespeichert)</dt><dd data-info="pds"></dd>
          <dt>PDS direkt geprüft</dt><dd data-info="health">Wird beim Aufklappen geprüft</dd>
          <dt>Antwortzeit / Version</dt><dd data-info="health-details">–</dd>
          <dt>PDS-Prüfung</dt><dd data-info="health-time">–</dd>
          <dt>Anmeldedienst</dt><dd data-info="service"></dd>
          <dt>PDS laut Statusseite</dt><dd data-info="server-status">Wird beim Aufklappen geladen</dd>
          <dt>Bluesky gesamt</dt><dd data-info="overall-status">Noch nicht abgerufen</dd>
          <dt>Status abgerufen</dt><dd data-info="status-time">–</dd>
          <dt>Detector-API</dt><dd>https://public.api.bsky.app/xrpc</dd>
          <dt>Letzte API-Abfrage</dt><dd data-info="request">Noch keine Abfrage</dd>
          <dt>Zeitpunkt</dt><dd data-info="time">–</dd>
        </dl>
        <button type="button" data-action="allow-pds" hidden>PDS-Prüfung freigeben</button>
        <p>Die direkte Prüfung bestätigt die Antwort des Health-Endpunkts, nicht sämtliche Serverfunktionen.</p>
        <p><a href="https://status.bsky.app/" target="_blank" rel="noopener noreferrer">Bluesky-Statusseite öffnen</a></p>
        <p>Der Detector fragt öffentlich ohne eigene Anmeldung ab. Kontodaten stammen aus der lokal gespeicherten Bluesky-Sitzung; sie bestätigen keine gültige Anmeldung oder PDS-Erreichbarkeit.</p>
      </div>
    </details>`;
  const panel = template.content.firstElementChild.cloneNode(true);
  document.documentElement.appendChild(panel);
  let statusSnapshot = null;
  let statusLoading = false;
  let lastStatusAttempt = 0;
  let healthPds = "";
  let healthGeneration = 0;
  let healthLoading = false;
  let lastHealthAttempt = 0;
  const allowPds = panel.querySelector('[data-action="allow-pds"]');

  /** Setzt ein Feld nur bei Änderung. @param {string} key Feldname. @param {string} value Text. @returns {void} */
  function setField(key, value) {
    const field = panel.querySelector(`[data-info="${key}"]`);
    if (field.textContent !== value) {
      field.textContent = value;
    }
  }

  /** Sendet eine Nachricht nur bei verfügbarer Erweiterungs-Laufzeit. @param {object} message Nachricht für den Service Worker. @returns {Promise<object|null>} Antwort des Service Workers oder null nach einem Erweiterungs-Reload. */
  async function sendRuntimeMessage(message) {
    const extensionChrome = globalThis.chrome;
    if (!extensionChrome || !extensionChrome.runtime || typeof extensionChrome.runtime.sendMessage !== "function") {
      return null;
    }
    try {
      return await extensionChrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }

  /** Bereinigt eine Serveradresse. @param {unknown} value Adresse. @returns {string} HTTPS-Ursprung oder Platzhalter. */
  function serverOrigin(value) {
    if (typeof value !== "string") {
      return "Nicht verfügbar";
    }
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password) {
        return url.origin;
      }
    } catch {
      // Unbekannte Speicherformate werden nicht als Serveradresse ausgegeben.
    }
    return "Nicht verfügbar";
  }

  /** Liest nur freigegebene Anzeigefelder der aktuellen Sitzung. Keine Parameter. @returns {object} Status, Handle, DID und Server ohne Tokens. */
  function readAccount() {
    const result = { account: "Kein ausgewähltes Konto erkennbar", did: "–", pds: "Nicht verfügbar", service: "Nicht verfügbar" };
    try {
      const raw = localStorage.getItem("BSKY_STORAGE");
      if (!raw) {
        return result;
      }
      const session = JSON.parse(raw)?.session;
      const current = session?.currentAccount;
      if (!current) {
        return result;
      }
      if (typeof current.did !== "string" || !current.did.startsWith("did:")) {
        result.account = "Sitzungsformat nicht erkannt";
        return result;
      }
      let account = current;
      if (Array.isArray(session.accounts)) {
        for (const candidate of session.accounts) {
          if (candidate?.did === current.did) {
            account = candidate;
            break;
          }
        }
      }
      result.account = "Konto lokal ausgewählt";
      if (typeof account.handle === "string" && account.handle) {
        result.account = `@${account.handle}`;
      }
      result.did = current.did;
      result.pds = serverOrigin(account.pdsUrl);
      result.service = serverOrigin(account.service);
      if (result.pds === "Nicht verfügbar") {
        result.pds = "Nicht separat gespeichert";
      }
    } catch {
      result.account = "Sitzungsdaten nicht lesbar";
    }
    return result;
  }

  /** Aktualisiert Netzwerk und lokale Kontoanzeige. Keine Parameter. @returns {void} */
  function refresh() {
    if (navigator.onLine) {
      setField("network", "Online laut Browser");
    } else {
      setField("network", "Offline laut Browser");
    }
    const account = readAccount();
    for (const key of ["account", "did", "pds", "service"]) {
      setField(key, account[key]);
    }
    renderServerStatus(account.pds);
    if (healthPds !== account.pds) {
      healthPds = account.pds;
      healthGeneration++;
      healthLoading = false;
      lastHealthAttempt = 0;
      allowPds.hidden = true;
      setField("health-details", "–");
      setField("health-time", "–");
      if (healthPds.startsWith("https://")) {
        setField("health", "Noch nicht geprüft");
      } else {
        setField("health", "Keine gespeicherte PDS-Adresse verfügbar");
      }
    }
  }

  /** Prüft den aktuellen PDS und verwirft Antworten nach einem Kontowechsel. Keine Parameter. @returns {Promise<void>} Abschluss der Anzeigeaktualisierung. */
  async function refreshPdsHealth() {
    if (!healthPds.startsWith("https://") || healthLoading || Date.now() - lastHealthAttempt < 60000) {
      return;
    }
    const generation = healthGeneration;
    healthLoading = true;
    lastHealthAttempt = Date.now();
    setField("health", "PDS wird geprüft …");
    setField("health-details", "–");
    allowPds.hidden = true;
    try {
      const result = await sendRuntimeMessage({ type: "bsky-pds-health", pds: healthPds });
      // Vor dem Rendern den aktuellen Kontospeicher erneut lesen.
      refresh();
      if (generation !== healthGeneration) {
        return;
      }
      if (!result || typeof result.text !== "string") {
        throw new Error("Keine Health-Antwort");
      }
      setField("health", result.text);
      if (result.state === "ok") {
        setField("health-details", `${result.duration} ms · Version ${result.version}`);
      }
      if (Number.isFinite(result.checkedAt)) {
        setField("health-time", new Date(result.checkedAt).toLocaleString());
      } else {
        setField("health-time", "–");
      }
      if (result.state === "permission") {
        allowPds.hidden = false;
      }
    } catch {
      if (generation === healthGeneration) {
        setField("health", "PDS-Prüfung nicht verfügbar");
        setField("health-time", new Date().toLocaleString());
      }
    } finally {
      if (generation === healthGeneration) {
        healthLoading = false;
      }
    }
  }

  /** Öffnet die Erweiterungsseite zur Freigabe genau dieses PDS. Keine Parameter. @returns {Promise<void>} Abschluss des Öffnens. */
  async function openPdsPermission() {
    refresh();
    try {
      const result = await sendRuntimeMessage({ type: "bsky-pds-permission", pds: healthPds });
      if (!result?.ok) {
        throw new Error("Freigabe nicht geöffnet");
      }
      lastHealthAttempt = 0;
    } catch {
      setField("health", "Freigabe konnte nicht geöffnet werden – Erweiterung neu laden");
    }
  }

  /** Zeigt Statusdaten passend zum derzeitigen PDS. @param {string} pds Aktuelle gespeicherte Adresse. @returns {void} */
  function renderServerStatus(pds) {
    if (!statusSnapshot) {
      return;
    }
    setField("status-time", new Date(statusSnapshot.checkedAt).toLocaleString());
    if (!statusSnapshot.ok) {
      setField("server-status", "Status derzeit nicht abrufbar");
      setField("overall-status", "Status derzeit nicht abrufbar");
      return;
    }
    setField("overall-status", BskyServerStatus.label(statusSnapshot.pageStatus));
    if (!pds.startsWith("https://")) {
      setField("server-status", "Keine gespeicherte PDS-Adresse verfügbar");
      return;
    }
    const component = BskyServerStatus.findServer(statusSnapshot.components, pds);
    if (component) {
      setField("server-status", BskyServerStatus.label(component.status));
    } else {
      setField("server-status", "PDS nicht einzeln gelistet – kein Serverstatus verfügbar");
    }
  }

  /** Lädt öffentliche Statusdaten höchstens einmal pro Minute bei geöffnetem Panel. Keine Parameter. @returns {Promise<void>} Abschluss der Aktualisierung. */
  async function refreshServerStatus() {
    if (statusLoading || Date.now() - lastStatusAttempt < 60000) {
      return;
    }
    statusLoading = true;
    lastStatusAttempt = Date.now();
    setField("server-status", "Status wird abgerufen …");
    try {
      const snapshot = await sendRuntimeMessage({ type: "bsky-server-status" });
      if (!snapshot || typeof snapshot.ok !== "boolean" || !Number.isFinite(snapshot.checkedAt)) {
        throw new Error("Keine Statusantwort");
      }
      statusSnapshot = snapshot;
    } catch {
      statusSnapshot = { ok: false, checkedAt: Date.now() };
    } finally {
      statusLoading = false;
      refresh();
    }
  }

  /** Aktualisiert nur die geöffnete, sichtbare Anzeige. Keine Parameter. @returns {void} */
  function refreshIfVisible() {
    if (panel.open && !document.hidden) {
      refresh();
      void refreshServerStatus();
      void refreshPdsHealth();
    }
  }

  /** Meldet eine abgeschlossene API-Abfrage. @param {string} method XRPC-Methode. @param {string} status Ergebnis ohne Antwortdaten. @returns {void} */
  function reportRequest(method, status) {
    setField("request", `${method}: ${status}`);
    setField("time", new Date().toLocaleTimeString());
  }

  panel.addEventListener("toggle", refreshIfVisible);
  allowPds.addEventListener("click", openPdsPermission);
  window.addEventListener("online", refresh);
  window.addEventListener("offline", refresh);
  window.addEventListener("storage", refreshIfVisible);
  window.addEventListener("focus", refreshIfVisible);
  // Storage-Ereignisse fehlen bei Kontowechseln im selben Tab.
  setInterval(refreshIfVisible, 2000);
  refresh();
  return { reportRequest };
})();
