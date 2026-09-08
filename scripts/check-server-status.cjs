"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "../bsky-edit-detector-extension/bsky-edit-detector-extension");
const helpers = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(path.join(root, "server-status.js"), "utf8"), helpers);
const api = vm.runInContext("BskyServerStatus", helpers);
const pds = "https://inkcap.us-east.host.bsky.network";
const server = { id: "pds", name: "PDS", description: pds, status: "PARTIALOUTAGE" };
assert.equal(api.findServer([{ children: [server] }], pds), server);
assert.equal(api.findServer([server], `${pds}.evil.example`), null);
assert.equal(api.findServer([{ name: "inkcap", status: "OPERATIONAL" }], pds), null);
assert.equal(api.findServer([server, { ...server, id: "duplicate" }], pds), null);
assert.equal(api.findServer([server], "Nicht separat gespeichert"), null);
assert.equal(api.findServer([{ name: "Website and App", status: "OPERATIONAL" }], pds), null);
assert.equal(api.label("PARTIALOUTAGE"), "Teilweiser Ausfall");
assert.equal(api.label("UNKNOWN"), "Unbekannter Status");
assert.equal(api.label("toString"), "Unbekannter Status");

/** Prüft Worker-Abfragen, Cache und Fehler ohne Netzwerk. Keine Parameter. @returns {Promise<void>} Erfolgreicher Abschluss oder Assertion-Fehler. */
async function checkWorker() {
  let now = 100000;
  let calls = 0;
  let fail = false;
  let listener;
  const worker = vm.createContext({
    Date: { now() { return now; } },
    AbortSignal,
    chrome: { runtime: { id: "test", onMessage: { addListener(callback) { listener = callback; } } } },
    async fetch(url, options) {
      calls++;
      assert.equal(options.credentials, "omit");
      assert.ok(url.startsWith("https://status.bsky.app/"));
      assert.equal(options.redirect, "error");
      if (fail) {
        throw new Error("offline");
      }
      return { ok: true, async json() {
        if (url.endsWith("v3/components.json")) {
          return { components: [server] };
        }
        return { page: { status: "UP" } };
      } };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), worker);
  const [first, second] = await Promise.all([
    vm.runInContext("getStatus()", worker),
    vm.runInContext("getStatus()", worker),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.checkedAt, first.checkedAt);
  assert.equal(calls, 2);
  await vm.runInContext("getStatus()", worker);
  assert.equal(calls, 2);
  now += 61000;
  fail = true;
  const failure = await vm.runInContext("getStatus()", worker);
  assert.equal(failure.ok, false);
  assert.equal(failure.pageStatus, undefined);
  await vm.runInContext("getStatus()", worker);
  assert.equal(calls, 4);
  assert.equal(listener({ type: "bsky-server-status" }, { id: "other", url: "https://bsky.app/" }, () => {}), false);
  now += 61000;
  fail = false;
  const recovered = await vm.runInContext("getStatus()", worker);
  assert.equal(recovered.ok, true);
  console.log("PASS: Exakte PDS-Zuordnung, Gruppen, Mehrdeutigkeit, Statuswerte, Anfragebündelung, Cache, Fehler und Wiederherstellung.");
}

checkWorker().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
