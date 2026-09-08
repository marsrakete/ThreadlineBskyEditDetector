"use strict";

let statusCache = null;
let statusPending = null;
let lastAttempt = 0;
const healthCache = new Map();

/** Validiert einen öffentlichen HTTPS-PDS-Ursprung. @param {unknown} value Adresse. @returns {string|null} Ursprung oder null. */
function pdsOrigin(value) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(url.hostname) || /\.(localhost|local|internal|test|invalid)$/i.test(url.hostname)) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** Prüft den öffentlichen Health-Endpunkt ohne Anmeldung. @param {string} origin Validierter PDS-Ursprung. @returns {Promise<object>} Ergebnis mit Zeitpunkt, Dauer und optional Version. */
async function probePds(origin) {
  const started = Date.now();
  try {
    const response = await fetch(`${origin}/xrpc/_health`, {
      credentials: "omit", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      return { state: "error", text: `HTTP ${response.status}`, checkedAt: Date.now() };
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw error;
      }
      return { state: "error", text: "Erreichbar, aber keine gültige Health-Antwort", checkedAt: Date.now() };
    }
    if (typeof data?.version !== "string" || !data.version.trim()) {
      return { state: "error", text: "Erreichbar, aber Health-Format unbekannt", checkedAt: Date.now() };
    }
    return { state: "ok", text: "PDS erreichbar", version: data.version.slice(0, 100), duration: Date.now() - started, checkedAt: Date.now() };
  } catch (error) {
    let text = "Netzwerkfehler – Erreichbarkeit nicht bestätigt";
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      text = "Zeitüberschreitung nach 10 Sekunden";
    }
    return { state: "error", text, checkedAt: Date.now() };
  }
}

/** Prüft Berechtigung und bündelt PDS-Prüfungen pro Host für eine Minute. @param {unknown} address PDS-Adresse. @returns {Promise<object>} Health-Ergebnis oder fehlende Berechtigung. */
async function getPdsHealth(address) {
  const origin = pdsOrigin(address);
  if (!origin) {
    return { state: "error", text: "Keine unterstützte öffentliche PDS-Adresse", checkedAt: Date.now() };
  }
  const permitted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  if (!permitted) {
    return { state: "permission", text: "Zugriff auf diesen PDS freigeben" };
  }
  const cached = healthCache.get(origin);
  if (cached && Date.now() - cached.started < 60000) {
    return cached.task;
  }
  if (healthCache.size >= 32) {
    healthCache.delete(healthCache.keys().next().value);
  }
  const task = probePds(origin);
  healthCache.set(origin, { started: Date.now(), task });
  return task;
}

/** Lädt öffentliche Statusdaten ohne Cookies. @param {string} path Fester API-Pfad. @returns {Promise<object>} JSON-Daten; wirft bei HTTP- oder Formatfehlern. */
async function fetchStatus(path) {
  const response = await fetch(`https://status.bsky.app/${path}`, {
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/** Ruft Statusdaten ab und begrenzt auch Fehlversuche auf einmal pro Minute. Keine Parameter. @returns {Promise<object>} Snapshot oder expliziter Fehler ohne veralteten Gesundstatus. */
async function getStatus() {
  if (statusPending) {
    return statusPending;
  }
  if (statusCache && Date.now() - lastAttempt < 60000) {
    return statusCache;
  }
  lastAttempt = Date.now();
  statusPending = loadStatus();
  try {
    statusCache = await statusPending;
    return statusCache;
  } finally {
    statusPending = null;
  }
}

/** Lädt und validiert Gesamtstatus und Komponenten gemeinsam. Keine Parameter. @returns {Promise<object>} Zeitgestempelter Status oder Fehlermeldung. */
async function loadStatus() {
  try {
    const [summary, details] = await Promise.all([
      fetchStatus("summary.json"),
      fetchStatus("v3/components.json"),
    ]);
    if (typeof summary?.page?.status !== "string" || !Array.isArray(details?.components)) {
      throw new Error("Unbekanntes Statusformat");
    }
    return { ok: true, checkedAt: Date.now(), pageStatus: summary.page.status, components: details.components };
  } catch {
    return { ok: false, checkedAt: Date.now() };
  }
}

/** Prüft, ob eine Erweiterungsseite zu einer unterstützten Bluesky-Weboberfläche gehört. @param {string|undefined} pageUrl URL der sendenden Seite. @returns {boolean} Ob die Nachricht von einer freigegebenen Seite kommt. */
function isSupportedApplicationPage(pageUrl) {
  if (typeof pageUrl !== "string") {
    return false;
  }
  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host === "bsky.app") {
    return true;
  }
  if (host === "mu.social" || host.endsWith(".mu.social")) {
    return true;
  }
  if (host === "blacksky.app" || host.endsWith(".blacksky.app")) {
    return true;
  }
  return false;
}

/** Bearbeitet ausschließlich Statusanfragen aus eigenen Content-Scripts auf unterstützten Bluesky-Weboberflächen. @param {object} message Nachricht. @param {object} sender Absender. @param {Function} sendResponse Antwortkanal. @returns {boolean} Ob der asynchrone Antwortkanal offen bleibt. */
function onMessage(message, sender, sendResponse) {
  if (sender.id !== chrome.runtime.id || !isSupportedApplicationPage(sender.url)) {
    return false;
  }
  if (message?.type === "bsky-server-status") {
    getStatus().then(sendResponse);
    return true;
  }
  if (message?.type === "bsky-pds-health") {
    getPdsHealth(message.pds).then(sendResponse).catch(() => sendResponse({ state: "error", text: "PDS-Prüfung nicht verfügbar", checkedAt: Date.now() }));
    return true;
  }
  if (message?.type === "bsky-pds-permission") {
    const origin = pdsOrigin(message.pds);
    if (!origin) {
      return false;
    }
    chrome.tabs.create({ url: chrome.runtime.getURL(`permission.html?pds=${encodeURIComponent(origin)}`) }).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
}

chrome.runtime.onMessage.addListener(onMessage);
