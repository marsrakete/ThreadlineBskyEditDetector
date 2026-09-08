"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

/** Prüft Health-Ergebnisse, Adressvalidierung, Berechtigungen und Cache ohne Netzwerk. Keine Parameter. @returns {Promise<void>} Abschluss oder Assertion-Fehler. */
async function check() {
  let now = 100000;
  let calls = 0;
  let permitted = true;
  let mode = "ok";
  const context = vm.createContext({ URL, AbortSignal,
    Date: { now() { return now; } },
    chrome: { runtime: { onMessage: { addListener() {} } }, permissions: { async contains() { return permitted; } } },
    async fetch(url, options) {
      calls++;
      assert.equal(url, "https://pds.example.com/xrpc/_health");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      if (mode === "timeout") {
        const error = new Error("timeout");
        error.name = "TimeoutError";
        throw error;
      }
      if (mode === "network") {
        throw new TypeError("fetch failed");
      }
      return { ok: mode !== "http", status: 503, async json() {
        if (mode === "json") {
          throw new SyntaxError("invalid");
        }
        if (mode === "format") {
          return {};
        }
        return { version: "0.4.1" };
      } };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../bsky-edit-detector-extension/bsky-edit-detector-extension/background.js"), "utf8"), context);
  for (const address of ["http://pds.example.com", "https://127.0.0.1", "https://localhost", "https://foo.local", "https://user:pass@pds.example.com", "https://pds.example.com/path", "https://pds.example.com?token=x"]) {
    context.address = address;
    assert.equal(vm.runInContext("pdsOrigin(address)", context), null);
  }
  const run = () => vm.runInContext('getPdsHealth("https://pds.example.com")', context);
  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first.state, "ok");
  assert.equal(first.version, "0.4.1");
  assert.equal(second.state, "ok");
  assert.equal(calls, 1);
  permitted = false;
  assert.equal((await run()).state, "permission");
  assert.equal(calls, 1);
  permitted = true;
  for (const failure of ["http", "timeout", "network", "json", "format"]) {
    mode = failure;
    now += 61000;
    const result = await run();
    assert.equal(result.state, "error");
    assert.equal(result.version, undefined);
    if (failure === "http") assert.equal(result.text, "HTTP 503");
    if (failure === "timeout") assert.match(result.text, /10 Sekunden/);
    const before = calls;
    await run();
    assert.equal(calls, before);
  }
  now += 61000;
  mode = "ok";
  assert.equal((await run()).state, "ok");
  console.log("PASS: Health-Erfolg, Version, Hostvalidierung, Berechtigung, Cache, HTTP, Timeout, Netzwerk, JSON und Wiederherstellung.");
}

check().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
