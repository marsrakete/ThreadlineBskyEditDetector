"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

/** Prüft die Anzeige nach einem Erweiterungs-Reload ohne verfügbare Laufzeit-API. Keine Parameter. @returns {Promise<void>} Abschluss oder Assertion-Fehler. */
async function checkUnavailableRuntime() {
  const fields = new Map();
  const callbacks = {};
  const panel = {
    open: true,
    querySelector(selector) {
      if (!fields.has(selector)) {
        fields.set(selector, { textContent: "", hidden: true, addEventListener() {} });
      }
      return fields.get(selector);
    },
    addEventListener(name, callback) {
      callbacks[name] = callback;
    },
  };
  const context = vm.createContext({
    URL,
    Date,
    navigator: { onLine: true },
    localStorage: { getItem() {
      return JSON.stringify({ session: { currentAccount: { did: "did:plc:test", pdsUrl: "https://pds.example.com" } } });
    } },
    document: {
      hidden: false,
      createElement() {
        return { content: { firstElementChild: { cloneNode() { return panel; } } } };
      },
      documentElement: { appendChild() {} },
    },
    window: { addEventListener(name, callback) { callbacks[name] = callback; } },
    setInterval(callback) { callbacks.interval = callback; },
    BskyServerStatus: { label() { return "Betriebsbereit"; }, findServer() { return null; } },
  });
  const connectionPath = path.join(__dirname, "../bsky-edit-detector-extension/bsky-edit-detector-extension/connection.js");
  vm.runInContext(fs.readFileSync(connectionPath, "utf8"), context);
  callbacks.toggle();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(fields.get('[data-info="health"]').textContent, "PDS-Prüfung nicht verfügbar");
  assert.equal(fields.get('[data-info="server-status"]').textContent, "Status derzeit nicht abrufbar");
  console.log("PASS: Fehlende Erweiterungs-Laufzeit erzeugt im Content-Script keinen unbehandelten Fehler.");
}

checkUnavailableRuntime().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
