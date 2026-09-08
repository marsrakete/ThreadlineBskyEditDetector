/** Stellt reine Helfer für Serverzuordnung bereit. Keine Parameter. @returns {object} Statusformatierung und exakter Hostvergleich. */
const BskyServerStatus = (() => {
  "use strict";

  /** Übersetzt bekannte Statuswerte. @param {string} status API-Status. @returns {string} Deutscher Status, unbekannte Werte bleiben ausdrücklich unbekannt. */
  function label(status) {
    const labels = {
      UP: "Alle Systeme betriebsbereit",
      HASISSUES: "Störung gemeldet",
      OPERATIONAL: "Betriebsbereit",
      UNDERMAINTENANCE: "Wartung",
      DEGRADEDPERFORMANCE: "Eingeschränkte Leistung",
      PARTIALOUTAGE: "Teilweiser Ausfall",
      MINOROUTAGE: "Kleinere Störung",
      MAJOROUTAGE: "Schwerer Ausfall",
    };
    if (Object.hasOwn(labels, status)) {
      return labels[status];
    }
    return "Unbekannter Status";
  }

  /** Extrahiert einen vollständigen Host aus einer URL oder einem Hostnamen. @param {unknown} value Einzelner Wert. @returns {string} Normalisierter Host oder leerer String. */
  function hostname(value) {
    if (typeof value !== "string" || !value.trim() || /\s/.test(value.trim())) {
      return "";
    }
    let address = value.trim();
    if (!address.includes("://")) {
      address = `https://${address}`;
    }
    try {
      const url = new URL(address);
      if (url.protocol === "https:" && !url.username && !url.password) {
        return url.hostname.toLowerCase().replace(/\.$/, "");
      }
    } catch {
      // Beschreibungen ohne eindeutige Adresse liefern keinen Treffer.
    }
    return "";
  }

  /** Sucht den PDS ausschließlich über vollständige Hosts, auch in Gruppen. @param {Array<object>} components Komponenten. @param {string} pds HTTPS-PDS-Adresse. @returns {object|null} Eindeutiger Treffer oder null. */
  function findServer(components, pds) {
    if (!pds.startsWith("https://")) {
      return null;
    }
    const host = hostname(pds);
    if (!host) {
      return null;
    }
    const matches = new Map();
    const queue = [...components];
    while (queue.length > 0) {
      const component = queue.shift();
      if (!component || typeof component !== "object") {
        continue;
      }
      if (Array.isArray(component.children)) {
        queue.push(...component.children);
      }
      if (hostname(component.name) === host || hostname(component.description) === host) {
        matches.set(component.id || component, component);
      }
    }
    if (matches.size === 1) {
      return matches.values().next().value;
    }
    return null;
  }

  return { label, findServer };
})();
